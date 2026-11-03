"""Voice prints for the Cast window: who is speaking on each subtitle line.

Each line's sound goes through a speaker-recognition network (CAM++, as
ONNX) and comes back as 192 numbers that are close for one person's voice
and far apart for two people's -- unlike the band averages diarize_child.py
makes, which follow the words and the music as much as the speaker (a
50-episode series came out as 700 "speakers"). The grouping itself is done
in TypeScript (shared/castClustering.ts).

Only numpy and onnxruntime: the network's input, Kaldi's "fbank" features,
is computed here.

    python cast_voices_runner.py job.json

job.json: {"model": path, "out": path, "files": [{"wav": path (16 kHz mono
16-bit), "lines": [{"id", "start", "end"}]}]}
Writes {"lines": [{"id", "embedding", "f0", "voiced", "seconds"}]} to "out",
prints "progress <0-1>" lines and "ok <count>" at the end.
"""

import json
import sys
import wave

import numpy as np

RATE = 16000
FRAME = 400  # 25 ms
HOP = 160  # 10 ms
FFT = 512
MELS = 80
# A line shorter than this says too little about a voice: it is read with
# the sound around it, up to this length.
LEAST_SECONDS = 0.8
# Longer than this adds time, not certainty.
MOST_SECONDS = 8.0


def mel_bank():
    """Kaldi's triangular mel filters (20 Hz to the Nyquist frequency)."""
    def mel(f):
        return 1127.0 * np.log(1.0 + f / 700.0)

    low, high = mel(20.0), mel(RATE / 2.0)
    edges = np.linspace(low, high, MELS + 2)
    bins = mel(np.arange(FFT // 2 + 1) * RATE / FFT)
    bank = np.zeros((MELS, FFT // 2 + 1), dtype=np.float32)
    for m in range(MELS):
        left, centre, right = edges[m], edges[m + 1], edges[m + 2]
        up = (bins - left) / (centre - left)
        down = (right - bins) / (right - centre)
        bank[m] = np.maximum(0.0, np.minimum(up, down))
    return bank


BANK = mel_bank()
# Kaldi's "povey" window.
WINDOW = np.power(0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(FRAME) / (FRAME - 1)), 0.85).astype(np.float32)


def fbank(samples):
    """80 log-mel energies per 10 ms, the mean over time taken off each
    (the network was trained on features normalized that way)."""
    if len(samples) < FRAME:
        samples = np.pad(samples, (0, FRAME - len(samples)))
    count = 1 + (len(samples) - FRAME) // HOP
    index = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    frames = samples[index].astype(np.float32)
    frames = frames - frames.mean(axis=1, keepdims=True)
    # Pre-emphasis, each frame on its own (as Kaldi does).
    frames = np.concatenate([frames[:, :1] * (1.0 - 0.97), frames[:, 1:] - 0.97 * frames[:, :-1]], axis=1)
    power = np.abs(np.fft.rfft(frames * WINDOW, n=FFT, axis=1)) ** 2
    feats = np.log(np.maximum(power @ BANK.T, 1.1920929e-07)).astype(np.float32)
    return feats - feats.mean(axis=0, keepdims=True)


def pitch_of(samples):
    """Median pitch (Hz) of the voiced part and how much of the line is
    voiced -- for the male/female guess only, never for who is who."""
    size, hop = 640, 320
    if len(samples) < size:
        return None, 0.0
    peak = float(np.max(np.abs(samples))) or 1.0
    found, frames = [], 0
    for start in range(0, len(samples) - size, hop):
        frame = samples[start:start + size]
        frames += 1
        if float(np.sqrt(np.mean(frame * frame))) < peak * 0.08:
            continue
        frame = frame - frame.mean()
        corr = np.correlate(frame, frame, mode='full')[size - 1:]
        if corr[0] <= 0:
            continue
        low, high = RATE // 400, RATE // 70
        lag = int(np.argmax(corr[low:high])) + low
        if corr[lag] / corr[0] >= 0.45:
            found.append(RATE / lag)
    if not found:
        return None, 0.0
    return float(np.median(found)), len(found) / max(1, frames)


def read_wav(path):
    with wave.open(path, 'rb') as wav:
        if wav.getframerate() != RATE or wav.getsampwidth() != 2:
            raise ValueError('expected 16 kHz 16-bit sound')
        raw = wav.readframes(wav.getnframes())
        channels = wav.getnchannels()
    pcm = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    return pcm.reshape(-1, channels).mean(axis=1) if channels > 1 else pcm


def main():
    import onnxruntime as ort

    with open(sys.argv[1], 'r', encoding='utf-8') as handle:
        job = json.load(handle)
    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(job['model'], sess_options=options, providers=['CPUExecutionProvider'])
    name = session.get_inputs()[0].name
    total = sum(len(f['lines']) for f in job['files']) or 1
    done = 0
    out = []
    for item in job['files']:
        try:
            pcm = read_wav(item['wav'])
        except Exception as error:  # one unreadable file: its lines go without a voice print
            sys.stderr.write('%s: %s\n' % (item['wav'], error))
            done += len(item['lines'])
            continue
        for line in item['lines']:
            start, end = float(line['start']), float(line['end'])
            seconds = max(0.0, end - start)
            # A short line borrows the sound around it; a long one gives its middle.
            want = min(MOST_SECONDS, max(LEAST_SECONDS, seconds))
            middle = (start + end) / 2.0
            a = max(0, int((middle - want / 2.0) * RATE))
            b = min(len(pcm), a + int(want * RATE))
            piece = pcm[a:b]
            done += 1
            if len(piece) < RATE * 0.3 or float(np.max(np.abs(piece))) < 0.01:
                continue
            embedding = session.run(None, {name: fbank(piece)[None, :, :]})[0][0]
            norm = float(np.linalg.norm(embedding))
            if not np.isfinite(norm) or norm < 1e-6:
                continue
            f0, voiced = pitch_of(pcm[max(0, int(start * RATE)):min(len(pcm), int(end * RATE))])
            out.append({
                'id': line['id'],
                'embedding': [round(float(v), 5) for v in embedding / norm],
                'f0': None if f0 is None else round(f0, 1),
                'voiced': round(voiced, 3),
                'seconds': round(seconds, 3)
            })
            if done % 20 == 0:
                print('progress %.4f' % (done / total), flush=True)
    with open(job['out'], 'w', encoding='utf-8') as handle:
        json.dump({'lines': out}, handle)
    print('ok %d' % len(out), flush=True)


if __name__ == '__main__':
    main()
