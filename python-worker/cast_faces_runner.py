"""Faces for the Cast window: where the face is in a video frame.

Each frame comes in as raw RGB, 1280x960 with the picture fitted inside
(black bars around it). Faces are found by a small detector (Ultra-Light
RFB-640, as ONNX) on the frame at half size; the answer is the square to
cut out for a portrait -- the biggest sure face with room for hair and
shoulders, or the middle of the picture when no face is found (marked as
such). The cutting and saving is done by ffmpeg, from the same frame.

Only numpy and onnxruntime.

    python cast_faces_runner.py job.json

job.json: {"model": path, "out": path, "frames": [{"id", "rgb": path}]}
Writes {"frames": [{"id", "left", "top", "side", "face", "score", "size"}]}
to "out" (pixels of the 1280x960 frame; "size": the face's width as a share
of the picture's); prints "progress <0-1>" lines and "ok <count>".
"""

import json
import sys

import numpy as np

WIDTH, HEIGHT = 1280, 960
# A detection surer than this is a face.
SURE = 0.82
# A face narrower than this share of the picture is somebody in the
# background (or a mistake), not the person the shot is of.
LEAST_FACE = 0.045


def picture_bounds(frame):
    """Where the picture is inside its black bars: (x0, y0, x1, y1)."""
    lit = frame.max(axis=2) > 12
    cols = np.nonzero(lit.mean(axis=0) > 0.02)[0]
    rows = np.nonzero(lit.mean(axis=1) > 0.02)[0]
    if len(cols) < 16 or len(rows) < 16:
        return 0, 0, WIDTH, HEIGHT
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def box_area(boxes):
    return (boxes[..., 2] - boxes[..., 0]) * (boxes[..., 3] - boxes[..., 1])


def keep_apart(boxes, scores, overlap=0.3):
    """The surest of each bunch of overlapping detections."""
    order = np.argsort(-scores)
    kept = []
    while len(order):
        i = order[0]
        kept.append(i)
        if len(order) == 1:
            break
        rest = order[1:]
        x0 = np.maximum(boxes[i, 0], boxes[rest, 0])
        y0 = np.maximum(boxes[i, 1], boxes[rest, 1])
        x1 = np.minimum(boxes[i, 2], boxes[rest, 2])
        y1 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
        iou = inter / (box_area(boxes[i]) + box_area(boxes[rest]) - inter + 1e-9)
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
    out = []
    total = len(job['frames']) or 1
    for index, item in enumerate(job['frames']):
        try:
            frame = np.fromfile(item['rgb'], dtype=np.uint8).reshape(HEIGHT, WIDTH, 3)
        except Exception:
            continue
        # Half size for the detector (each pixel the mean of four).
        half = frame.reshape(HEIGHT // 2, 2, WIDTH // 2, 2, 3).mean(axis=(1, 3))
        tensor = ((half - 127.0) / 128.0).transpose(2, 0, 1)[None].astype(np.float32)
        scores, boxes = session.run(None, {name: tensor})
        scores, boxes = scores[0][:, 1], boxes[0]
        px0, py0, px1, py1 = picture_bounds(frame)
        faces = []
        sure = scores >= SURE
        if np.any(sure):
            found = boxes[sure] * np.array([WIDTH, HEIGHT, WIDTH, HEIGHT], dtype=np.float32)
            found_scores = scores[sure]
            for i in keep_apart(found, found_scores):
                x0, y0, x1, y1 = found[i]
                if (x1 - x0) < (px1 - px0) * LEAST_FACE:
                    continue
                faces.append((float((x1 - x0) * (y1 - y0)), float(found_scores[i]), float(x0), float(y0), float(x1), float(y1)))
        faces.sort(reverse=True)
        if faces:
            _area, score, x0, y0, x1, y1 = faces[0]
            # Hair above, shoulders below: twice the face, a little lower than its middle.
            side = max(x1 - x0, y1 - y0) * 2.1
            cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0 + (y1 - y0) * 0.12
            size = (x1 - x0) / max(1, px1 - px0)
        else:
            score, size = 0.0, 0.0
            side = float(min(px1 - px0, py1 - py0))
            cx, cy = (px0 + px1) / 2.0, (py0 + py1) / 2.0
        side = int(min(side, px1 - px0, py1 - py0))
        if side >= 24:
            left = int(round(min(max(cx - side / 2.0, px0), px1 - side)))
            top = int(round(min(max(cy - side / 2.0, py0), py1 - side)))
            out.append({'id': item['id'], 'left': left, 'top': top, 'side': side, 'face': bool(faces), 'score': round(score, 3), 'size': round(size, 3)})
        print('progress %.4f' % ((index + 1) / total), flush=True)
    with open(job['out'], 'w', encoding='utf-8') as handle:
        json.dump({'frames': out}, handle)
    print('ok %d' % len(out), flush=True)


if __name__ == '__main__':
    main()
