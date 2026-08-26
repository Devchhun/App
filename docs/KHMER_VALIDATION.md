# Khmer Validation — Manual Test Flow

**Status: not yet performed.** Everything in Phase C was built and tested for
correctness (UTF-8 handling, word/segment timing, alignment algorithm,
correction dictionary, project persistence) using English speech, because no
Khmer audio or Khmer TTS voice was available in the build/test environment.
The pipeline is language-agnostic by design (Whisper handles Khmer as one of
its ~99 languages; every text-handling path is UTF-8 end to end), but **Khmer
transcription accuracy is unverified** until this flow has been run against a
real Khmer recording. Do not claim Khmer accuracy elsewhere in the app or in
release notes until this document's checklist has actually been completed and
its results recorded.

## What you need

- A real audio or video file with spoken Khmer, ideally 1–5 minutes, containing:
  - At least one person's name and one place name
  - At least one technical or borrowed term (e.g. an English loanword commonly used in Khmer speech)
  - A stretch of mixed Khmer/English code-switching, if your source has any (common in business/tech speech)
- (Optional but recommended) A written Khmer script/transcript of the same recording, even if approximate — needed to test §7 below.
- A model size — start with `small` for reasonable Khmer accuracy; `tiny`/`base` are much weaker on non-English languages.

## Test steps

### 1. Import and transcribe
1. `npm run dev`, import the Khmer video/audio file.
2. In the Transcript panel, set Language to **Khmer** (not Auto — confirm both, see §2) and select the `small` model (download it if prompted).
3. Click **Start Transcription**. Note the model load time and total transcription time.
4. **Record:** Does the output text look like real Khmer script (឴ក ខ គ ឃ ង...), not mojibake, question marks, or boxes? Take a screenshot.

### 2. Automatic language detection
1. Re-run with Language set to **Auto-detect** on the same file.
2. **Record:** Does `detectedLanguage` come back as `km`? If it misdetects (common for short clips or heavy code-switching), note what it detected instead.

### 3. Khmer Unicode preservation
1. With a completed Khmer transcript, open a segment and inspect the text closely (zoom in if needed).
2. **Check:** Correct diacritic/subscript rendering (compound consonant clusters, vowel signs above/below/around the base consonant) — no missing combining marks, no reordering artifacts.
3. Export the project (see §9) and re-open the exported JSON in a plain text editor. **Check:** the Khmer text is still correct UTF-8, not escaped/garbled.

### 4. Mixed Khmer and English
1. Find or produce a segment where the speaker code-switches (e.g., says an English product/company name mid-Khmer-sentence).
2. **Check:** both scripts render correctly side by side in the same segment, with no line-break or shaping corruption at the script boundary.

### 5. Names and technical terminology
1. Identify segments containing the person/place names and technical terms from your source material.
2. **Record:** transcription accuracy for each (exact match / close / wrong). This is expected to be the weakest area — proper nouns and loanwords are hard for any ASR model — and is exactly what the correction dictionary (§8) exists to fix permanently.

### 6. Segment and word timestamps
1. Click several segments' timestamps and confirm the Preview player seeks to the correct spot and the audio you hear matches the displayed text.
2. Play through a stretch of audio and confirm the active-segment highlight tracks correctly.
3. **Note on word-level timing:** Khmer script has no spaces between words, so Whisper's word-boundary timestamps are inherently less reliable for Khmer than for English (word segmentation itself is ambiguous). Check a few segments' per-word timestamps (visible in the underlying transcript data) and record whether they look plausible — do not expect English-level precision here; this is a model limitation, not an app bug.

### 7. Script alignment with a corrected Khmer script
1. If you have a written script, paste it into the "Paste a corrected script" box and click **Align Script**.
2. **Record:** alignment confidence per line, and whether timestamps look right when you click through them in the Preview.
3. If confidence is low throughout, try a shorter/cleaner script excerpt to isolate whether the issue is the alignment algorithm or a genuinely very different wording between script and speech.

### 8. Correction dictionary with Khmer
1. Select a mistranscribed Khmer word/name in a segment (this pre-fills the dictionary "Add" form with your selection — see the Dictionary modal).
2. Add it with the correct Khmer spelling, category "Khmer spelling" or "Person"/"Place" as appropriate.
3. Click **Preview matches**, confirm the match count and preview list show correct Khmer text, then **Apply**.
4. **Check:** segment timing is unchanged after applying (only text changed).
5. Click **Undo last apply** and confirm the original (wrong) text is restored exactly.

### 9. Direct editing, search/replace
1. Manually edit a Khmer segment's text directly in its textbox. **Check:** typing/editing Khmer text works normally (cursor position, backspace behavior over compound clusters).
2. Use the search/replace bar with a Khmer search term. **Check:** match count and replacement are correct for Khmer text (this exercises plain substring matching, which works the same for Khmer as any Unicode text, but confirm it in practice).

### 10. Project save and reopen
1. Let autosave fire (or wait ~5s after an edit), then fully quit the app.
2. Relaunch. **Check:** the same project reopens with the Khmer transcript, your corrections, and the dictionary entries all intact and correctly rendered.

### 11. Export-safe Khmer text data
1. Export the correction dictionary to a JSON file (Dictionary modal → Export JSON).
2. Open the exported file in a plain UTF-8-aware text editor (VS Code, Notepad++ — not legacy Notepad on older Windows builds, which can mishandle encoding detection).
3. **Check:** Khmer text in the file is correct, readable UTF-8 — not `\uXXXX` escapes (our export uses `JSON.stringify` without escaping non-ASCII, so real Khmer characters should appear directly) and not corrupted.

## Recording results

For each numbered check above, record: pass/fail/partial, a short note, and (where practical) a screenshot. There's no dedicated results template yet — a plain markdown or text file alongside your test recording is sufficient. Once this has been run for real, update the status line at the top of this document with the date, model size used, and a summary verdict instead of "not yet performed."
