"""Remove Background: the foreground mask of one picture.

Runs IS-Net (isnet-general-use, the rembg model) with onnxruntime on the
app's bundled Python -- numpy and onnxruntime only. ffmpeg does the image
work around it (app/main/media/removeBackground.ts): it hands this script
the picture already stretched to SIZE x SIZE as raw RGB bytes, and puts the
mask written here back over the picture as its alpha.

  python remove_bg_runner.py MODEL.onnx INPUT.rgb OUTPUT.gray SIZE

Prints one line, "ok <seconds>", when done; anything else is an error.
"""
import sys
import time

import numpy as np
import onnxruntime as ort


def main() -> int:
    model_path, input_path, output_path, size_text = sys.argv[1:5]
    size = int(size_text)
    started = time.time()
    rgb = np.fromfile(input_path, dtype=np.uint8)
    if rgb.size != size * size * 3:
        print(f'error: expected {size * size * 3} bytes of RGB, got {rgb.size}')
        return 2
    image = rgb.reshape(size, size, 3).astype(np.float32)
    # As rembg prepares IS-Net's input: scaled by the brightest value,
    # centred on 0.5, channels first.
    image = image / max(float(image.max()), 1e-6)
    image = (image - 0.5) / 1.0
    batch = np.ascontiguousarray(image.transpose(2, 0, 1)[np.newaxis, ...], dtype=np.float32)

    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(model_path, sess_options=options, providers=['CPUExecutionProvider'])
    prediction = session.run(None, {session.get_inputs()[0].name: batch})[0][0, 0]

    low, high = float(prediction.min()), float(prediction.max())
    mask = (prediction - low) / max(high - low, 1e-6)
    (np.clip(mask, 0, 1) * 255).astype(np.uint8).tofile(output_path)
    print(f'ok {time.time() - started:.2f}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
