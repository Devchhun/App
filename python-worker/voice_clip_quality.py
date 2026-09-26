"""How well a reference clip will clone -- printed as one JSON line.

The single strongest predictor of whether VoxCPM2 keeps ONE voice across a
character's lines turned out to be the reference clip itself, not any
generation setting: measured on a real project with a d-vector speaker
encoder, a clip whose own 2-second pieces agree with each other at 0.87
cloned every line at 0.83-0.93, while a clip at 0.78 (music underneath,
clipped, an unsteady voice) never got its lines above ~0.79 whatever was
tried -- cleaning, retries, longer text. So the useful moment to say
"this clip is weak" is when it's picked, not after sixty lines came out
wrong.

  consistency  mean cosine similarity between the clip's 2s pieces
               (>= 0.84 clones well, < 0.80 drifts between lines)
  clippedRatio fraction of samples at full scale (recording/extraction
               overdrive)
  speechRatio  fraction of the clip the encoder's VAD keeps as speech

Best-effort: if the encoder can't be imported this prints {"ok": false}
and the app simply shows no quality verdict.
"""

import json
import sys


def main():
    path = sys.argv[1]
    try:
        import numpy as np
        import soundfile as sf
        from resemblyzer import VoiceEncoder, preprocess_wav

        raw, sr = sf.read(path)
        if raw.ndim > 1:
            raw = raw.mean(axis=1)
        clipped = float(np.mean(np.abs(raw) >= 0.999)) if len(raw) else 0.0

        wav = preprocess_wav(path)
        speech_ratio = float(len(wav) / max(1, int(len(raw) * 16000 / sr)))

        encoder = VoiceEncoder(verbose=False)
        piece = 2 * 16000
        pieces = [wav[i : i + piece] for i in range(0, len(wav) - piece + 1, piece)]
        if len(pieces) < 2:
            print(json.dumps({"ok": False, "error": "too short"}))
            return
        embeds = [encoder.embed_utterance(p) for p in pieces]
        sims = [float(np.dot(embeds[i], embeds[j])) for i in range(len(embeds)) for j in range(i + 1, len(embeds))]
        print(json.dumps({"ok": True, "consistency": float(np.mean(sims)), "clippedRatio": clipped, "speechRatio": min(1.0, speech_ratio)}))
    except Exception as err:  # noqa: BLE001 -- no verdict beats no clip
        print(json.dumps({"ok": False, "error": str(err)}))


if __name__ == "__main__":
    main()
