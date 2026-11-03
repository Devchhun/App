"""Auto Reframe: where the people are in a video, a few times a second.

ffmpeg (its path comes in the job) decodes the video at `fps` frames a
second straight into 640x480 RGB frames, the picture fitted inside black
bars -- the size the face finder (Ultra-Light RFB-640, ONNX, the same one
the Cast window uses) reads. Each frame's sure faces are written as
fractions of the PICTURE (not the padded frame), so the plan made from
them does not depend on the video's shape.

Only numpy and onnxruntime.

    python reframe_runner.py job.json

job.json: {"model", "ffmpeg", "path", "start", "end", "fps", "out"}
Writes {"samples": [{"t": seconds in the file, "faces": [[cx, cy, w, score]]}]}
to "out"; prints "progress <0-1>" lines and "ok <count>".
"""

import json
import subprocess
import sys

import numpy as np

WIDTH, HEIGHT = 640, 480
SURE = 0.8
# Narrower than this share of the picture: somebody far in the background.
LEAST_FACE = 0.03


def picture_bounds(frame):
    """Where the picture is inside its black bars: (x0, y0, x1, y1)."""
    lit = frame.max(axis=2) > 12
    cols = np.nonzero(lit.mean(axis=0) > 0.02)[0]
    rows = np.nonzero(lit.mean(axis=1) > 0.02)[0]
    if len(cols) < 16 or len(rows) < 16:
        return 0, 0, WIDTH, HEIGHT
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def keep_apart(boxes, scores, overlap=0.3):
    """The surest of each bunch of overlapping detections."""
    order = np.argsort(-scores)
    kept = []
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    while len(order):
        i = order[0]
        kept.append(i)
        rest = order[1:]
        if not len(rest):
            break
        x0 = np.maximum(boxes[i, 0], boxes[rest, 0])
        y0 = np.maximum(boxes[i, 1], boxes[rest, 1])
        x1 = np.minimum(boxes[i, 2], boxes[rest, 2])
        y1 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
        iou = inter / (area[i] + area[rest] - inter + 1e-9)
        order = rest[iou < overlap]
    return kept


def main():
    import onnxruntime as ort

    with open(sys.argv[1], 'r', encoding='utf-8') as handle:
        job = json.load(handle)
    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(job['model'], sess_options=options, providers=['CPUExecutionProvider'])
    name = session.get_inputs()[0].name
    fps = float(job.get('fps', 2))
    start = float(job.get('start', 0))
    end = float(job['end'])
    length = max(0.001, end - start)
    vf = 'fps=%g,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black' % (fps, WIDTH, HEIGHT, WIDTH, HEIGHT)
    args = [job['ffmpeg'], '-v', 'error', '-ss', '%.3f' % start, '-t', '%.3f' % length, '-i', job['path'], '-an', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    creation = 0x08000000 if sys.platform == 'win32' else 0  # no console window
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=creation)
    size = WIDTH * HEIGHT * 3
    samples = []
    bounds = None
    index = 0
    expected = max(1, int(length * fps))
    while True:
        raw = proc.stdout.read(size)
        if not raw or len(raw) < size:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(HEIGHT, WIDTH, 3)
        if bounds is None or index % 20 == 0:
            bounds = picture_bounds(frame)
        px0, py0, px1, py1 = bounds
        pw, ph = max(1, px1 - px0), max(1, py1 - py0)
        tensor = ((frame.astype(np.float32) - 127.0) / 128.0).transpose(2, 0, 1)[None]
        scores, boxes = session.run(None, {name: tensor})
        scores, boxes = scores[0][:, 1], boxes[0]
        faces = []
        sure = scores >= SURE
        if np.any(sure):
            found = boxes[sure] * np.array([WIDTH, HEIGHT, WIDTH, HEIGHT], dtype=np.float32)
            found_scores = scores[sure]
            for i in keep_apart(found, found_scores):
                x0, y0, x1, y1 = (float(v) for v in found[i])
                w = (x1 - x0) / pw
                if w < LEAST_FACE:
                    continue
                cx = ((x0 + x1) / 2.0 - px0) / pw
                cy = ((y0 + y1) / 2.0 - py0) / ph
                if -0.05 <= cx <= 1.05 and -0.05 <= cy <= 1.05:
                    faces.append([round(cx, 4), round(cy, 4), round(w, 4), round(float(found_scores[i]), 3)])
        samples.append({'t': round(start + index / fps, 3), 'faces': faces})
        index += 1
        if index % 5 == 0:
            print('progress %.4f' % min(1.0, index / expected), flush=True)
    proc.wait()
    with open(job['out'], 'w', encoding='utf-8') as handle:
        json.dump({'samples': samples, 'fps': fps}, handle)
    print('ok %d' % len(samples), flush=True)


if __name__ == '__main__':
    main()
