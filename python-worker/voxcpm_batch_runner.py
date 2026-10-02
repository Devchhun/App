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

    def halves(self, audio, sample_rate):
        """Does the voice stay ONE person through the take? Returns
        (first half vs second half, the weaker half vs the reference), or
        None when there is too little speech to split (< 1.6 s).

        Measured on 72 takes of this model: the two halves of a take
        normally agree at 0.75-0.9 (median 0.82); the takes that changed
        voice part-way -- a whisper that slid into another timbre, a crying
        line that jumped +5.7 st -- fell to 0.68-0.73. A whole-take score
        averages that away, so it has to be checked on the halves."""
        import numpy as np

        wav = self._preprocess(np.asarray(audio, dtype=np.float32), source_sr=sample_rate)
        if len(wav) < int(16000 * 1.6):
            return None
        mid = len(wav) // 2
        a = self._encoder.embed_utterance(wav[:mid])
        b = self._encoder.embed_utterance(wav[mid:])
        return float(np.dot(a, b)), min(float(np.dot(self._reference, a)), float(np.dot(self._reference, b)))


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


def performance_metrics(audio, sample_rate):
    """How much a take MOVES -- the difference between acted and read.

    f0_var_st     spread (std, semitones) of the voiced pitch contour: a
                  read-out line sits in a narrow band, an angry or shocked
                  one swings.
    energy_var_db spread (std, dB) of the loudness of the speech frames.
    voiced_ratio  share of speech frames with a clear pitch (a whisper has
                  almost none -- that is not a fault).
    pause_ratio   share of the take between its first and last speech frame
                  that is silence.
    clipped       share of samples at full scale.
    Plain numpy, same frame layout as median_f0 (40 ms / 10 ms)."""
    import numpy as np

    x = np.asarray(audio, dtype=np.float32).flatten()
    out = {"f0_var_st": None, "energy_var_db": None, "voiced_ratio": 0.0, "pause_ratio": 0.0, "clipped": 0.0, "median_f0": None, "speech_db": None}
    if len(x) < sample_rate // 5:
        return out
    out["clipped"] = float(np.mean(np.abs(x) >= 0.99))
    x = x - np.mean(x)
    frame = int(sample_rate * 0.04)
    hop = int(sample_rate * 0.01)
    lag_min = int(sample_rate / 400.0)
    lag_max = int(sample_rate / 70.0)
    window = np.hanning(frame).astype(np.float32)
    rms_all = []
    starts = list(range(0, len(x) - frame, hop))
    for start in starts:
        seg = x[start : start + frame]
        rms_all.append(float(np.sqrt(np.mean(seg * seg)) + 1e-9))
    if not rms_all:
        return out
    rms_all = np.asarray(rms_all)
    db = 20.0 * np.log10(rms_all)
    # Speech = frames well above the quiet floor, but never a bar above the
    # loudest frames themselves (a take at one steady level -- a held vowel,
    # heavily compressed audio -- would otherwise count as no speech at all).
    loudest = float(np.max(db))
    speech_floor = max(loudest - 35.0, min(float(np.percentile(db, 20)) + 6.0, loudest - 6.0))
    speech = db >= speech_floor
    if not np.any(speech):
        return out
    first, last = int(np.argmax(speech)), int(len(speech) - 1 - np.argmax(speech[::-1]))
    inner = speech[first : last + 1]
    out["pause_ratio"] = float(1.0 - np.mean(inner)) if len(inner) else 0.0
    out["energy_var_db"] = float(np.std(db[speech]))
    # Mean level of the speech itself (dBFS) -- how hard the take was
    # voiced, before post-processing levels it.
    out["speech_db"] = float(np.mean(db[speech]))
    f0s = []
    voiced = 0
    for i, start in enumerate(starts):
        if not speech[i]:
            continue
        seg = x[start : start + frame] * window
        spec = np.fft.rfft(seg, n=2 * frame)
        ac = np.fft.irfft(spec * np.conj(spec))[:frame]
        if ac[0] <= 0 or lag_max >= frame:
            continue
        ac = ac / ac[0]
        lag = lag_min + int(np.argmax(ac[lag_min:lag_max]))
        if ac[lag] < 0.6:
            continue
        for cand in range(lag_min, lag):
            if ac[cand] >= 0.9 * ac[lag] and (cand == lag_min or ac[cand] >= ac[cand - 1]) and ac[cand] >= ac[cand + 1]:
                lag = cand
                break
        voiced += 1
        f0s.append(sample_rate / lag)
    out["voiced_ratio"] = float(voiced / max(1, int(np.sum(speech))))
    if len(f0s) >= 10:
        st = 12.0 * np.log2(np.asarray(f0s) / np.median(f0s))
        # Octave errors look like huge swings; clip them out of the spread.
        st = st[np.abs(st) < 9.0]
        out["f0_var_st"] = float(np.std(st)) if len(st) >= 10 else None
        out["median_f0"] = float(np.median(f0s))
    return out


_KHMER_COENG = "\u17d2"


def estimate_syllables(text):
    """Roughly how many syllables a line has -- enough to tell a one-word
    line from a sentence. Khmer: every consonant or independent vowel that
    does not follow a COENG (a subscript consonant belongs to the syllable
    before it). CJK: one per character. Anything else: vowel groups."""
    import re

    count = 0
    previous = ""
    for ch in text:
        code = ord(ch)
        if 0x1780 <= code <= 0x17B3 and previous != _KHMER_COENG:
            count += 1
        elif 0x4E00 <= code <= 0x9FFF:
            count += 1
        previous = ch
    count += len(re.findall(r"[aeiouy]+", re.sub(r"[^A-Za-z ]", " ", text).lower()))
    return max(1, count)


def max_plausible_seconds(text):
    """The longest a take of `text` can reasonably be. Past this a short line
    was not read, it was dragged out or padded with extra sound -- what made
    one-word lines come out unclear (measured: "អូ!" as 1.2 s of sound)."""
    syllables = estimate_syllables(text)
    return max(1.4, 0.55 * syllables + 0.9)


SHORT_LINE_SYLLABLES = 4


def trim_after_first_utterance(audio, sample_rate, text):
    """A short line (a word or two) keeps only its first utterance. On a
    one-word line VoxCPM2 often says the word, goes quiet, then makes a
    second sound nobody asked for -- measured on "បាទ", "អូ!", "ឈប់!": word,
    0.5-0.7 s of silence, then another burst. That ghost is what made short
    lines sound unclear. Longer lines are never touched (their pauses are
    real). A longer line is cut only when it runs past the longest it could
    take to say (max_plausible_seconds): the sound after its last real pause
    before that point is babble too (measured: 11 s takes of 1-2 s lines).
    Returns (audio, seconds cut)."""
    import numpy as np

    if not text:
        return audio, 0.0
    short = estimate_syllables(text) <= SHORT_LINE_SYLLABLES
    if not short and len(audio) / sample_rate <= max_plausible_seconds(text):
        return audio, 0.0
    x = np.asarray(audio, dtype=np.float32)
    frame = max(1, int(sample_rate * 0.02))
    n = len(x) // frame
    if n < 5:
        return audio, 0.0
    levels = np.array([20 * np.log10(np.sqrt(np.mean(x[i * frame:(i + 1) * frame] ** 2)) + 1e-9) for i in range(n)])
    voiced = levels > (levels.max() - 32)
    # Speech runs, bridging gaps shorter than 0.25 s (inside the word).
    bridge = int(0.25 / 0.02)
    runs = []
    i = 0
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        start = i
        end = i
        j = i + 1
        while j < n:
            if voiced[j]:
                end = j
                j += 1
            elif j - end <= bridge:
                j += 1
            else:
                break
        runs.append((start, end))
        i = end + 1
    if short:
        # The first run long enough to be speech (not a click); anything
        # after it that starts past a real gap is the ghost.
        keep = next((r for r in runs if (r[1] - r[0] + 1) * 0.02 >= 0.1), None)
        if keep is None or keep is runs[-1]:
            return audio, 0.0
    else:
        # Every run that starts inside the plausible length stays; the
        # rest is the babble.
        limit = max_plausible_seconds(text) / 0.02
        inside = [r for r in runs if r[0] < limit]
        if not inside or len(inside) == len(runs):
            return audio, 0.0
        keep = inside[-1]
    cut = min(len(x), (keep[1] + 1) * frame + int(sample_rate * 0.1))
    return x[:cut], round((len(x) - cut) / sample_rate, 2)


def score_take(profile, similarity, shift, metrics, duration, slot_seconds, halves=None, text=None):
    """Emotion-aware score and verdict for one take of one line.

    Returns (score, verdict). Identity is still the biggest part of the
    score -- the voice must stay the character's -- but an expressive line
    is no longer judged by how close its pitch stays to a neutral reference,
    and a strongly-acted line that came out flat is retried.

    What "acted" means was measured on this model (18 takes, same voice,
    angry/whisper, 3 seeds each): the clearest sign of an angry, shouted,
    excited or shocked delivery is the take's median pitch RAISED above the
    reference voice's (+2..+8 st on acted takes, around 0 on flat ones);
    a whisper shows as a low voiced share (0.45 vs 0.6+ when it was just
    spoken quietly). Frame-energy spread did not separate them, so it is
    reported but not judged.

    shift  signed semitones of this take's median pitch from the reference's
           (None without a reference or without enough voiced pitch).
    halves (first-half vs second-half similarity, weaker half vs the
           reference) from VoiceMatcher.halves, or None.

    Identity comes first: a take is only "identity-ok" when the whole take,
    each half and the pitch all stay inside the character's voice (the
    pitch limit per emotion -- measured: similarity to the voice fell from
    0.90 at 0-4 st of shift to 0.87 at 4-6 st and 0.83 beyond). Among
    retries, an identity-ok take always beats one that is more expressive
    but drifted (see pick_best)."""
    emotion = profile.get("emotion", "neutral")
    use_pitch = profile.get("usePitch", True)
    floor = float(profile.get("similarityFloor", 0.8))
    tolerance = profile.get("pitchToleranceSemitones")
    expression_kind = profile.get("expression", "none")
    target_raise = profile.get("targetRaiseSt")
    flat_check = bool(profile.get("flatCheck", False))

    identity = 1.0 if similarity is None else max(0.0, min(1.0, similarity))
    drift = abs(shift) if shift is not None else None

    flat = False
    if expression_kind == "raise" and target_raise:
        if shift is not None:
            expression = max(0.0, min(1.0, shift / float(target_raise)))
        else:
            # No reference pitch to compare with: fall back to how much the
            # take's own pitch moves.
            pv = metrics.get("f0_var_st")
            expression = 0.5 if pv is None else max(0.0, min(1.0, pv / 5.0))
        flat = flat_check and expression < 0.5
    elif expression_kind == "whisper":
        voiced = metrics.get("voiced_ratio", 1.0)
        expression = max(0.0, min(1.0, (0.72 - voiced) / 0.3))
        flat = flat_check and voiced >= 0.6
    else:
        # Neutral / calm / sad / crying / fear: judged on nothing but not
        # swinging wildly -- a calm line is allowed to be calm.
        swing = metrics.get("f0_var_st") if use_pitch else None
        expression = 1.0 if (swing is None or swing <= 5.5) else max(0.5, 1.0 - (swing - 5.5) * 0.1)

    # Naturalness (heuristic, not a trained model): voice actually present,
    # no dead air inside the line. A whisper is allowed to be unvoiced;
    # crying/fear are allowed to shake.
    naturalness = 1.0
    if use_pitch and metrics.get("voiced_ratio", 1.0) < 0.35:
        naturalness -= 0.3
    pause = metrics.get("pause_ratio", 0.0)
    if pause > 0.45:
        naturalness -= min(0.4, (pause - 0.45) * 1.5)
    naturalness = max(0.0, naturalness)

    # Timing: past 1.28x of its slot a take can no longer be fitted without
    # sounding rushed (voxcpmTts.ts's computeAutoFitSpeed ceiling).
    timing = 1.0
    if slot_seconds and slot_seconds > 0 and duration > 0:
        ratio = duration / slot_seconds
        if ratio > 1.28:
            timing = max(0.0, 1.0 - (ratio - 1.28) * 0.8)
        elif ratio < 0.35:
            timing = 0.8

    # Length for its words: a short line that comes back far longer than it
    # could take to say was babbled -- unclear, however right the voice is.
    babbled = bool(text) and duration > max_plausible_seconds(text)
    if babbled:
        naturalness = max(0.0, naturalness - 0.5)

    clipping_penalty = min(0.3, metrics.get("clipped", 0.0) * 50.0)
    # Pitch drift keeps its old role ONLY where the profile still sets a
    # tolerance (neutral/calm/serious lines, and mildly for sad/happy).
    drift_penalty = 0.03 * drift if (tolerance is not None and drift) else 0.0

    score = 0.5 * identity + 0.2 * expression + 0.15 * naturalness + 0.15 * timing - clipping_penalty - drift_penalty

    identity_reasons = []
    if similarity is not None and similarity < floor:
        identity_reasons.append("identity {:.2f} < {:.2f}".format(similarity, floor))
    if tolerance is not None and use_pitch and drift is not None and drift > float(tolerance):
        identity_reasons.append("pitch {:+.1f}st beyond the voice's {}st".format(shift, tolerance))
    consistency_floor = float(profile.get("consistencyFloor", 0.74))
    if halves is not None:
        if halves[0] < consistency_floor:
            identity_reasons.append("voice changes inside the line ({:.2f} < {:.2f})".format(halves[0], consistency_floor))
        if halves[1] < floor - 0.05:
            identity_reasons.append("half the line drifts from the voice ({:.2f})".format(halves[1]))
    reasons = list(identity_reasons)
    if flat:
        reasons.append("flat for {}".format(emotion))
    if timing < 0.5:
        reasons.append("far too long for its slot")
    if babbled:
        reasons.append("{:.1f}s is far too long for its words (max {:.1f}s)".format(duration, max_plausible_seconds(text)))
    verdict = {
        "identity": round(identity, 3),
        "expression": round(expression, 3),
        "naturalness": round(naturalness, 3),
        "timing": round(timing, 3),
        "clipping_penalty": round(clipping_penalty, 3),
        "flat": flat,
        "identityOk": not identity_reasons,
        "halves": None if halves is None else round(halves[0], 3),
        "worstHalf": None if halves is None else round(halves[1], 3),
        "reasons": reasons,
    }
    return score, verdict


def pick_best(candidates):
    """The take to keep among the attempts at one line: the best-scoring take
    whose voice stayed the character's (identity, halves, pitch limit); only
    when every attempt drifted, the one closest to the voice. Emotion never
    buys back a changed voice. candidates: [(score, verdict, payload)]."""
    ok = [c for c in candidates if c[1].get("identityOk")]
    if ok:
        return max(ok, key=lambda c: c[0])
    return max(candidates, key=lambda c: (c[1].get("identity", 0.0), c[1].get("halves") or 0.0))


def read_jobs(path, default_control, default_seed):
    """The input file: plain text (one line per output, the group's control
    and seed for all -- the original format, still used by callers with no
    per-line performance) or JSON Lines, one job per output line:
      {"text": ..., "control": ..., "seed": ..., "profile": {...}, "slotSeconds": ...}
    A job without "control" falls back to --control; without "seed" to --seed."""
    import json

    jobs = []
    with open(path, "r", encoding="utf-8") as handle:
        lines = [line.strip() for line in handle if line.strip()]
    if path.lower().endswith(".jsonl"):
        for line in lines:
            item = json.loads(line)
            jobs.append(
                {
                    "text": str(item.get("text", "")).strip(),
                    "control": item["control"] if "control" in item else default_control,
                    "seed": int(item["seed"]) if item.get("seed") is not None else default_seed,
                    "profile": item.get("profile"),
                    "slot": float(item["slotSeconds"]) if item.get("slotSeconds") else None,
                    "safe_control": item.get("safeControl"),
                    "voice_seed": int(item["voiceSeed"]) if item.get("voiceSeed") is not None else None,
                }
            )
    else:
        jobs = [{"text": line, "control": default_control, "seed": default_seed, "profile": None, "slot": None, "safe_control": None, "voice_seed": None} for line in lines]
    return [job for job in jobs if job["text"]]


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
    import json

    args = parse_args()

    jobs = read_jobs(args.input, args.control, args.seed)
    texts = [job["text"] for job in jobs]

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
    # Performance lines judge an angry/shouted take by how far its pitch
    # rises above the reference voice's, so the reference pitch is measured
    # for them even with Pitch match off -- the tolerance CHECK stays tied to
    # --pitch-tolerance (see pitch_checked below).
    has_profiles = any(job["profile"] for job in jobs)
    pitch_checked = args.pitch_tolerance > 0
    if reference and (pitch_checked or has_profiles):
        try:
            ref_audio, ref_sr = sf.read(reference)
            if getattr(ref_audio, "ndim", 1) > 1:
                ref_audio = ref_audio.mean(axis=1)
            reference_f0 = median_f0(ref_audio, ref_sr)
            print("Pitch: reference {} Hz".format("%.1f" % reference_f0 if reference_f0 else "unknown"), file=sys.stderr)
        except Exception as err:  # noqa: BLE001 -- no pitch check beats no batch
            print("Pitch check unavailable ({}) -- lines are kept as generated.".format(err), file=sys.stderr)
    retries = max(0, args.match_retries)

    success = 0
    for index, job in enumerate(jobs, 1):
        text = job["text"]
        control = job["control"]
        profile = job["profile"]
        output_file = os.path.join(args.output_dir, "output_{:03d}.wav".format(index))
        best_audio = None
        best_score = -1.0
        best_f0 = None
        best_debug = None
        failed = False
        # A line with a performance profile is retried for being flat as well
        # as for sounding like someone else, so it gets retries even with no
        # reference to match against.
        expects_expression = bool(profile) and bool(profile.get("flatCheck"))
        legacy_f0 = reference_f0 if pitch_checked else None
        attempts_per_line = 1 + retries if (matcher or legacy_f0 or expects_expression or (profile and reference_f0 and pitch_checked)) else 1
        attempt_log = []
        candidates = []
        # Every normal attempt drifted off the character's voice -> one more,
        # "safe" take: the same emotion held back (safeControl) on the voice's
        # own seed. The voice outranks the acting (see pick_best).
        rescue_possible = profile is not None and bool(job.get("safe_control")) and matcher is not None
        total_attempts = attempts_per_line + (1 if rescue_possible else 0)
        for attempt in range(total_attempts):
            rescue = attempt >= attempts_per_line
            if rescue and any(c[1].get("identityOk") for c in candidates):
                break
            audio = None
            seed = job["voice_seed"] if (rescue and job.get("voice_seed") is not None) else line_seed(job["seed"], attempt)
            if rescue:
                control = job["safe_control"]
                print("Rescue: line {} -- every take drifted from the voice; one held-back take".format(index), file=sys.stderr)
            for oom_try in (1, 2):
                try:
                    # The whole point of this script -- see the module docstring.
                    seed_everything(seed)
                    audio = model.generate(
                        text=build_final_text(text, control),
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
            sample_rate = model.tts_model.sample_rate

            if profile is None:
                # ---- Original behaviour, unchanged: lines with no performance
                # (Recap narration, older callers) are judged on speaker
                # similarity and pitch drift exactly as before.
                if matcher is None and legacy_f0 is None:
                    best_audio = audio
                    break
                similarity = matcher.similarity(audio, sample_rate) if matcher else 1.0
                f0 = median_f0(audio, sample_rate) if legacy_f0 else None
                drift = abs(semitones_between(f0, legacy_f0)) if f0 else 0.0
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
                pitch_close_enough = legacy_f0 is None or f0 is None or drift <= args.pitch_tolerance
                if similar_enough and pitch_close_enough:
                    break
                continue

            # ---- Emotion-aware: the line carries a performance profile.
            similarity = matcher.similarity(audio, sample_rate) if matcher else None
            metrics = performance_metrics(audio, sample_rate)
            f0 = metrics.get("median_f0") if profile.get("usePitch", True) else None
            shift = semitones_between(f0, reference_f0) if (f0 and reference_f0) else None
            drift = abs(shift) if shift is not None else None
            # The user's Pitch match setting still decides whether pitch is
            # checked at all (no --pitch-tolerance -> no reference_f0).
            effective = dict(profile)
            if not pitch_checked:
                effective["pitchToleranceSemitones"] = None
            duration = len(audio) / sample_rate
            halves = matcher.halves(audio, sample_rate) if matcher else None
            score, verdict = score_take(effective, similarity, shift, metrics, duration, job["slot"], halves, text=text)
            entry = {
                "attempt": attempt + 1,
                "seed": seed,
                "similarity": None if similarity is None else round(similarity, 3),
                "pitchDriftSt": None if drift is None else round(drift, 2),
                "pitchShiftSt": None if shift is None else round(shift, 2),
                "speechDb": None if metrics.get("speech_db") is None else round(metrics["speech_db"], 1),
                "pitchVariationSt": None if metrics.get("f0_var_st") is None else round(metrics["f0_var_st"], 2),
                "energyVariationDb": None if metrics.get("energy_var_db") is None else round(metrics["energy_var_db"], 2),
                "voicedRatio": round(metrics.get("voiced_ratio", 0.0), 2),
                "pauseRatio": round(metrics.get("pause_ratio", 0.0), 2),
                "score": round(score, 3),
                "seconds": round(duration, 2),
                "rescue": rescue,
            }
            entry.update(verdict)
            attempt_log.append(entry)
            print("Match: line {} attempt {} {}".format(index, attempt + 1, json.dumps(entry, ensure_ascii=False)), file=sys.stderr)
            candidates.append((score, verdict, (audio, f0, entry)))
            if not verdict["reasons"]:
                break
        if profile is not None and candidates:
            _, _, (best_audio, best_f0, best_debug) = pick_best(candidates)

        if best_audio is not None:
            best_audio, ghost_cut = trim_after_first_utterance(best_audio, model.tts_model.sample_rate, text)
            if ghost_cut > 0:
                print("Trim: line {} -- {:.2f}s after the word cut (a second sound nobody asked for)".format(index, ghost_cut), file=sys.stderr)
                if best_debug is not None:
                    best_debug["ghostCutSeconds"] = ghost_cut
            sf.write(output_file, best_audio, model.tts_model.sample_rate)
            if reference_f0 and best_f0 and (pitch_checked or profile is not None):
                with open(output_file[:-4] + ".pitch.json", "w", encoding="utf-8") as sidecar:
                    json.dump(
                        {
                            "f0": best_f0,
                            "referenceF0": reference_f0,
                            "semitones": semitones_between(best_f0, reference_f0),
                            # A neutral take is pulled onto the reference pitch; an
                            # expressive one keeps its acting up to its limit.
                            "correct": pitch_checked and (True if profile is None else bool(profile.get("pitchCorrect", True))),
                            # An expressive take keeps its acting up to the
                            # voice's limit; only what is beyond it is pulled
                            # back (voxcpmTts.ts's computeExcessPitchCorrection).
                            "cap": None if (profile is None or not pitch_checked) else profile.get("pitchToleranceSemitones"),
                        },
                        sidecar,
                    )
            if profile is not None and best_debug is not None:
                # Read by voxcpmTts.ts's runVoxCpmBatch into the line's debug view.
                debug = dict(best_debug)
                debug.update({"line": index, "attempts": len(attempt_log), "control": job["safe_control"] if best_debug.get("rescue") else job["control"]})
                print("Debug: {}".format(json.dumps(debug, ensure_ascii=False)), file=sys.stderr)
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
