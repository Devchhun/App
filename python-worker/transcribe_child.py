"""Dedicated child process for exactly one transcription job.

Why this exists: testing on this platform showed that constructing a
faster-whisper WhisperModel reliably hangs if the process already has
another thread blocked in a native stdin read (worker.py's persistent
command-dispatch thread has to be exactly that, to receive commands at
all). An inert background thread is fine; a thread blocked on stdin I/O is
not -- ctranslate2's native init appears to deadlock against it.

The fix: run model construction here, in a fresh process with no stdin
reader yet. Only *after* construction succeeds do we start listening for
pause/resume/cancel control messages (as JSON lines on this process's own
stdin), for the remainder of the (longer) segment-by-segment transcription
loop. worker.py spawns one of these per transcribe request and relays its
stdout/stdin.
"""

import sys
import os
import io
import json
import time
import itertools
import threading
import argparse
import traceback
import datetime

# See worker.py for why this is needed under the embeddable/portable Python.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gpu_support

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', errors='replace', newline='\n')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', newline='\n')

STDOUT_LOCK = threading.Lock()


def emit(msg_type, **fields):
    payload = {'type': msg_type, **fields}
    with STDOUT_LOCK:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
        sys.stdout.flush()


pause_event = threading.Event()
cancel_requested = threading.Event()


class Canceled(Exception):
    pass


def control_reader():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        action = msg.get('action')
        if action == 'pause':
            pause_event.set()
        elif action == 'resume':
            pause_event.clear()
        elif action == 'cancel':
            cancel_requested.set()


def check_cancel_or_pause():
    while pause_event.is_set() and not cancel_requested.is_set():
        time.sleep(0.1)
    if cancel_requested.is_set():
        raise Canceled()


def _start_transcription(model, audio_path, whisper_language):
    segments_iter, info = model.transcribe(
        audio_path, language=whisper_language, word_timestamps=True, vad_filter=True
    )
    head = []
    try:
        head.append(next(segments_iter))
    except StopIteration:
        pass
    return head, segments_iter, info


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('args_file')
    parsed = parser.parse_args()
    with open(parsed.args_file, 'r', encoding='utf-8') as f:
        args = json.load(f)

    media_id = args['mediaId']
    audio_path = args['audioPath']
    model_id = args['modelId']
    language = args.get('language', 'auto')
    download_root = args['downloadRoot']
    prefer_device = args.get('preferDevice', 'cpu')

    emit('progress', data={'mediaId': media_id, 'stage': 'loading-model', 'percent': 2})

    if prefer_device == 'cuda':
        gpu_support.enable_gpu_dll_dirs()

    from faster_whisper import WhisperModel

    device_used = 'cpu'
    compute_type_used = 'int8'
    model = None
    if prefer_device == 'cuda':
        try:
            model = WhisperModel(model_id, device='cuda', compute_type='float16', download_root=download_root)
            device_used = 'cuda'
            compute_type_used = 'float16'
        except Exception:
            model = None
    if model is None:
        model = WhisperModel(model_id, device='cpu', compute_type='int8', download_root=download_root)
        device_used = 'cpu'
        compute_type_used = 'int8'

    # Only now, after construction has completed, is it safe to have a thread
    # blocked on stdin -- see module docstring.
    threading.Thread(target=control_reader, daemon=True).start()

    emit('progress', data={'mediaId': media_id, 'stage': 'transcribing', 'percent': 5})
    whisper_language = None if language == 'auto' else language

    try:
        head, segments_iter, info = _start_transcription(model, audio_path, whisper_language)
    except Exception:
        if device_used != 'cuda':
            raise
        model = WhisperModel(model_id, device='cpu', compute_type='int8', download_root=download_root)
        device_used = 'cpu'
        compute_type_used = 'int8'
        head, segments_iter, info = _start_transcription(model, audio_path, whisper_language)

    duration = max(info.duration, 0.001)
    segments = []
    for seg in itertools.chain(head, segments_iter):
        check_cancel_or_pause()

        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    'text': w.word.strip(),
                    'startTime': w.start,
                    'endTime': w.end,
                    'confidence': float(w.probability),
                })
        confidence = (
            sum(w['confidence'] for w in words) / len(words)
            if words
            else float(min(1.0, max(0.0, 1.0 + (seg.avg_logprob / 5.0))))
        )
        text = seg.text.strip()
        # A literal U+FFFD in the decoded text means the tokenizer hit a
        # byte sequence it could not decode as valid UTF-8 -- an
        # unambiguous signal of a broken/hallucinated token, regardless of
        # what confidence score came with it (observed: segments up to
        # 0.82 confidence still contained U+FFFD, so confidence alone is
        # not a reliable proxy for this specific failure mode).
        has_replacement_char = '�' in text
        segments.append({
            'id': f'{media_id}-{len(segments)}',
            'words': words,
            'startTime': seg.start,
            'endTime': seg.end,
            'language': info.language,
            'confidence': confidence,
            'text': text,
            'needsReview': confidence < 0.6 or has_replacement_char,
        })

        percent = min(99.0, 5 + (seg.end / duration) * 94)
        emit('progress', data={'mediaId': media_id, 'stage': 'transcribing', 'percent': percent})

    transcript = {
        'mediaId': media_id,
        'segments': segments,
        'requestedLanguage': language,
        'detectedLanguage': info.language,
        'modelId': model_id,
        'device': device_used,
        'computeType': compute_type_used,
        'generatedAt': datetime.datetime.utcnow().isoformat() + 'Z',
        'audioSourcePath': audio_path,
    }
    emit('result', data={'mediaId': media_id, 'stage': 'ready', 'percent': 100, 'transcript': transcript})


if __name__ == '__main__':
    try:
        main()
    except Canceled:
        emit('error', message='canceled', canceled=True)
        sys.exit(2)
    except Exception as err:
        emit('error', message=str(err), traceback=traceback.format_exc())
        sys.exit(1)
