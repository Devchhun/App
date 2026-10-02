"""Tests for voxcpm_batch_runner.py's emotion-aware scoring.

Run by app/main/media/voxcpmRunnerScoring.test.ts with the app's bundled
Python, which passes a JSON file of emotion profiles produced by the REAL
TypeScript emotionProfile() -- so the two sides of the contract are tested
together. Can also be run alone (python test_voxcpm_scoring.py [profiles.json]).

The take measurements used below are the ones measured on VoxCPM2 itself
during calibration (same voice, same lines): e.g. the shouted line's kept
take sat +8.41 st above the reference, the shocked one +5.66 st, a flat
angry take +0.34 st."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voxcpm_batch_runner as runner  # noqa: E402

PROFILES = None


def profile(name):
    return dict(PROFILES[name])


def metrics(voiced=0.7, f0_var=4.0, pause=0.25, clipped=0.0):
    return {"voiced_ratio": voiced, "f0_var_st": f0_var, "energy_var_db": 5.0, "pause_ratio": pause, "clipped": clipped}


class NeutralKeepsTheOldRules(unittest.TestCase):
    def test_pitch_drift_still_rejects_a_neutral_line(self):
        _, verdict = runner.score_take(profile("neutral"), 0.92, 3.3, metrics(), 3.0, 4.0)
        self.assertTrue(any("beyond the voice" in r for r in verdict["reasons"]))
        self.assertFalse(verdict["identityOk"])

    def test_a_close_neutral_take_is_accepted(self):
        _, verdict = runner.score_take(profile("neutral"), 0.92, 0.3, metrics(), 3.0, 4.0)
        self.assertEqual(verdict["reasons"], [])

    def test_a_calm_line_is_never_flat(self):
        _, verdict = runner.score_take(profile("calm"), 0.92, 0.1, metrics(f0_var=1.0), 3.0, 4.0)
        self.assertFalse(verdict["flat"])
        self.assertEqual(verdict["reasons"], [])


class EmotionWithinTheVoice(unittest.TestCase):
    """Emotion may move pitch, but only inside the character's voice."""

    def test_angry_raised_inside_its_limit_is_accepted(self):
        _, verdict = runner.score_take(profile("angry"), 0.92, 3.6, metrics(), 2.9, 4.0)
        self.assertEqual(verdict["reasons"], [])

    def test_angry_raised_far_beyond_is_another_voice(self):
        # +5.77 st: measured, takes that far off averaged lower similarity.
        _, verdict = runner.score_take(profile("angry"), 0.92, 5.77, metrics(), 2.9, 4.0)
        self.assertFalse(verdict["identityOk"])

    def test_a_shout_at_plus_9_is_rejected(self):
        # The measured +9.2 st shout scored 0.63 against the voice.
        _, verdict = runner.score_take(profile("shout"), 0.63, 9.2, metrics(), 2.9, 4.0)
        self.assertFalse(verdict["identityOk"])
        self.assertTrue(any("beyond the voice" in r for r in verdict["reasons"]))

    def test_crying_and_shocked_inside_their_limit(self):
        _, crying = runner.score_take(profile("crying"), 0.85, 3.0, metrics(voiced=0.52), 2.6, 4.0)
        _, shocked = runner.score_take(profile("shocked"), 0.88, 3.5, metrics(), 2.9, 4.0)
        self.assertEqual(crying["reasons"], [])
        self.assertEqual(shocked["reasons"], [])

    def test_identity_still_matters(self):
        _, verdict = runner.score_take(profile("angry"), 0.60, 3.0, metrics(), 2.9, 4.0)
        self.assertTrue(any("identity" in r for r in verdict["reasons"]))


class VoiceInsideTheLine(unittest.TestCase):
    def test_a_voice_that_changes_part_way_is_retried(self):
        _, verdict = runner.score_take(profile("neutral"), 0.90, 0.2, metrics(), 3.0, 4.0, halves=(0.67, 0.80))
        self.assertTrue(any("changes inside the line" in r for r in verdict["reasons"]))
        self.assertFalse(verdict["identityOk"])

    def test_one_half_drifting_from_the_voice_is_retried(self):
        _, verdict = runner.score_take(profile("neutral"), 0.88, 0.2, metrics(), 3.0, 4.0, halves=(0.80, 0.62))
        self.assertTrue(any("drifts from the voice" in r for r in verdict["reasons"]))

    def test_a_steady_take_passes(self):
        _, verdict = runner.score_take(profile("neutral"), 0.90, 0.2, metrics(), 3.0, 4.0, halves=(0.84, 0.86))
        self.assertTrue(verdict["identityOk"])


class PickBest(unittest.TestCase):
    def test_the_voice_outranks_the_acting(self):
        drifted = (0.99, {"identityOk": False, "identity": 0.70, "halves": 0.6}, "loud, other voice")
        steady = (0.80, {"identityOk": True, "identity": 0.88, "halves": 0.85}, "same voice")
        self.assertEqual(runner.pick_best([drifted, steady])[2], "same voice")

    def test_when_every_take_drifted_the_closest_voice_wins(self):
        a = (0.95, {"identityOk": False, "identity": 0.72, "halves": 0.7}, "a")
        b = (0.70, {"identityOk": False, "identity": 0.79, "halves": 0.7}, "b")
        self.assertEqual(runner.pick_best([a, b])[2], "b")


class FlatPerformanceDetection(unittest.TestCase):
    def test_a_flat_angry_take_is_retried(self):
        _, verdict = runner.score_take(profile("angry"), 0.90, 0.34, metrics(), 2.7, 4.0)
        self.assertTrue(verdict["flat"])
        self.assertIn("flat for angry", verdict["reasons"])

    def test_an_acted_take_scores_higher_than_a_flat_one(self):
        acted, _ = runner.score_take(profile("shout"), 0.85, 4.0, metrics(), 3.0, 4.0)
        flat, _ = runner.score_take(profile("shout"), 0.86, 0.2, metrics(), 3.0, 4.0)
        self.assertGreater(acted, flat)

    def test_a_mild_angry_line_is_not_checked(self):
        _, verdict = runner.score_take(profile("angry_mild"), 0.90, 0.2, metrics(), 2.7, 4.0)
        self.assertFalse(verdict["flat"])


class Whisper(unittest.TestCase):
    def test_a_mostly_voiced_whisper_is_retried(self):
        _, verdict = runner.score_take(profile("whisper"), 0.92, None, metrics(voiced=0.65), 3.8, 5.0)
        self.assertTrue(verdict["flat"])

    def test_a_real_whisper_is_accepted_without_voiced_pitch(self):
        _, verdict = runner.score_take(profile("whisper"), 0.85, None, metrics(voiced=0.45, f0_var=None), 3.5, 5.0)
        self.assertEqual(verdict["reasons"], [])
        self.assertEqual(verdict["naturalness"], 1.0)


class TimingAndClipping(unittest.TestCase):
    def test_far_too_long_for_its_slot(self):
        _, verdict = runner.score_take(profile("neutral"), 0.92, 0.1, metrics(), 6.0, 2.0)
        self.assertIn("far too long for its slot", verdict["reasons"])

    def test_clipping_costs_score(self):
        clean, _ = runner.score_take(profile("neutral"), 0.92, 0.1, metrics(), 3.0, 4.0)
        clipped, _ = runner.score_take(profile("neutral"), 0.92, 0.1, metrics(clipped=0.004), 3.0, 4.0)
        self.assertLess(clipped, clean)


class Jobs(unittest.TestCase):
    def test_jsonl_jobs_carry_their_own_control_seed_and_profile(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "input.jsonl")
            with open(path, "w", encoding="utf-8") as f:
                f.write(json.dumps({"text": "ខឹង!", "control": "angry", "seed": 7, "profile": profile("angry"), "slotSeconds": 2.5, "safeControl": "held back", "voiceSeed": 797374}, ensure_ascii=False) + "\n")
                f.write(json.dumps({"text": "plain"}) + "\n")
                f.write(json.dumps({"text": "none", "control": ""}) + "\n")
            jobs = runner.read_jobs(path, "group control", 99)
        self.assertEqual(jobs[0]["control"], "angry")
        self.assertEqual(jobs[0]["seed"], 7)
        self.assertEqual(jobs[0]["slot"], 2.5)
        self.assertEqual(jobs[0]["safe_control"], "held back")
        self.assertEqual(jobs[0]["voice_seed"], 797374)
        self.assertEqual(jobs[1]["control"], "group control")
        self.assertEqual(jobs[1]["seed"], 99)
        self.assertIsNone(jobs[1]["profile"])
        self.assertEqual(jobs[2]["control"], "")

    def test_plain_text_input_is_the_old_behaviour(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "input.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("one\ntwo\n")
            jobs = runner.read_jobs(path, "ctl", 5)
        self.assertEqual([(j["text"], j["control"], j["seed"], j["profile"]) for j in jobs], [("one", "ctl", 5, None), ("two", "ctl", 5, None)])


class Metrics(unittest.TestCase):
    def test_a_gliding_voice_moves_more_than_a_steady_one(self):
        import numpy as np

        sr = 16000
        t = np.arange(int(sr * 1.5)) / sr
        steady = 0.3 * np.sin(2 * np.pi * 150 * t)
        f = 120 + 120 * t / t[-1]
        glide = 0.3 * np.sin(2 * np.pi * np.cumsum(f) / sr)
        self.assertLess(runner.performance_metrics(steady, sr)["f0_var_st"], 0.5)
        self.assertGreater(runner.performance_metrics(glide, sr)["f0_var_st"], 2.0)

    def test_noise_has_almost_no_voiced_pitch(self):
        import numpy as np

        sr = 16000
        noise = np.random.RandomState(0).normal(0, 0.1, int(sr * 1.5))
        self.assertLess(runner.performance_metrics(noise, sr)["voiced_ratio"], 0.3)


def load_profiles(path):
    global PROFILES
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            PROFILES = json.load(f)
        return
    # Standalone run: the values TypeScript's emotionProfile() produces.
    PROFILES = {
        "neutral": {"emotion": "neutral", "intensity": 30, "pitchToleranceSemitones": 2, "pitchCorrect": True, "similarityFloor": 0.8, "usePitch": True, "expression": "none", "targetRaiseSt": None, "flatCheck": False, "consistencyFloor": 0.74},
        "calm": {"emotion": "calm", "intensity": 40, "pitchToleranceSemitones": 2, "pitchCorrect": True, "similarityFloor": 0.8, "usePitch": True, "expression": "none", "targetRaiseSt": None, "flatCheck": False, "consistencyFloor": 0.74},
        "angry": {"emotion": "angry", "intensity": 85, "pitchToleranceSemitones": 4, "pitchCorrect": False, "similarityFloor": 0.8, "usePitch": True, "expression": "raise", "targetRaiseSt": 3.07, "flatCheck": True, "consistencyFloor": 0.74},
        "angry_mild": {"emotion": "angry", "intensity": 40, "pitchToleranceSemitones": 4, "pitchCorrect": False, "similarityFloor": 0.8, "usePitch": True, "expression": "raise", "targetRaiseSt": 2.08, "flatCheck": False, "consistencyFloor": 0.74},
        "shout": {"emotion": "shout", "intensity": 90, "pitchToleranceSemitones": 4.5, "pitchCorrect": False, "similarityFloor": 0.78, "usePitch": True, "expression": "raise", "targetRaiseSt": 3.75, "flatCheck": True, "consistencyFloor": 0.74},
        "crying": {"emotion": "crying", "intensity": 85, "pitchToleranceSemitones": 3.5, "pitchCorrect": False, "similarityFloor": 0.78, "usePitch": True, "expression": "none", "targetRaiseSt": None, "flatCheck": False, "consistencyFloor": 0.74},
        "shocked": {"emotion": "shocked", "intensity": 78, "pitchToleranceSemitones": 4, "pitchCorrect": False, "similarityFloor": 0.8, "usePitch": True, "expression": "raise", "targetRaiseSt": 2.76, "flatCheck": True, "consistencyFloor": 0.74},
        "whisper": {"emotion": "whisper", "intensity": 75, "pitchToleranceSemitones": None, "pitchCorrect": False, "similarityFloor": 0.78, "usePitch": False, "expression": "whisper", "targetRaiseSt": None, "flatCheck": True, "consistencyFloor": 0.74},
    }


class ShortLinesAreSaidNotDragged(unittest.TestCase):
    """One-word lines: a take far longer than its words is babble."""

    def test_syllables(self):
        self.assertEqual(runner.estimate_syllables("អូ!"), 1)  # អូ!
        # a subscript consonant belongs to the syllable before it: ស្រី = 1
        self.assertEqual(runner.estimate_syllables("ស្រី"), 1)
        self.assertGreater(runner.estimate_syllables("ថ្ងៃនេះ ខ្ញុំទៅផ្សារ"), 5)

    def test_a_dragged_out_one_word_take_is_retried(self):
        _, verdict = runner.score_take(profile("neutral"), 0.92, 0.2, metrics(), 1.9, 0.6, text="អូ!")
        self.assertTrue(any("too long for its words" in r for r in verdict["reasons"]))

    def test_a_normal_one_word_take_passes(self):
        _, verdict = runner.score_take(profile("neutral"), 0.92, 0.2, metrics(), 0.7, 0.6, text="អូ!")
        self.assertFalse(any("too long for its words" in r for r in verdict["reasons"]))

    def test_a_sentence_is_never_judged_this_way(self):
        _, verdict = runner.score_take(profile("neutral"), 0.92, 0.2, metrics(), 3.5, 3.4, text="ថ្ងៃនេះ ខ្ញុំទៅផ្សារ")
        self.assertFalse(any("too long for its words" in r for r in verdict["reasons"]))


class GhostAfterAShortWord(unittest.TestCase):
    """A one-word take: the word, silence, then a second sound -- cut."""

    def _burst(self, seconds, sr=16000):
        import numpy as np
        t = np.arange(int(seconds * sr)) / sr
        return 0.3 * np.sin(2 * np.pi * 220 * t)

    def test_the_second_sound_after_a_word_is_cut(self):
        import numpy as np
        sr = 16000
        audio = np.concatenate([self._burst(0.3), np.zeros(int(0.6 * sr)), self._burst(0.4)])
        trimmed, cut = runner.trim_after_first_utterance(audio, sr, "បាទ")  # បាទ
        self.assertAlmostEqual(len(trimmed) / sr, 0.4, delta=0.05)
        self.assertGreater(cut, 0.8)

    def test_a_sentence_keeps_its_pauses(self):
        import numpy as np
        sr = 16000
        audio = np.concatenate([self._burst(0.8), np.zeros(int(0.6 * sr)), self._burst(0.8)])
        sentence = "ថ្ងៃនេះ ខ្ញុំទៅផ្សារ"
        trimmed, cut = runner.trim_after_first_utterance(audio, sr, sentence)
        self.assertEqual(len(trimmed), len(audio))
        self.assertEqual(cut, 0.0)


class BabbleAfterALongerLine(unittest.TestCase):
    def test_sound_past_the_plausible_length_is_cut(self):
        import numpy as np
        sr = 16000
        t = np.arange(int(1.5 * sr)) / sr
        speech = 0.3 * np.sin(2 * np.pi * 200 * t)
        # "ថ្ងៃនេះ ខ្ញុំទៅផ្សារ" said in 1.5 s, then 6 s of silence + babble.
        text = "ថ្ងៃនេះ ខ្ញុំទៅផ្សារ"
        limit = runner.max_plausible_seconds(text)
        pad = np.zeros(int((limit + 0.5) * sr) - len(speech))
        audio = np.concatenate([speech, pad, speech])
        trimmed, cut = runner.trim_after_first_utterance(audio, sr, text)
        self.assertLess(len(trimmed) / sr, 1.7)
        self.assertGreater(cut, 1.0)


if __name__ == "__main__":
    load_profiles(sys.argv[1] if len(sys.argv) > 1 else None)
    unittest.main(argv=[sys.argv[0], "-v"])
