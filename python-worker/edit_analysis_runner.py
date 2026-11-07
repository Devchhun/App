"""Reverse-editing analysis: which parts of an ORIGINAL video became which
parts of an EDITED video, so the AI can learn one person's editing style.

Self-contained -- only numpy and the app's ffmpeg (its path comes in the job),
exactly like reframe_runner.py. No OpenCV, PyAV, torch or network. ffmpeg
decodes each video at a few frames a second into small grayscale frames; from
those we find shot cuts, fingerprint each frame (a dHash), and line the edited
footage up against the source by fingerprint similarity under a
"time only moves forward within a shot" rule. The result is a list of matched
segments (source in/out -> edited in/out) with confidence and an inferred
speed. A later pass joins these with the Khmer narration (done in Node, reusing
the existing transcription), so this script stays purely visual.

    python edit_analysis_runner.py job.json

job.json: {
  "ffmpeg": "<path>", "originalPath": "...", "editedPath": "...",
  "out": "<result.json>", "fps": 4, "hashSize": 16, "cutThreshold": 0.0
}
Writes the result to "out"; prints "progress <0-1>" lines and "ok <count>".
"""

import json
import subprocess
import sys

import numpy as np

# Small enough to be fast, big enough that different shots look different.
GRAY_W, GRAY_H = 64, 36
# dHash grid; a (HASH, HASH) grayscale is reduced to HASH*(HASH-1) bits.
HASH = 16
# A cut is a frame whose difference from the last is this many robust
# deviations above the running median (adaptive, so it suits any footage).
CUT_SIGMA = 6.0
# No shot shorter than this (merge micro-blips from flashes/camera shake).
MIN_SHOT = 0.25
# The bottom band of a frame is ignored when FINGERPRINTING for matching:
# recap edits usually burn subtitles there while the source footage has none,
# so including it makes every edited frame look different from its source.
# Cut detection still uses the whole frame.
SUB_BAND = 0.26


def decode_gray(ffmpeg, path, fps, w, h):
    """Every frame of `path` at `fps`, as (N, h, w) uint8 grayscale."""
    cmd = [
        ffmpeg, '-v', 'error', '-i', path,
        '-vf', f'fps={fps},scale={w}:{h}:flags=area,format=gray',
        '-f', 'rawvideo', '-',
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    raw = proc.stdout.read()
    proc.wait()
    n = len(raw) // (w * h)
    if n == 0:
        return np.zeros((0, h, w), dtype=np.uint8)
    return np.frombuffer(raw[: n * w * h], dtype=np.uint8).reshape(n, h, w)


def dhash_rows(frames, size):
    """A row-difference hash of each frame, as (N, size*(size-1)) bool.

    Resizing is a cheap area-average to (size, size+1 across) done with numpy
    by binning, so no image library is needed."""
    n = frames.shape[0]
    if n == 0:
        return np.zeros((0, size * (size - 1)), dtype=bool)
    # Bin each frame down to (size, size) by averaging blocks.
    small = _box_resize(frames.astype(np.float32), size, size)
    # Horizontal gradient sign: pixel brighter than the one to its right.
    bits = small[:, :, 1:] > small[:, :, :-1]
    return bits.reshape(n, -1)


def _box_resize(frames, out_h, out_w):
    """(N, H, W) -> (N, out_h, out_w) by averaging roughly equal blocks."""
    n, h, w = frames.shape
    ys = (np.linspace(0, h, out_h + 1)).astype(int)
    xs = (np.linspace(0, w, out_w + 1)).astype(int)
    out = np.empty((n, out_h, out_w), dtype=np.float32)
    for i in range(out_h):
        y0, y1 = ys[i], max(ys[i] + 1, ys[i + 1])
        band = frames[:, y0:y1, :].mean(axis=1)  # (N, W)
        for j in range(out_w):
            x0, x1 = xs[j], max(xs[j] + 1, xs[j + 1])
            out[:, i, j] = band[:, x0:x1].mean(axis=1)
    return out


def find_cuts(frames, fps):
    """Shot boundaries as frame indices [0, c1, c2, ..., N], adaptive."""
    n = frames.shape[0]
    if n <= 1:
        return [0, n]
    f = frames.astype(np.float32)
    diff = np.abs(f[1:] - f[:-1]).mean(axis=(1, 2))  # (N-1,)
    med = np.median(diff)
    mad = np.median(np.abs(diff - med)) + 1e-6
    thresh = med + CUT_SIGMA * mad
    cut_at = np.nonzero(diff > thresh)[0] + 1  # frame index where the new shot starts
    bounds = [0]
    min_frames = max(1, int(MIN_SHOT * fps))
    for c in cut_at:
        if c - bounds[-1] >= min_frames:
            bounds.append(int(c))
    if bounds[-1] != n:
        bounds.append(n)
    return bounds


def shots_from_bounds(bounds, fps):
    out = []
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        out.append({'index': i, 'startFrame': s, 'endFrame': e,
                    'start': round(s / fps, 3), 'end': round(e / fps, 3),
                    'duration': round((e - s) / fps, 3)})
    return out


def shot_signature(hashes, s, e):
    """A shot's fingerprint: the median bit pattern of its frames."""
    if e <= s:
        return hashes[s] if s < len(hashes) else None
    return hashes[s:e].mean(axis=0) > 0.5


def hamming_norm(a, b):
    """0 (identical) .. 1 (opposite) normalised hamming distance."""
    return float(np.count_nonzero(a != b)) / a.shape[0]


def match_shots(src_hashes, src_shots, ed_hashes, ed_shots, fps):
    """For each edited shot, the source shot it most resembles, plus the
    source in/out and an inferred speed. Temporal monotonicity is encouraged
    (a later edited shot prefers a source at/after the previous match) but not
    forced, since creators reorder footage."""
    src_sigs = [shot_signature(src_hashes, s['startFrame'], s['endFrame']) for s in src_shots]
    matches = []
    last_src_end = 0.0
    for es in ed_shots:
        ed_sig = shot_signature(ed_hashes, es['startFrame'], es['endFrame'])
        if ed_sig is None or not src_sigs:
            continue
        best_i, best_d = -1, 1.0
        for i, sig in enumerate(src_sigs):
            if sig is None:
                continue
            d = hamming_norm(ed_sig, sig)
            # Gentle bias toward keeping source order.
            if src_shots[i]['start'] < last_src_end:
                d += 0.03
            if d < best_d:
                best_d, best_i = d, i
        if best_i < 0:
            continue
        ss = src_shots[best_i]
        conf = max(0.0, 1.0 - best_d * 2.0)  # d<=0.5 -> some confidence
        ed_dur = es['duration']
        # Assume 1x speed: a source window the length of the edited shot,
        # anchored at the matched source shot's start. Speed is deliberately
        # NOT guessed from the shot-duration ratio -- without a frame-level
        # align we cannot tell "trimmed shorter" from "played faster", and a
        # wrong speed would teach the model a style the user never used. A
        # later alignment pass fills transform.speed when it is real.
        src_start = ss['start']
        src_end = min(ss['end'], src_start + ed_dur)
        matches.append({
            'editedStart': es['start'], 'editedEnd': es['end'],
            'sourceStart': round(src_start, 3), 'sourceEnd': round(src_end, 3),
            'confidence': round(conf, 3),
            'sourceShot': best_i, 'editedShot': es['index'],
            'transform': {},
            'origin': 'auto',
        })
        last_src_end = ss['end']
    return matches


def emit_progress(p):
    sys.stdout.write(f'progress {max(0.0, min(1.0, p)):.3f}\n')
    sys.stdout.flush()


def detect_only(ffmpeg, path, fps):
    """Scene detection for one video (auto-edit's new source footage): just the
    shots, no matching. Emits progress and returns the result dict."""
    frames = decode_gray(ffmpeg, path, fps, GRAY_W, GRAY_H)
    emit_progress(0.7)
    shots = shots_from_bounds(find_cuts(frames, fps), fps)
    emit_progress(0.95)
    return {
        'method': 'scenes-v1', 'fps': fps,
        'originalDuration': round(frames.shape[0] / fps, 3), 'editedDuration': 0.0,
        'sourceShots': [{'index': s['index'], 'start': s['start'], 'end': s['end'], 'duration': s['duration']} for s in shots],
        'editedShots': [], 'matches': [],
    }


def main():
    job = json.load(open(sys.argv[1], encoding='utf-8'))
    ffmpeg = job['ffmpeg']
    fps = float(job.get('fps', 4))
    hash_size = int(job.get('hashSize', HASH))

    emit_progress(0.02)
    # Scenes-only mode: one video in, its shots out (no edited video to match).
    if not job.get('editedPath'):
        result = detect_only(ffmpeg, job['originalPath'], fps)
        json.dump(result, open(job['out'], 'w', encoding='utf-8'), ensure_ascii=False)
        emit_progress(1.0)
        sys.stdout.write(f"ok {len(result['sourceShots'])}\n")
        sys.stdout.flush()
        return

    src = decode_gray(ffmpeg, job['originalPath'], fps, GRAY_W, GRAY_H)
    emit_progress(0.30)
    ed = decode_gray(ffmpeg, job['editedPath'], fps, GRAY_W, GRAY_H)
    emit_progress(0.55)

    src_bounds = find_cuts(src, fps)
    ed_bounds = find_cuts(ed, fps)
    src_shots = shots_from_bounds(src_bounds, fps)
    ed_shots = shots_from_bounds(ed_bounds, fps)
    emit_progress(0.65)

    # Fingerprint the picture above the subtitle band only (see SUB_BAND).
    keep = max(1, int(GRAY_H * (1.0 - SUB_BAND)))
    src_hashes = dhash_rows(src[:, :keep, :], hash_size)
    ed_hashes = dhash_rows(ed[:, :keep, :], hash_size)
    emit_progress(0.80)

    matches = match_shots(src_hashes, src_shots, ed_hashes, ed_shots, fps)
    emit_progress(0.95)

    def strip(shots):
        return [{'index': s['index'], 'start': s['start'], 'end': s['end'],
                 'duration': s['duration']} for s in shots]

    result = {
        'method': 'dhash-v1',
        'fps': fps,
        'originalDuration': round(src.shape[0] / fps, 3),
        'editedDuration': round(ed.shape[0] / fps, 3),
        'sourceShots': strip(src_shots),
        'editedShots': strip(ed_shots),
        'matches': matches,
    }
    json.dump(result, open(job['out'], 'w', encoding='utf-8'), ensure_ascii=False)
    emit_progress(1.0)
    sys.stdout.write(f'ok {len(matches)}\n')
    sys.stdout.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:  # noqa: BLE001 -- report any failure to Node as text
        sys.stdout.write(f'error {exc}\n')
        sys.stdout.flush()
        sys.exit(1)
