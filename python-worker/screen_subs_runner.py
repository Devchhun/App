"""Reads a video's burned-in subtitles (the text drawn into the picture)
with PP-OCRv4's Chinese/English text recognizer, as timed lines.

    python screen_subs_runner.py <job.json>

job.json: {"ffmpeg", "video", "model", "keys", "out",
           "band": {"x", "y", "w", "h"} (fractions of the frame),
           "ranges": [[start, end], ...] (seconds), "fps"}

ffmpeg cuts the subtitle band out of every frame (fps per second); in each
band the subtitle's letters are found (bright strokes, centred), cut out and
read; frames that read alike in a row are one line, its text the reading
seen most often. Prints "progress <0-1>" while it works and "ok <count>"
once <out> (JSON: [{"start", "end", "text", "confidence", "frames"}]) is
written.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
from collections import Counter
from difflib import SequenceMatcher

import numpy as np
import onnxruntime as ort

# The recognizer's input height; widths are a multiple of WIDTH_STEP.
REC_HEIGHT = 48
WIDTH_STEP = 64
MAX_WIDTH = 1600
BATCH = 16
MIN_CONFIDENCE = 0.7
# Two readings of one line, at least this alike (difflib ratio).
SAME_LINE = 0.6

JUNK = re.compile(r'[#<>《》「」『』（）()\[\]【】|_~`^*①-⓿]')
EDGES = re.compile(r'^[，,。.、：:；;！!？?\s\-]+|[，,。.、：:；;\s\-]+$')
CJK = re.compile(r'[㐀-鿿]')


def letters_mask(band):
    """Subtitle-coloured pixels: white/grey-white, or yellow."""
    b = band[:, :, 0].astype(np.int16)
    g = band[:, :, 1].astype(np.int16)
    r = band[:, :, 2].astype(np.int16)
    white = (r > 190) & (g > 190) & (b > 190)
    yellow = (r > 190) & (g > 160) & (b < 120)
    return white | yellow


def runs(flags, max_gap):
    """[start, end) of the True runs in flags, gaps up to max_gap bridged."""
    out = []
    idx = np.nonzero(flags)[0]
    if len(idx) == 0:
        return out
    start = prev = idx[0]
    for i in idx[1:]:
        if i - prev > max_gap + 1:
            out.append((start, prev + 1))
            start = i
        prev = i
    out.append((start, prev + 1))
    return out


def text_rows(band):
    """The subtitle's line(s) in the band: [(y0, y1, x0, x1)], top to bottom."""
    mask = letters_mask(band)
    height, width = mask.shape
    row_runs = [r for r in runs(mask.sum(axis=1) >= 3, max(1, height // 30)) if r[1] - r[0] >= max(6, height // 8)]
    found = []
    for y0, y1 in row_runs:
        cols = mask[y0:y1].sum(axis=0) >= 2
        # Letters of one line are close together; a speck far away is not text.
        pieces = runs(cols, int((y1 - y0) * 1.6))
        if not pieces:
            continue
        mid = width / 2
        best = max(pieces, key=lambda p: (mask[y0:y1, p[0]:p[1]].sum(), -abs((p[0] + p[1]) / 2 - mid)))
        x0, x1 = best
        if x1 - x0 < (y1 - y0) * 0.8:
            continue
        if mask[y0:y1, x0:x1].mean() < 0.04:
            continue
        pad = max(4, (y1 - y0) // 4)
        found.append((max(0, y0 - pad), min(height, y1 + pad), max(0, x0 - pad), min(width, x1 + pad)))
    return found


def resize(img, h, w):
    ys = np.clip(((np.arange(h) + 0.5) * img.shape[0] / h).astype(int), 0, img.shape[0] - 1)
    xs = np.clip(((np.arange(w) + 0.5) * img.shape[1] / w).astype(int), 0, img.shape[1] - 1)
    return img[ys][:, xs]


def clean(text):
    return EDGES.sub('', JUNK.sub('', text)).strip()


class Reader:
    def __init__(self, model, keys):
        self.keys = [''] + open(keys, encoding='utf-8').read().splitlines() + [' ']
        # A few threads: the inputs are small, and onnxruntime's default (one
        # per core) spent its time contending with ffmpeg -- measured on a
        # 28-thread CPU: 5 minutes of 4K read in 60 s, 21 s with 4 threads.
        options = ort.SessionOptions()
        options.intra_op_num_threads = int(os.environ.get('OCR_THREADS', '4'))
        self.session = ort.InferenceSession(model, options, providers=['CPUExecutionProvider'])
        self.input = self.session.get_inputs()[0].name

    def decode(self, logits):
        ids = logits.argmax(-1)
        probs = logits.max(-1)
        chars, confs, last = [], [], 0
        for i, p in zip(ids, probs):
            if i != last and i != 0:
                chars.append(self.keys[i] if i < len(self.keys) else '')
                confs.append(float(p))
            last = i
        return ''.join(chars), (float(np.mean(confs)) if confs else 0.0)

    def read(self, crops):
        """Text and confidence of each crop (BGR, any size)."""
        prepared = []
        for c in crops:
            w = int(round(c.shape[1] * REC_HEIGHT / max(1, c.shape[0])))
            w = max(WIDTH_STEP, min(MAX_WIDTH, w))
            prepared.append(resize(c, REC_HEIGHT, w))
        results = [('', 0.0)] * len(crops)
        by_width = {}
        for i, p in enumerate(prepared):
            by_width.setdefault(-(-p.shape[1] // WIDTH_STEP) * WIDTH_STEP, []).append(i)
        for width, ids in by_width.items():
            for s in range(0, len(ids), BATCH):
                chunk = ids[s:s + BATCH]
                batch = np.zeros((len(chunk), REC_HEIGHT, width, 3), np.float32)
                for j, i in enumerate(chunk):
                    batch[j, :, :prepared[i].shape[1]] = prepared[i]
                batch = ((batch / 255.0 - 0.5) / 0.5).transpose(0, 3, 1, 2)
                out = self.session.run(None, {self.input: batch})[0]
                for j, i in enumerate(chunk):
                    results[i] = self.decode(out[j])
        return results


def read_frame(reader, band):
    # Every frame is read, even when the line has not changed: a line's text
    # is the reading seen most often, so one bad reading cannot stick.
    rows = text_rows(band)
    if not rows:
        return '', 0.0
    readings = reader.read([band[y0:y1, x0:x1] for y0, y1, x0, x1 in rows])
    kept = [(clean(t), c) for t, c in readings]
    kept = [(t, c) for t, c in kept if t and c >= MIN_CONFIDENCE]
    if not kept:
        return '', 0.0
    # Chinese with an English translation under it: the Chinese is the line.
    if any(CJK.search(t) for t, _ in kept):
        kept = [(t, c) for t, c in kept if CJK.search(t)]
    return ' '.join(t for t, _ in kept), min(c for _, c in kept)


def group(readings, fps):
    """[(time, text, conf)] -> lines: frames that read alike in a row."""
    lines = []
    step = 1.0 / fps
    for t, text, conf in readings:
        if not text:
            continue
        last = lines[-1] if lines else None
        if last and t - last['end'] < step * 1.5:
            best = Counter(last['seen']).most_common(1)[0][0]
            if SequenceMatcher(None, best, text).ratio() >= SAME_LINE:
                last['end'] = t + step
                last['seen'].append(text)
                last['confs'].append(conf)
                continue
        lines.append({'start': t, 'end': t + step, 'seen': [text], 'confs': [conf]})
    out = []
    for ln in lines:
        if len(ln['seen']) < 2:
            continue
        counts = Counter(ln['seen'])
        text = max(counts.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
        out.append({'start': round(ln['start'], 3), 'end': round(ln['end'], 3), 'text': text, 'confidence': round(float(np.mean(ln['confs'])), 3), 'frames': len(ln['seen'])})
    # The same line flickering off for a frame or two is still one line.
    merged = []
    for ln in out:
        prev = merged[-1] if merged else None
        if prev and prev['text'] == ln['text'] and ln['start'] - prev['end'] < 0.6:
            prev['end'] = ln['end']
            prev['frames'] += ln['frames']
        else:
            merged.append(ln)
    return merged


def main():
    job = json.load(open(sys.argv[1], encoding='utf-8'))
    reader = Reader(job['model'], job['keys'])
    fps = float(job.get('fps', 5))
    band = job['band']
    out_w, out_h = int(job['bandWidth']), int(job['bandHeight'])
    ranges = job['ranges']
    total = sum(e - s for s, e in ranges) or 1.0
    done_seconds = 0.0
    lines = []
    frame_bytes = out_w * out_h * 3
    for start, end in ranges:
        vf = f"fps={fps},crop=iw*{band['w']:.5f}:ih*{band['h']:.5f}:iw*{band['x']:.5f}:ih*{band['y']:.5f},scale={out_w}:{out_h}:flags=area"
        args = [job['ffmpeg'], '-v', 'error', '-hwaccel', 'auto', '-ss', f'{start:.3f}', '-t', f'{end - start:.3f}', '-i', job['video'], '-an', '-sn', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        # ffmpeg keeps decoding while the frames before are read.
        frames = queue.Queue(maxsize=256)

        def pump():
            while True:
                data = proc.stdout.read(frame_bytes)
                if len(data) < frame_bytes:
                    frames.put(None)
                    return
                frames.put(data)

        threading.Thread(target=pump, daemon=True).start()
        readings = []
        k = 0
        last_report = -1
        while True:
            data = frames.get()
            if data is None:
                break
            frame = np.frombuffer(data, np.uint8).reshape(out_h, out_w, 3)
            t = start + k / fps
            text, conf = read_frame(reader, frame)
            readings.append((t, text, conf))
            k += 1
            pct = int(100 * (done_seconds + k / fps) / total)
            if pct != last_report:
                last_report = pct
                print(f'progress {min(1.0, pct / 100):.2f}', flush=True)
        proc.wait()
        done_seconds += end - start
        lines.extend(l for l in group(readings, fps) if l['start'] < end)
    with open(job['out'], 'w', encoding='utf-8') as f:
        json.dump(lines, f, ensure_ascii=False)
    print(f'ok {len(lines)}', flush=True)


if __name__ == '__main__':
    main()
