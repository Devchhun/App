"""Extract compact acoustic voice embeddings for timestamped speech lines.

This is deliberately a feature extractor, not a gender-based identity guess:
the TypeScript clustering stage groups speakers by these normalized spectral
vectors across the full video. Gender and age are separate, low-confidence
metadata predictions and never participate in clustering.
"""

import argparse
import io
import json
import math
import sys
import threading
import traceback
import wave

import numpy as np

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', errors='replace', newline='\n')
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', newline='\n')

cancel_requested = threading.Event()


class Canceled(Exception):
    pass


def emit(msg_type, **fields):
    sys.stdout.write(json.dumps({'type': msg_type, **fields}, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def control_reader():
    for line in sys.stdin:
        try:
            if json.loads(line).get('action') == 'cancel':
                cancel_requested.set()
        except (json.JSONDecodeError, AttributeError):
            continue


def load_pcm(path):
    with wave.open(path, 'rb') as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())
    if sample_width != 2:
        raise ValueError('Speaker diarization requires 16-bit PCM audio.')
    pcm = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm, sample_rate


def estimate_pitch(frames, sample_rate):
    min_lag = max(1, int(sample_rate / 400))
    max_lag = min(frames.shape[1] - 1, int(sample_rate / 70))
    pitches = []
    for frame in frames[:: max(1, len(frames) // 40)]:
        centered = frame - np.mean(frame)
        energy = float(np.dot(centered, centered))
        if energy < 1e-5:
            continue
        corr = np.correlate(centered, centered, mode='full')[len(centered) - 1:]
        search = corr[min_lag:max_lag + 1]
        if not len(search):
            continue
        lag = int(np.argmax(search)) + min_lag
        if float(corr[lag] / max(corr[0], 1e-9)) >= 0.32:
            pitches.append(sample_rate / lag)
    return float(np.median(pitches)) if pitches else None


def acoustic_embedding(samples, sample_rate):
    frame_size = max(64, int(sample_rate * 0.025))
    hop = max(32, int(sample_rate * 0.010))
    if len(samples) < frame_size:
        samples = np.pad(samples, (0, frame_size - len(samples)))
    starts = np.arange(0, len(samples) - frame_size + 1, hop)
    frames = np.stack([samples[start:start + frame_size] for start in starts])
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    gate = max(float(np.percentile(rms, 35)), float(np.max(rms)) * 0.08, 0.002)
    voiced = frames[rms >= gate]
    voiced_ratio = float(len(voiced) / max(1, len(frames)))
    if len(voiced) == 0:
        return [], None, voiced_ratio, None

    window = np.hanning(frame_size).astype(np.float32)
    fft_size = 1 << int(math.ceil(math.log2(frame_size)))
    spectra = np.abs(np.fft.rfft(voiced * window, n=fft_size, axis=1)) ** 2
    frequencies = np.fft.rfftfreq(fft_size, 1.0 / sample_rate)
    band_edges = np.geomspace(80, min(7600, sample_rate / 2 - 1), 25)
    band_log_energy = []
    for low, high in zip(band_edges[:-1], band_edges[1:]):
        mask = (frequencies >= low) & (frequencies < high)
        energy = np.sum(spectra[:, mask], axis=1) if np.any(mask) else np.zeros(len(voiced))
        band_log_energy.append(np.log1p(energy))
    bands = np.stack(band_log_energy, axis=1)
    mean = np.mean(bands, axis=0)
    mean = (mean - np.mean(mean)) / (np.std(mean) + 1e-6)
    spread = np.std(bands, axis=0)
    spread = (spread - np.mean(spread)) / (np.std(spread) + 1e-6)
    embedding = np.concatenate([mean, spread]).astype(np.float32)
    embedding /= np.linalg.norm(embedding) + 1e-9

    pitch = estimate_pitch(voiced, sample_rate)
    average_spectrum = np.mean(spectra, axis=0)
    centroid = float(np.sum(frequencies * average_spectrum) / max(np.sum(average_spectrum), 1e-9))
    return [round(float(value), 7) for value in embedding], pitch, voiced_ratio, centroid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('args_file')
    args_file = parser.parse_args().args_file
    with open(args_file, 'r', encoding='utf-8') as handle:
        args = json.load(handle)

    threading.Thread(target=control_reader, daemon=True).start()
    pcm, sample_rate = load_pcm(args['audioPath'])
    segments = args.get('segments', [])
    observations = []
    for index, segment in enumerate(segments):
        if cancel_requested.is_set():
            raise Canceled()
        start = max(0, int((float(segment['startTime']) - 0.06) * sample_rate))
        end = min(len(pcm), int((float(segment['endTime']) + 0.06) * sample_rate))
        embedding, pitch, voiced_ratio, centroid = acoustic_embedding(pcm[start:end], sample_rate)
        observations.append({
            'segmentId': segment['id'],
            'embedding': embedding,
            'f0Hz': pitch,
            'voicedRatio': voiced_ratio,
            'spectralCentroidHz': centroid,
        })
        emit('progress', data={'percent': ((index + 1) / max(1, len(segments))) * 100})
    emit('result', data={'observations': observations})


if __name__ == '__main__':
    try:
        main()
    except Canceled:
        emit('error', message='canceled', canceled=True)
        sys.exit(2)
    except Exception as error:
        emit('error', message=str(error), traceback=traceback.format_exc())
        sys.exit(1)
