"""Seeded VoxCPM2 batch synthesis.

Why this exists rather than just calling `python -m voxcpm.cli batch`:
VoxCPM2's own CLI exposes no `--seed`, and its model SAMPLES a speaker
identity per utterance. Two lines generated back to back with identical
settings therefore come out as two subtly different people -- across a
200-line script that reads as one character constantly changing voice.

Pinning the RNG before every single line is the only way to make the
sampling reproducible, and the RNG is only reachable from inside Python, so
the batch loop has to live here instead of in the stock CLI. Everything else
is deliberately identical to `voxcpm.cli batch`'s own cmd_batch:

  * same output naming (`output_001.wav`, `output_002.wav`, ...)
  * same stderr protocol (`Saved: <path> (<n>s)` / `Failed on line N: <err>`)

so the Node side (voxcpmTts.ts's runVoxCpmBatch) parses this exactly as it
already parses the stock CLI, and can fall back to that CLI unchanged.

Re-seeding per LINE rather than once per batch is intentional: seeding once
would leave every line after the first drawing from a stream whose position
depends on how much sampling the previous lines happened to consume, so a
single edited subtitle would shift the voice of every line after it.
"""

import argparse
import os
import random
import sys


def parse_args():
    parser = argparse.ArgumentParser(description="Seeded VoxCPM2 batch synthesis")
    parser.add_argument("--input", required=True, help="Text file, one line per output")
    parser.add_argument("--output-dir", required=True, help="Directory for output_NNN.wav")
    parser.add_argument("--model-path", required=True, help="Local VoxCPM2 model directory")
    parser.add_argument("--seed", type=int, required=True, help="Fixed RNG seed for this voice")
    parser.add_argument("--control", default=None, help="Voice-design / voice-lock instruction")
    parser.add_argument("--reference-audio", default=None, help="Reference clip to clone the timbre from")
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda, or cuda:N")
    parser.add_argument("--cfg-value", type=float, default=2.0)
    parser.add_argument("--inference-timesteps", type=int, default=10)
    parser.add_argument(
        "--match-threshold",
        type=float,
        default=0.0,
        help="Speaker similarity (0-1) a line must reach against --reference-audio; 0 disables the check",
    )
    parser.add_argument("--match-retries", type=int, default=0, help="Extra attempts with other seeds for a line under the threshold")
    parser.add_argument(
        "--pitch-tolerance",
        type=float,
        default=0.0,
        help="Semitones a line's median pitch may sit from --reference-audio's before it counts as the wrong voice; 0 disables the check",
    )
    return parser.parse_args()


def seed_everything(seed):
    """Pin every RNG the model can draw from, so the sampled speaker identity
    is reproducible. torch is imported lazily by the caller before this runs."""
    import numpy as np
    import torch

    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def line_seed(seed, attempt):
    """Attempt 0 is the voice's own seed, so a line that passes first time
    is byte-identical to what it always was. Later attempts step by a prime
    large enough that no voice's retry seed collides with another voice's
    base seed (voiceSeedFor spaces those within 1000..901000)."""
    return seed + attempt * 1_000_003


class VoiceMatcher(object):
    """Scores how much a generated line sounds like the reference speaker.

    VoxCPM2's reference-audio cloning fixes WHO is speaking only loosely --
    it re-samples a speaker identity per line, and on short lines that
    sample can land on someone else entirely. Measured on a real project
    with a d-vector speaker encoder (resemblyzer): same speaker scores
    0.85+, a different one ~0.65, and one character's generated lines were
    scattered 0.55-0.82 against her own recording. Generating a low-scoring
    line again with another seed and keeping the closest attempt lifted the
    worst line from 0.64 to 0.77 and the mean from 0.76 to 0.82 -- the only
    change in this whole area that measured better rather than worse.

    Best-effort by design: if the encoder isn't installed (first run with no
    internet) every line is accepted as-is, exactly as before this existed.
    """

    def __init__(self, reference_path):
        from resemblyzer import VoiceEncoder, preprocess_wav

        self._preprocess = preprocess_wav
        self._encoder = VoiceEncoder(verbose=False)
        self._reference = self._encoder.embed_utterance(preprocess_wav(reference_path))

    def similarity(self, audio, sample_rate):
        import numpy as np

        wav = self._preprocess(np.asarray(audio, dtype=np.float32), source_sr=sample_rate)
        if len(wav) < 1600:  # under 0.1s of speech survives the VAD -- nothing to compare
            return 1.0
        return float(np.dot(self._reference, self._encoder.embed_utterance(wav)))


def median_f0(audio, sample_rate, fmin=70.0, fmax=400.0):
    """Median fundamental frequency (Hz) of the voiced frames of `audio`, or
    None when too little is voiced to say. Plain numpy: 40 ms frames every
    10 ms, normalised autocorrelation, the strongest peak inside the speech
    range, kept only when it is clear (> 0.6) and the frame has energy.
    Good enough to tell 148 Hz from 211 Hz -- which is the whole question
    here (did the model sample the same speaker) -- not a contour tracker."""
    import numpy as np

    x = np.asarray(audio, dtype=np.float32).flatten()
    if len(x) < sample_rate // 5:
        return None
    x = x - np.mean(x)
    frame = int(sample_rate * 0.04)
    hop = int(sample_rate * 0.01)
    lag_min = int(sample_rate / fmax)
    lag_max = int(sample_rate / fmin)
    if lag_max >= frame:
        return None
    energy_floor = 0.1 * np.sqrt(np.mean(x * x)) + 1e-6
    window = np.hanning(frame).astype(np.float32)
    f0s = []
    for start in range(0, len(x) - frame, hop):
        seg = x[start : start + frame]
        rms = np.sqrt(np.mean(seg * seg))
        if rms < energy_floor:
            continue
        seg = seg * window
        spec = np.fft.rfft(seg, n=2 * frame)
        ac = np.fft.irfft(spec * np.conj(spec))[:frame]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        lag = lag_min + int(np.argmax(ac[lag_min:lag_max]))
        if ac[lag] < 0.6:
            continue
        # Prefer the lowest lag whose peak is nearly as strong (octave errors
        # otherwise land on the first harmonic).
        for cand in range(lag_min, lag):
            if ac[cand] >= 0.9 * ac[lag] and (cand == lag_min or ac[cand] >= ac[cand - 1]) and ac[cand] >= ac[cand + 1]:
                lag = cand
                break
        f0s.append(sample_rate / lag)
    if len(f0s) < 10:
        return None
    return float(np.median(f0s))


def semitones_between(f0, reference_f0):
    import math

    return 12.0 * math.log(f0 / reference_f0, 2)


def make_matcher(reference, threshold):
    if not reference or threshold <= 0:
        return None
    try:
        return VoiceMatcher(reference)
    except Exception as err:  # noqa: BLE001 -- missing package, bad clip: run unmatched rather than not at all
        print("Voice match check unavailable ({}) -- lines are kept as generated.".format(err), file=sys.stderr)
        return None


def build_final_text(text, control):
    """Byte-for-byte the same shape voxcpm.cli's own build_final_text produces,
    so a line generated here is identical to one generated by the stock CLI
    given the same seed."""
    control = (control or "").strip()
    return "({}){}".format(control, text) if control else text


def is_out_of_memory(err):
    """True for the various shapes a CUDA/host allocation failure arrives in.
    Matched on the message because torch raises plain RuntimeError for most
    of them, with no dedicated exception type to catch."""
    text = "{}".format(err).lower()
    return "out of memory" in text or "cuda error" in text or "cublas" in text or "alloc" in text


def load_model(model_path, device):
    from voxcpm import VoxCPM

    return VoxCPM.from_pretrained(
        hf_model_id=model_path,
        local_files_only=True,
        # The denoiser is a whole separate model (ZipEnhancer) and only ever
        # does anything for prompt/reference enhancement, which this app never
        # asks for. On a 6GB card it is pure waste.
        load_denoiser=False,
        # torch.compile buys nothing here (triton isn't installed in the
        # portable runtime, so it is skipped anyway) and its tracing costs
        # extra memory on the first call.
        optimize=False,
        device=None if device == "auto" else device,
    )


def free_model(model):
    """Drop a loaded model and hand its VRAM straight back, rather than
    waiting for Python's GC to get round to it -- on a 6GB card the CPU
    reload that follows needs that memory released NOW."""
    import gc

    import torch

    try:
        del model
    except Exception:  # noqa: BLE001
        pass
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def main():
    args = parse_args()

    with open(args.input, "r", encoding="utf-8") as handle:
        texts = [line.strip() for line in handle if line.strip()]

    if not texts:
        sys.exit("Error: Input file is empty")

    os.makedirs(args.output_dir, exist_ok=True)

    import soundfile as sf
    import torch

    device = args.device
    model = load_model(args.model_path, device)

    reference = args.reference_audio if args.reference_audio and os.path.isfile(args.reference_audio) else None
    on_cpu = device == "cpu"

    matcher = make_matcher(reference, args.match_threshold)

    # Pitch match: the model re-samples a speaker per line, and the clearest
    # sign of a different speaker is a different baseline pitch (148 Hz one
    # line, 211 Hz the next). With a tolerance set, a line whose median pitch
    # sits further than that from the reference's counts as the wrong voice
    # and is tried again like a low-similarity one; the kept attempt is the
    # best by similarity minus a small pitch penalty. Every saved line also
    # gets a `.pitch.json` beside it so the app can nudge the remaining
    # difference away with a small formant-preserving shift.
    reference_f0 = None
    if reference and args.pitch_tolerance > 0:
        try:
            ref_audio, ref_sr = sf.read(reference)
            if getattr(ref_audio, "ndim", 1) > 1:
                ref_audio = ref_audio.mean(axis=1)
            reference_f0 = median_f0(ref_audio, ref_sr)
            print("Pitch: reference {} Hz".format("%.1f" % reference_f0 if reference_f0 else "unknown"), file=sys.stderr)
        except Exception as err:  # noqa: BLE001 -- no pitch check beats no batch
            print("Pitch check unavailable ({}) -- lines are kept as generated.".format(err), file=sys.stderr)
    attempts_per_line = 1 + max(0, args.match_retries) if (matcher or reference_f0) else 1

    success = 0
    for index, text in enumerate(texts, 1):
        output_file = os.path.join(args.output_dir, "output_{:03d}.wav".format(index))
        best_audio = None
        best_score = -1.0
        best_f0 = None
        failed = False
        for attempt in range(attempts_per_line):
            audio = None
            for oom_try in (1, 2):
                try:
                    # The whole point of this script -- see the module docstring.
                    seed_everything(line_seed(args.seed, attempt))
                    audio = model.generate(
                        text=build_final_text(text, args.control),
                        reference_wav_path=reference,
                        cfg_value=args.cfg_value,
                        inference_timesteps=args.inference_timesteps,
                    )
                    break
                except Exception as err:  # noqa: BLE001 -- one bad line must not kill the batch
                    # A 6GB card can run out of VRAM part-way through a script
                    # (longer line, fragmented memory) even though earlier lines
                    # were fine. Falling back to CPU keeps the run going -- slower,
                    # but it finishes, which beats every remaining line failing.
                    if oom_try == 1 and not on_cpu and is_out_of_memory(err):
                        print("VRAM exhausted on line {} -- retrying on CPU for the rest of this batch.".format(index), file=sys.stderr)
                        free_model(model)
                        on_cpu = True
                        model = load_model(args.model_path, "cpu")
                        continue
                    print("Failed on line {}: {}".format(index, err), file=sys.stderr)
                    failed = True
                    break
            if failed or audio is None:
                break
            if matcher is None and reference_f0 is None:
                best_audio = audio
                break
            similarity = matcher.similarity(audio, model.tts_model.sample_rate) if matcher else 1.0
            f0 = median_f0(audio, model.tts_model.sample_rate) if reference_f0 else None
            drift = abs(semitones_between(f0, reference_f0)) if f0 else 0.0
            score = similarity - 0.03 * drift
            # Not part of the Saved/Failed protocol the Node side parses --
            # informational, and it keeps the stall watchdog fed while a
            # retried line takes several generations' worth of time.
            print(
                "Match: line {} attempt {} similarity {:.3f} pitch {} drift {:.2f}st".format(
                    index, attempt + 1, similarity, "%.1fHz" % f0 if f0 else "?", drift
                ),
                file=sys.stderr,
            )
            if score > best_score:
                best_audio, best_score, best_f0 = audio, score, f0
            similar_enough = matcher is None or similarity >= args.match_threshold
            pitch_close_enough = reference_f0 is None or f0 is None or drift <= args.pitch_tolerance
            if similar_enough and pitch_close_enough:
                break

        if best_audio is not None:
            sf.write(output_file, best_audio, model.tts_model.sample_rate)
            if reference_f0 and best_f0:
                import json

                with open(output_file[:-4] + ".pitch.json", "w", encoding="utf-8") as sidecar:
                    json.dump({"f0": best_f0, "referenceF0": reference_f0, "semitones": semitones_between(best_f0, reference_f0)}, sidecar)
            duration = len(best_audio) / model.tts_model.sample_rate
            print("Saved: {} ({:.2f}s)".format(output_file, duration), file=sys.stderr)
            success += 1

        # Fragmentation, not total size, is what usually sinks a small card
        # part-way through a long script -- returning each line's scratch
        # memory keeps the next one from tipping over.
        if not on_cpu and torch.cuda.is_available():
            torch.cuda.empty_cache()

    print("\nBatch finished: {}/{} succeeded".format(success, len(texts)), file=sys.stderr)


if __name__ == "__main__":
    main()
