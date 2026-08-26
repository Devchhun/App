"""Local AI worker for the Creative AI Editor.

Communicates with the Electron main process over stdio using newline-delimited
JSON. Never touches the network except to fetch Whisper model weights from
Hugging Face when explicitly asked to (fully local by default: no video or
audio is ever uploaded anywhere).

Protocol
--------
Node -> Python (one JSON object per line on stdin):
    {"id": "<uuid>", "cmd": "<command>", "args": {...}}
    {"id": "<uuid>", "cmd": "control", "args": {"action": "pause"|"resume"|"cancel"}}

Python -> Node (one JSON object per line on stdout):
    {"id": "<uuid>", "type": "ready"|"progress"|"result"|"error", ...}
"""

import sys
import os
import io
import re
import json
import time
import difflib
import threading
import queue
import traceback
import subprocess
import tempfile

# The embeddable/portable Python distribution (unlike a normal install) does
# not automatically add the running script's own directory to sys.path, so
# a sibling-module import like `gpu_support` would otherwise fail there even
# though it works fine under a regular venv.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gpu_support

# Force UTF-8 everywhere, including on Windows consoles, and make sure Khmer
# text is never mangled by a mis-detected code page.
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', errors='replace', newline='\n')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', newline='\n')

STDOUT_LOCK = threading.Lock()


def emit(msg_id, msg_type, **fields):
    payload = {'id': msg_id, 'type': msg_type, **fields}
    with STDOUT_LOCK:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
        sys.stdout.flush()


class WorkerCanceled(Exception):
    pass


# --- Cooperative pause / cancel control -------------------------------------------------

pause_event = threading.Event()
cancel_flags = set()
active_job_id_lock = threading.Lock()
active_job_id = [None]  # boxed for mutability across threads


def set_active_job(job_id):
    with active_job_id_lock:
        active_job_id[0] = job_id


# Transcription jobs run in a dedicated child process (see cmd_transcribe);
# this tracks the currently active one(s) so control messages (pause/resume/
# cancel) can be relayed to them.
active_transcribe_procs = {}


# --- Model catalog ------------------------------------------------------------------------

MODEL_OPTIONS = [
    {'id': 'tiny', 'label': 'Tiny', 'approxSizeMb': 75},
    {'id': 'base', 'label': 'Base', 'approxSizeMb': 145},
    {'id': 'small', 'label': 'Small', 'approxSizeMb': 484},
    {'id': 'medium', 'label': 'Medium', 'approxSizeMb': 1530},
    {'id': 'large-v3', 'label': 'Large v3', 'approxSizeMb': 3100},
]


def repo_id_for(model_id):
    return f'Systran/faster-whisper-{model_id}'


def is_model_downloaded(model_id, download_root):
    """True only if the actual CTranslate2 weights file (model.bin) is
    present, unbroken, and non-trivially sized in the local snapshot.

    snapshot_download(local_files_only=True) succeeding is NOT sufficient on
    its own -- it was observed to return success even when model.bin itself
    was left as a partial .incomplete download after a network interruption
    (the small metadata files had downloaded fine, so a snapshot directory
    existed, but the actual weights were never placed). That silently
    reported an unusable model as "ready" in the UI.
    """
    from huggingface_hub import snapshot_download
    try:
        snapshot_dir = snapshot_download(repo_id=repo_id_for(model_id), cache_dir=download_root, local_files_only=True)
    except Exception:
        return False

    weights_path = os.path.join(snapshot_dir, 'model.bin')
    try:
        # os.path.exists follows symlinks and returns False for a broken
        # link (huggingface_hub stores files as symlinks into blobs/), so
        # this alone catches a missing-target case; the size check below
        # additionally guards against a truncated/corrupt file.
        return os.path.exists(weights_path) and os.path.getsize(weights_path) > 10_000_000
    except OSError:
        return False


def cmd_list_models(msg_id, args):
    download_root = args['downloadRoot']
    statuses = []
    for opt in MODEL_OPTIONS:
        statuses.append({**opt, 'downloaded': is_model_downloaded(opt['id'], download_root)})
    emit(msg_id, 'result', data=statuses)


# --- Model download with cancelable progress ----------------------------------------------

def cmd_download_model(msg_id, args):
    model_id = args['modelId']
    download_root = args['downloadRoot']
    set_active_job(msg_id)

    import tqdm as tqdm_module

    class ProgressTqdm(tqdm_module.tqdm):
        _last_emit = [0.0]

        def update(self, n=1):
            result = super().update(n)
            if msg_id in cancel_flags:
                raise WorkerCanceled()
            now = time.time()
            if self.total and (now - ProgressTqdm._last_emit[0] > 0.15 or self.n >= (self.total or 0)):
                ProgressTqdm._last_emit[0] = now
                emit(
                    msg_id,
                    'progress',
                    data={
                        'modelId': model_id,
                        'stage': 'downloading',
                        'percent': min(100.0, (self.n / self.total) * 100) if self.total else 0.0,
                        'bytesDownloaded': self.n,
                        'totalBytes': self.total,
                    },
                )
            return result

    import huggingface_hub.file_download as file_download_module

    original_tqdm = tqdm_module.tqdm
    original_file_download_tqdm = file_download_module.tqdm
    tqdm_module.tqdm = ProgressTqdm
    file_download_module.tqdm = ProgressTqdm
    try:
        from huggingface_hub import snapshot_download

        emit(msg_id, 'progress', data={'modelId': model_id, 'stage': 'downloading', 'percent': 0})
        snapshot_download(repo_id=repo_id_for(model_id), cache_dir=download_root)

        emit(msg_id, 'progress', data={'modelId': model_id, 'stage': 'verifying', 'percent': 100})
        if not is_model_downloaded(model_id, download_root):
            raise RuntimeError('Downloaded model failed integrity verification')

        emit(msg_id, 'result', data={'modelId': model_id, 'stage': 'ready', 'percent': 100})
    except WorkerCanceled:
        emit(msg_id, 'error', message='canceled', canceled=True)
    finally:
        tqdm_module.tqdm = original_tqdm
        file_download_module.tqdm = original_file_download_tqdm
        set_active_job(None)


# --- Device detection -----------------------------------------------------------------------
#
# ctranslate2.get_cuda_device_count() can hang indefinitely in some
# environments (observed during Phase C testing, even though `nvidia-smi`
# itself worked fine). A thread-based timeout is NOT safe against this: a
# hung native call can hold the GIL and freeze the *entire* interpreter even
# after the calling code gives up waiting on it, which then wedges every
# later command too (also observed). The only safe isolation is a real
# subprocess, since subprocess.run(timeout=...) can actually kill it.
#
# _cuda_probe_lock prevents two probes from ever running concurrently (the
# user-facing "Retry GPU Detection" control could otherwise race with the
# probe that runs automatically before the first transcription).
_cuda_probe_lock = threading.Lock()


def _run_isolated_capture(args, timeout_seconds):
    """Spawns a subprocess and captures its output, bounded by a watchdog
    thread rather than subprocess.run(timeout=...).

    subprocess.run's own timeout mechanism was observed to behave
    unreliably specifically when called from this process (which always
    has a thread blocked on stdin, to receive commands at all) -- even
    with stdin=DEVNULL on the child. cmd_transcribe's Popen + blocking
    `for line in proc.stdout` pattern has been proven reliable many times
    over from this exact same context, so this reuses that pattern: a
    background watchdog thread kills the process on timeout, while the
    main thread does a normal blocking drain-read (never risking a full
    pipe buffer deadlock the way a poll-then-read-at-the-end loop would).

    Raises TimeoutError if the watchdog had to kill the process.
    """
    proc = subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding='utf-8'
    )
    proc.stdin.close()
    killed = threading.Event()

    def watchdog():
        time.sleep(timeout_seconds)
        if proc.poll() is None:
            killed.set()
            proc.kill()

    threading.Thread(target=watchdog, daemon=True).start()

    stdout_lines = []
    for line in proc.stdout:
        stdout_lines.append(line)
    proc.wait()
    stderr = proc.stderr.read()

    if killed.is_set():
        raise TimeoutError(f'process did not exit within {timeout_seconds}s')

    return proc.returncode, ''.join(stdout_lines), stderr


def _nvidia_dll_setup_prelude():
    """Python source injected into probe subprocesses so they can find the
    pip-installed cuBLAS/cuDNN DLLs -- those subprocesses don't inherit this
    process's os.add_dll_directory() calls (that API is process-scoped)."""
    dirs = gpu_support.find_nvidia_dll_dirs()
    dirs_literal = json.dumps(dirs)
    return (
        "import os, json\n"
        f"for _d in {dirs_literal}:\n"
        "    try:\n"
        "        os.add_dll_directory(_d)\n"
        "    except (OSError, AttributeError):\n"
        "        pass\n"
    )


def _cuda_device_count_via_subprocess(timeout_seconds=30):
    """Runs the CUDA device count check in a disposable child process.

    Returns (count, reason). On any failure or timeout, count is None and
    reason explains why (the child process is killed automatically by
    subprocess.run's timeout handling, so nothing is left hung or holding
    the GIL).
    """
    probe_code = (
        _nvidia_dll_setup_prelude()
        + "try:\n"
        "    import ctranslate2\n"
        "    print(json.dumps({'count': ctranslate2.get_cuda_device_count()}))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'error': str(e)}))\n"
    )
    probe_fd, probe_path = tempfile.mkstemp(suffix='.py', prefix='cuda-probe-')
    with os.fdopen(probe_fd, 'w', encoding='utf-8') as f:
        f.write(probe_code)

    try:
        with _cuda_probe_lock:
            try:
                returncode, stdout, stderr = _run_isolated_capture([sys.executable, '-u', probe_path], timeout_seconds)
            except TimeoutError:
                return None, (
                    f'CUDA device check did not respond within {timeout_seconds}s; falling back to CPU. '
                    'This can happen when the GPU is waking from a low-power state -- try "Retry GPU Detection".'
                )
            except Exception as err:
                return None, f'CUDA device check could not run: {err}'

        if returncode != 0:
            return None, f'CUDA device check exited with an error: {stderr.strip()[-300:]}'
        try:
            data = json.loads(stdout.strip().splitlines()[-1])
        except Exception:
            return None, 'CUDA device check produced unexpected output'
        if 'error' in data:
            return None, f'ctranslate2 unavailable: {data["error"]}'
        return data['count'], None
    finally:
        _unlink_with_retry(probe_path)


# Probing CUDA a second time in the same worker session was observed to hang
# even with the subprocess-based isolation above (killing a hung CUDA-probe
# child does not necessarily release whatever GPU/driver-level resource it
# was stuck on, and a second probe can then block even before its own
# subprocess.run timeout has a chance to engage -- the timeout only bounds
# communicate(), not the initial process spawn). Device availability can't
# change mid-session, so the fix is simply to probe once and cache it. The
# "Retry GPU Detection" UI control clears this cache explicitly.
_device_info_cache = None


def _build_device_info():
    dlls_ok, missing_dlls, dll_dirs = gpu_support.check_required_dlls()
    package_versions = gpu_support.get_package_versions()

    if not dlls_ok:
        reason = (
            'Required CUDA runtime DLLs not found: ' + ', '.join(missing_dlls)
            if dll_dirs
            else 'nvidia-cublas-cu12 / nvidia-cudnn-cu12 are not installed in this Python environment'
        )
        return {
            'device': 'cpu',
            'cudaAvailable': False,
            'reason': reason,
            'gpuLibsFound': False,
            'cublasVersion': package_versions.get('nvidia-cublas-cu12'),
            'cudnnVersion': package_versions.get('nvidia-cudnn-cu12'),
        }

    cuda_count, reason = _cuda_device_count_via_subprocess()
    if cuda_count is None:
        return {
            'device': 'cpu',
            'cudaAvailable': False,
            'reason': reason,
            'gpuLibsFound': True,
            'cublasVersion': package_versions.get('nvidia-cublas-cu12'),
            'cudnnVersion': package_versions.get('nvidia-cudnn-cu12'),
        }

    if cuda_count > 0:
        name = None
        driver_version = None
        try:
            returncode, stdout, _stderr = _run_isolated_capture(
                ['nvidia-smi', '--query-gpu=name,driver_version', '--format=csv,noheader'], 5
            )
            if returncode == 0 and stdout.strip():
                parts = [p.strip() for p in stdout.strip().splitlines()[0].split(',')]
                name = parts[0] if len(parts) > 0 else None
                driver_version = parts[1] if len(parts) > 1 else None
        except Exception:
            pass

        # Read via package metadata rather than `import ctranslate2` directly:
        # actually importing the native extension in *this* process (which
        # always has a thread blocked on stdin) was found to hang the same
        # way WhisperModel construction did once real CUDA libraries are
        # present -- see transcribe_child.py's docstring for the full story.
        # importlib.metadata never executes the package's code at all.
        import importlib.metadata
        try:
            ct2_version = importlib.metadata.version('ctranslate2')
        except importlib.metadata.PackageNotFoundError:
            ct2_version = None

        return {
            'device': 'cuda',
            'cudaAvailable': True,
            'cudaDeviceName': name,
            'driverVersion': driver_version,
            'gpuLibsFound': True,
            'cublasVersion': package_versions.get('nvidia-cublas-cu12'),
            'cudnnVersion': package_versions.get('nvidia-cudnn-cu12'),
            'ctranslate2Version': ct2_version,
        }

    return {
        'device': 'cpu',
        'cudaAvailable': False,
        'reason': 'No CUDA-capable device detected',
        'gpuLibsFound': True,
        'cublasVersion': package_versions.get('nvidia-cublas-cu12'),
        'cudnnVersion': package_versions.get('nvidia-cudnn-cu12'),
    }


def detect_device():
    global _device_info_cache
    if _device_info_cache is not None:
        return _device_info_cache
    _device_info_cache = _build_device_info()
    return _device_info_cache


def cmd_device_info(msg_id, _args):
    emit(msg_id, 'result', data=detect_device())


def cmd_retry_gpu_detection(msg_id, _args):
    """Clears the cached device info and re-probes from scratch (does not
    run a real-inference test -- see cmd_verify_gpu for that)."""
    global _device_info_cache
    _device_info_cache = None
    emit(msg_id, 'result', data=detect_device())


# --- Bounded real-inference GPU verification -----------------------------------------------
#
# Device-count detection only proves a CUDA device exists, not that actual
# inference works end-to-end (e.g. cuDNN engine selection failures, mismatched
# compute capability). This runs a real (tiny) transcription on synthesized
# silence, reusing transcribe_child.py -- the exact same code path production
# transcription uses -- rather than a separate, easier-to-get-subtly-wrong
# duplicate. Bounded via subprocess.run's timeout.

_verify_gpu_lock = threading.Lock()


def _make_silence_wav():
    import wave
    import struct
    path = os.path.join(tempfile.gettempdir(), 'gpu-verify-silence.wav')
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(struct.pack('<8000h', *([0] * 8000)))  # 0.5s of silence
    return path


def cmd_verify_gpu(msg_id, args):
    download_root = args.get('downloadRoot', '')

    if not _verify_gpu_lock.acquire(blocking=False):
        emit(msg_id, 'error', message='A GPU verification is already in progress')
        return

    args_path = None
    try:
        emit(msg_id, 'progress', data={'stage': 'testing', 'message': 'Running a real GPU transcription test…'})

        silence_path = _make_silence_wav()
        child_args = {
            'mediaId': 'gpu-verify',
            'audioPath': silence_path,
            'modelId': 'tiny',
            'language': 'en',
            'downloadRoot': download_root,
            'preferDevice': 'cuda',
        }
        args_fd, args_path = tempfile.mkstemp(suffix='.json', prefix='gpu-verify-args-')
        with os.fdopen(args_fd, 'w', encoding='utf-8') as f:
            json.dump(child_args, f)

        child_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'transcribe_child.py')
        t0 = time.time()
        try:
            _returncode, stdout, stderr = _run_isolated_capture([sys.executable, '-u', child_script, args_path], 120)
        except TimeoutError:
            emit(msg_id, 'result', data={'ok': False, 'error': 'GPU verification timed out after 120s'})
            return
        total_time = time.time() - t0

        result_line = None
        for line in stdout.splitlines():
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get('type') in ('result', 'error'):
                result_line = msg

        if result_line is None or result_line.get('type') == 'error':
            error_message = (result_line or {}).get('message') or stderr.strip()[-1000:] or 'GPU verification produced no result'
            emit(msg_id, 'result', data={'ok': False, 'error': error_message})
            return

        transcript = result_line.get('data', {}).get('transcript', {})
        device_used = transcript.get('device')
        if device_used != 'cuda':
            emit(msg_id, 'result', data={'ok': False, 'error': 'Transcription silently fell back to CPU during verification'})
            return

        result = {
            'ok': True,
            'loadTimeSeconds': None,
            'inferenceTimeSeconds': total_time,
            'computeType': transcript.get('computeType'),
        }

        # We just proved CUDA works via a real transcription -- no need to
        # re-run the (separately flaky-timed) quick device-count probe just
        # to update the cache; merge onto whatever's already cached instead.
        global _device_info_cache
        _device_info_cache = {
            **(_device_info_cache or {}),
            'device': 'cuda',
            'cudaAvailable': True,
            'verified': True,
            'computeType': transcript.get('computeType'),
        }

        emit(msg_id, 'result', data=result)
    finally:
        if args_path:
            _unlink_with_retry(args_path)
        _verify_gpu_lock.release()


# --- Transcription ----------------------------------------------------------------------------
#
# Delegated to a dedicated child process (transcribe_child.py). Constructing
# a WhisperModel was found to reliably hang when this process's own
# always-on stdin-reader thread is present (see transcribe_child.py's
# docstring for the full story) -- so the actual model work happens in a
# fresh process that doesn't start listening for control messages until
# after its model is constructed.

def cmd_transcribe(msg_id, args):
    media_id = args['mediaId']
    set_active_job(msg_id)

    device_info = detect_device()
    child_args = dict(args)
    child_args['preferDevice'] = device_info['device']

    args_fd, args_path = tempfile.mkstemp(suffix='.json', prefix='transcribe-args-')
    with os.fdopen(args_fd, 'w', encoding='utf-8') as f:
        json.dump(child_args, f)

    child_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'transcribe_child.py')

    try:
        proc = subprocess.Popen(
            [sys.executable, '-u', child_script, args_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
        )
        active_transcribe_procs[msg_id] = proc

        got_final = False
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                child_msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            if child_msg.get('type') == 'progress':
                emit(msg_id, 'progress', data=child_msg.get('data'))
            elif child_msg.get('type') == 'result':
                emit(msg_id, 'result', data=child_msg.get('data'))
                got_final = True
            elif child_msg.get('type') == 'error':
                emit(msg_id, 'error', message=child_msg.get('message', 'error'), canceled=bool(child_msg.get('canceled')))
                got_final = True

        proc.wait(timeout=10)
        if not got_final:
            stderr_tail = (proc.stderr.read() or '').strip()[-2000:]
            emit(msg_id, 'error', message=stderr_tail or f'Transcription worker exited unexpectedly (code {proc.returncode})')
    finally:
        active_transcribe_procs.pop(msg_id, None)
        set_active_job(None)
        _unlink_with_retry(args_path)


def _unlink_with_retry(path, attempts=5, delay_seconds=0.2):
    # Windows/antivirus can briefly hold a lock on a just-closed file right
    # after the child process that read it exits; retry a few times rather
    # than silently leaking the temp args file.
    for attempt in range(attempts):
        try:
            os.unlink(path)
            return
        except OSError:
            if attempt == attempts - 1:
                return
            time.sleep(delay_seconds)


# --- Script alignment (character-level, script-agnostic; robust for Khmer) ------------------

SENTENCE_BOUNDARY = re.compile(r'[^។.!?\n]+[។.!?\n]?')


def split_script_into_segments(script_text):
    segments = []
    for m in SENTENCE_BOUNDARY.finditer(script_text):
        text = m.group().strip()
        if text:
            segments.append((text, m.start(), m.end()))
    return segments


def align_script(script_text, words):
    transcript_chars = []
    char_to_word_index = []
    for i, w in enumerate(words):
        for ch in w['text']:
            transcript_chars.append(ch)
            char_to_word_index.append(i)
        transcript_chars.append(' ')
        char_to_word_index.append(-1)
    transcript_str = ''.join(transcript_chars)

    matcher = difflib.SequenceMatcher(None, transcript_str, script_text, autojunk=False)
    blocks = [b for b in matcher.get_matching_blocks() if b.size > 0]

    results = []
    for text, seg_start, seg_end in split_script_into_segments(script_text):
        matched_word_indices = set()
        matched_chars = 0
        seg_len = max(seg_end - seg_start, 1)
        for block in blocks:
            b_start, b_end = block.b, block.b + block.size
            overlap_start = max(b_start, seg_start)
            overlap_end = min(b_end, seg_end)
            if overlap_start < overlap_end:
                matched_chars += overlap_end - overlap_start
                a_start = block.a + (overlap_start - b_start)
                a_end = block.a + (overlap_end - b_start)
                for a_pos in range(a_start, a_end):
                    idx = char_to_word_index[a_pos]
                    if idx >= 0:
                        matched_word_indices.add(idx)

        if matched_word_indices:
            start_time = min(words[i]['startTime'] for i in matched_word_indices)
            end_time = max(words[i]['endTime'] for i in matched_word_indices)
            confidence = min(1.0, matched_chars / seg_len)
        else:
            start_time, end_time, confidence = 0.0, 0.0, 0.0

        results.append({
            'text': text,
            'startTime': start_time,
            'endTime': end_time,
            'matchedWordCount': len(matched_word_indices),
            'confidence': confidence,
        })
    return results


def cmd_align(msg_id, args):
    script_text = args['scriptText']
    words = args['words']
    result = align_script(script_text, words)
    emit(msg_id, 'result', data=result)


# --- Dispatch loop ------------------------------------------------------------------------

def stdin_reader(q):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        if msg.get('cmd') == 'control':
            action = msg.get('args', {}).get('action')
            if action == 'pause':
                pause_event.set()
            elif action == 'resume':
                pause_event.clear()
            elif action == 'cancel':
                with active_job_id_lock:
                    if active_job_id[0]:
                        cancel_flags.add(active_job_id[0])
            if action in ('pause', 'resume', 'cancel'):
                for child_proc in list(active_transcribe_procs.values()):
                    try:
                        child_proc.stdin.write(json.dumps({'action': action}) + '\n')
                        child_proc.stdin.flush()
                    except Exception:
                        pass
            continue

        q.put(msg)
    q.put(None)  # stdin closed -> shut down


HANDLERS = {
    'ping': lambda msg_id, args: emit(msg_id, 'result', data={'ok': True, 'pid': os.getpid()}),
    'device_info': cmd_device_info,
    'retry_gpu_detection': cmd_retry_gpu_detection,
    'verify_gpu': cmd_verify_gpu,
    'list_models': cmd_list_models,
    'download_model': cmd_download_model,
    'transcribe': cmd_transcribe,
    'align': cmd_align,
}


def main():
    q = queue.Queue()
    threading.Thread(target=stdin_reader, args=(q,), daemon=True).start()

    emit('worker', 'ready', data={'pid': os.getpid()})

    while True:
        msg = q.get()
        if msg is None:
            break
        msg_id = msg.get('id', 'unknown')
        cmd = msg.get('cmd')
        handler = HANDLERS.get(cmd)
        if not handler:
            emit(msg_id, 'error', message=f'Unknown command: {cmd}')
            continue
        try:
            handler(msg_id, msg.get('args', {}))
        except Exception as err:
            emit(msg_id, 'error', message=str(err), traceback=traceback.format_exc())


if __name__ == '__main__':
    main()
