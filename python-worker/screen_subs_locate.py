"""Finds where a video's burned-in subtitles are, with PP-OCRv4's text
detector, before screen_subs_runner.py reads them.

    python screen_subs_locate.py <job.json>

job.json: {"ffmpeg", "video", "detModel", "out", "duration" (seconds),
           "height" (the frame's height when scaled to 960 wide),
           "samples" (frames to look at, default 48)}

The older finder (app/main/media/subtitleDetect.ts) counted bright sharp
edges per row. On a bright or busy picture -- white ink paintings, glowing
spells, a wall of windows -- the picture had more of those than the
subtitles, and the band landed in the middle of the frame: every line of
dialogue was then missed (measured on three of four 4K episodes). The
detector was trained to tell text from picture, so it is asked instead:
in frames spread over the film, where is there a line of text, centred,
of a subtitle's height? The rows where that happens in the most frames
are the band. A title card or a credit roll is there in a few frames only;
a corner logo is not centred.

Writes {"band": {"x", "y", "w", "h"} | null, "frames": n, "withText": k}
(fractions of the frame) to <out> and prints "ok 1" (a band found) or "ok 0".
"""
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from screen_subs_runner import Detector  # noqa: E402

WIDTH = 960
# A line of subtitle text: its height, as a share of the frame's.
MIN_LINE_H, MAX_LINE_H = 0.018, 0.10
# How far its middle may be from the frame's middle (share of the width).
CENTRED = 0.14
# Frames with a line at the band, at least: fewer is a title card, not subtitles.
MIN_SHARE = 0.1


def grab(ffmpeg, video, t, height):
    args = [ffmpeg, '-v', 'error', '-ss', f'{t:.3f}', '-i', video, '-frames:v', '1', '-an', '-sn',
            '-vf', f'scale={WIDTH}:{height}:flags=area', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    data = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    if len(data) != WIDTH * height * 3:
        return None
    return np.frombuffer(data, np.uint8).reshape(height, WIDTH, 3).astype(np.float32)


def text_lines(mask):
    """The centred lines of text in one frame's detector mask, as
    (top, bottom, left, right) in pixels."""
    h, w = mask.shape
    cover = mask.sum(1) / w
    lines = []
    y = 0
    while y < h:
        if cover[y] < 0.006:
            y += 1
            continue
        y0 = y
        while y < h and cover[y] >= 0.006:
            y += 1
        y1 = y
        rows = mask[y0:y1]
        cols = np.where(rows.any(0))[0]
        if len(cols) == 0:
            continue
        left, right = int(cols[0]), int(cols[-1])
        tall = (y1 - y0) / h
        if not (MIN_LINE_H <= tall <= MAX_LINE_H):
            continue
        if abs((left + right) / 2 - w / 2) > CENTRED * w or (right - left) < 0.04 * w:
            continue
        lines.append((y0, y1, left, right))
    return lines


def main():
    job = json.load(open(sys.argv[1], encoding='utf-8'))
    ffmpeg, video = job['ffmpeg'], job['video']
    duration = float(job['duration'])
    samples = int(job.get('samples', 48))
    # The frame's height at WIDTH, from one frame of any height.
    height = int(job.get('height') or 0)
    if not height:
        raise SystemExit('height missing')
    detector = Detector(job['detModel'])
    hits = np.zeros(height, np.float32)
    spans = []
    looked = 0
    for i in range(samples):
        # The first and last 5 %: opening titles and the credit roll.
        t = duration * (0.05 + 0.9 * (i + 0.5) / samples)
        frame = grab(ffmpeg, video, t, height)
        print(f'progress {(i + 1) / samples:.2f}', flush=True)
        if frame is None:
            continue
        looked += 1
        seen = np.zeros(height, bool)
        for y0, y1, left, right in text_lines(detector.mask(frame)):
            seen[y0:y1] = True
            spans.append((y0, y1, left, right))
        hits += seen
    result = {'band': None, 'frames': looked, 'withText': 0}
    if looked:
        # Lower rows first: a subtitle is far more often at the bottom than
        # anywhere else, so a tie goes downwards.
        weight = np.where(np.arange(height) >= height * 0.45, 1.0, 0.85)
        peak = int(np.argmax(hits * weight))
        best = hits[peak]
        if best >= max(3, MIN_SHARE * looked):
            keep = hits >= best * 0.45
            y0 = y1 = peak
            while y0 > 0 and keep[y0 - 1]:
                y0 -= 1
            while y1 < height - 1 and keep[y1 + 1]:
                y1 += 1
            inside = [s for s in spans if s[0] < y1 and s[1] > y0]
            lefts = sorted(s[2] for s in inside)
            rights = sorted(s[3] for s in inside)
            left = lefts[int(len(lefts) * 0.05)] if lefts else 0
            right = rights[min(len(rights) - 1, int(len(rights) * 0.95))] if rights else WIDTH - 1
            # Centred: as far out on both sides.
            reach = max(WIDTH / 2 - left, right - WIDTH / 2)
            left, right = max(0, WIDTH / 2 - reach), min(WIDTH, WIDTH / 2 + reach)
            result = {
                'band': {'x': left / WIDTH, 'y': y0 / height, 'w': (right - left) / WIDTH, 'h': (y1 - y0 + 1) / height},
                'frames': looked,
                'withText': int(best)
            }
    with open(job['out'], 'w', encoding='utf-8') as f:
        json.dump(result, f)
    print(f"ok {1 if result['band'] else 0}", flush=True)


if __name__ == '__main__':
    main()
