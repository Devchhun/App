# Android app plan

Goal: the desktop editor's features on Android, with the same flow as the
three reference screens (Home -> Media picker -> Editor). Anything a phone
cannot run locally goes through an API instead.

## 1. Where each desktop feature runs on the phone

| Feature | Desktop today | Android |
|---|---|---|
| Timeline editing (split, trim, ripple, magnet, keyframes, undo) | `shared/`, `renderer/src/timeline/*.ts` (pure TS) | Same code, reused as-is |
| Preview playback | HTML video + proxy files | WebView video; 540p proxy only for 4K/HEVC sources |
| Export | `shared/export.ts` builds ffmpeg `filter_complex`, `ffmpeg-static` runs it | Same builder; ffmpeg for Android (maintained ffmpeg-kit fork or own build) with the `h264_mediacodec` hardware encoder |
| Thumbnails, filmstrip, waveform, probe | ffmpeg | Android ffmpeg / MediaMetadataRetriever, cached to disk |
| Story recap, video narration | Gemini (`storyRecapService`, `geminiVideoNarrationService`) | Same Gemini calls; video upload streamed natively from the file |
| Translation, SRT | Gemini / Claude | Same |
| Transcription | local Whisper (Python) | Gemini transcription (the path `speakerDiarizationService` already uses) |
| Edge TTS | bundled Python `edge_tts` | Native Kotlin WebSocket (OkHttp): free, no server |
| VoxCPM voice clone | local GPU Python | Remote API (provider: open decision) |
| Vocal removal | Python separator | Remote API, later phase |
| AI Animation | Gemini + Edge TTS + hidden window frames piped to ffmpeg | Gemini + native Edge TTS + sandboxed iframe -> OffscreenCanvas -> WebCodecs hardware encode |
| Local AI (Ollama) | local | Not offered on the phone |
| License | device registration with the license server | Same server, machine ID from the Android device |

## 2. Rules so the app does not freeze or crash

1. **No heavy work on the UI thread.** ffmpeg, file copies, thumbnails and
   uploads run in native background threads; the UI only receives progress.
2. **Long jobs run in an Android Foreground Service** (export, recap, AI
   Animation, dubbing) with a progress notification, so screen-off or
   switching apps does not kill them. Every job can be cancelled.
3. **One heavy job at a time.** A job queue; the second export waits.
4. **Never hold video in JS memory.** Work with file paths/URIs; no base64
   of media; Gemini uploads stream from disk in native code.
5. **Proxies for heavy sources.** 4K or HEVC footage gets a 540p proxy for
   the timeline; export always uses the original.
6. **Timeline draws only what is on screen** (virtualised filmstrip, capped
   thumbnail count, disk cache).
7. **Autosave + crash recovery.** The project saves after each edit;
   reopening after a crash restores it.
8. **Device check.** Read RAM and hardware codecs; hide export
   resolutions the phone cannot encode (for example 4K on a weak phone).
9. **Network jobs survive bad signal.** Retries with backoff (as the desktop
   Gemini services already do), resumable uploads, a clear error when the
   network is gone, and never a silent hang.
10. **Minimum Android 8 (API 26)**, tested on the user's own phone over USB.

## 3. Architecture

- `mobile/` in this repo: a Capacitor Android app (React + Vite).
- Reuses `shared/` and the pure-logic files of `renderer/src/` directly.
- New mobile screens: Home, Media picker, Editor (preview on top, timeline
  below, scrollable tool bar, bottom sheets instead of side panels).
- `mobile/src/platform/`: the phone's implementation of the services that
  `window.api.*` provides on desktop (media, project, export, ai, dubbing,
  narration, story, license), so logic code does not care which platform
  it runs on.
- Native Kotlin plugins: ffmpeg runner, Edge TTS, foreground job service,
  file upload, device info.
- API keys (Gemini, VoxCPM) stored in Android Keystore-backed storage.

## 4. Phases

0. **Setup.** Android Studio + JDK, Capacitor scaffold, license gate, run on
   the user's phone.
1. **Core editor.** Home, Media picker, Editor: split/trim/delete/speed/
   volume, Text, Audio, project save, Export 720p/1080p.
2. **Captions + TTS.** Auto SRT, translation, Edge TTS narration and dubbing.
3. **Story.** Story recap and video narration.
4. **VoxCPM and vocal removal** through the remote API.
5. **AI Animation.**

Each phase ships as a working APK before the next begins.

## 5. Decisions

- VoxCPM: a third-party hosted API (provider picked in phase 4), behind one
  client so it can be swapped.
- Gemini key: each user enters their own key on the phone, as on desktop.

## 6. Status

- **Phase 0 done.** `mobile/` Capacitor 8 app; license gate on the same
  `/api/device/register` as desktop (Machine ID = SHA-256 of ANDROID_ID,
  so debug and release builds register as different devices); Home and Me
  screens. Verified on an emulator against a local license server:
  pending -> approve (opens by itself) -> block (locks within a minute).
- **Phase 1 done (v0.2.0).** Media picker (videos / photos / music, paged,
  lazy thumbnails, Android 14 partial access); editor with preview (two
  <video> elements taking turns, text overlays), CapCut-style timeline
  (centre playhead, scroll to scrub, pinch zoom, filmstrip only for what is
  on screen, trim handles, drag text/audio), split / speed / volume / mute /
  duplicate / delete / text / music / canvas ratio, undo-redo (a drag is one
  step), autosave + Projects list; export with Media3 Transformer (hardware
  H.264, foreground service, progress + cancel) into Movies/CreativeAIEditor.
  Export path checked on the emulator: clips, speed, letterboxing, text
  timing and music mix all match the preview.
- Export uses Media3 Transformer, not ffmpeg: `shared/export.ts` (ffmpeg
  args) is not reused on the phone; `mobile/src/editor/exportSpec.ts` builds
  the native spec instead.
- Media plays through Capacitor's `/_capacitor_content_/` URLs
  (`mediaUrl` in `platform/mediaLibrary.ts`); the custom range-serving
  `MediaWebViewClient` is still registered but unused for video, kept as a
  fallback if seeking large files proves slow on real phones.
- Build: `cd mobile && npm run apk` -> `mobile/dist-apk/`.
- Emulator tests: never against the live server. Run a local one
  (`MONGODB_URI= ADMIN_TOKEN=test-token PORT=8799 DATA_DIR=<temp> node
  server.js`), `adb reverse tcp:8799 tcp:8799`, and build with
  `VITE_LICENSE_SERVER_URL=http://localhost:8799` (debug builds allow
  cleartext to localhost only).
- **Phase 2 (v0.3.0), through APIs only.** Editor tool **Captions** ->
  sheet with 1. Auto captions (Gemini, user's key: the film's sound decoded
  natively to 16 kHz mono -- `SpeechAudio.java` -- and sent in one-minute
  WAV parts with the desktop's own prompt/parser/cleaner, now in
  `shared/geminiTranscript.ts`), 2. Translate to Khmer (Gemini, desktop's
  prompt in `shared/geminiTranslate.ts`), 3. Dub with KiriTTS (native HTTP,
  per-line WAV in the app's data folder, a line too long for its slot asked
  again faster). Captions are text clips (`caption: true`), dub lines audio
  clips (`dub: true`); both burn into / mix into the export. Keys: Me -> AI
  keys (Capacitor Preferences). Verified on the emulator end to end against
  stand-in Gemini/KiriTTS servers (`VITE_GEMINI_BASE`, `VITE_KIRI_BASE`)
  and a local license server: captions at the right times, Khmer text,
  dubbed voice at 1.0 s / 5.0 s in the exported file, film ducked.
  Dub step 3 now defaults to **TTS (free)** -- Microsoft Edge's Khmer
  voices (Piseth / Sreymom) over the edge_tts WebSocket protocol, native
  (`EdgeTts.java`, OkHttp; MP3 96 kbps), no key -- with "By gender" (each
  caption keeps Gemini's M/F as `TextClip.gender`) or one fixed voice; a
  line too long for its slot is spoken again at up to +50% rate. KiriTTS
  stays as the second engine. Verified live: male/female voices by line,
  mixed into the export.
  **Detect Gender** (beside the engine switch, as on the desktop): a full
  screen review stepping through each caption -- plays the line from the
  original film, editable text, Gemini's M/F and the line's measured pitch
  (the desktop's detector, now `shared/speakerPitch.ts`), the engine's
  voices to tap; a pick is the line's own voice (`TextClip.voice`,
  'edge:<id>' / 'kiri:<id>') and wins over the Dub step's choice. Saved as
  one Undo step on close. Verified on the emulator; also on the player bar.
  **Auto-Sync / Auto-Speed / Video Sync** in the Dub step, the desktop's
  plans (now `shared/dubFit.ts`, `shared/videoSyncPlan.ts`): audio clips
  gained `playbackRate` (pitch kept, preview and Media3 export) and
  `captionId`. **SRT tab** in the picker (native `pickTextFile`, Android's
  file chooser; UTF-8/16 by BOM, else GB18030): the subtitles become the
  captions, with a new project's video or alone onto the open one.
  **⚙ AI keys** beside the editor's X (Gemini / KiriTTS, each checked with
  its service for free).
  **20-minute story test (emulator, EP 161 at 720p H.264 + its Khmer SRT,
  298 lines):** new project with SRT 0.1 s; Edge TTS dub of 298 lines
  4 min; Auto-Speed 109 lines / Video Sync 124 regions in ~40 ms each;
  playback 60 fps; 720p export of 21:07 in 6 min 47 s, every checked voice
  line within 0.02 s of its place, captions burned in. Fixed on the way:
  more than 15 texts failed every export (Media3's overlay limit) -- texts
  now share time lanes, decoded only when shown; a decoder that never
  starts (10-bit H.264) now says so; re-dubbed voices' files are deleted
  when the editor closes (and with a deleted project).
- **Phase 3 (story recap), first part done.** Editor tool **Recap** ->
  full-screen Story recap, the desktop's story-first flow with its own
  prompts/parsing/checks (now `shared/storyRecap.ts`,
  `shared/recapNarration.ts`, `shared/jsonSalvage.ts`; desktop re-exports):
  the film (every clip of the longest video file) and its captions on the
  file's clock -> parts of up to 12 min, each made small natively
  (`StoryProxyJob`, Media3: 360p, 1 fps, mono 48 kbps -- ~7 MB per 10 min)
  and streamed to the Files API (`GeminiUpload`, OkHttp resumable upload) ->
  outline on gemini-3.1-pro-preview, falling back to 2.5-flash -> Khmer
  names -> user checks characters/events -> script + language repair ->
  narration (Edge TTS Piseth/Sreymom or KiriTTS) laid back to back from
  0:00 as `recap` audio clips. Recap state saved in the project.
  Emulator test (21-min EP 161, stand-in Gemini): analysis 4 min 22 s.
  Fixed on the way: Capacitor's PluginCall.getLong ignores JS numbers
  (Integers) -- every filmstrip tile showed the first frame.
  Not yet: reference face photos, Regenerate one scene, video narration.
- **Translation, as the desktop's.** `mobile/src/ai/translate.ts` now runs
  the desktop's translateSegmentsWithGemini exactly (batches of 60 in
  order with 8 lines of context, JSON schema, an answer cut off at
  MAX_TOKENS split in half, skipped lines asked again); each caption keeps
  its `original`, so translating again starts from the source; Stop or an
  error keeps the batches done; the screen stays awake (`keepAwake`,
  counted holds). **Subtitles** screen (Captions -> Subtitles ›): the
  desktop's script rows -- time, original, editable Khmer, ▶ plays the line
  from the film -- drawn with content-visibility and memo'd rows. Emulator,
  EP 161 Chinese SRT (298 lines), stand-in Gemini at 2 s/answer: 16 s,
  every line mapped to its own original, 60 fps while scrolling.
- **Sound, playback, export, blur, vocals (v0.3.0 cont.).**
  - Generated voices mastered as the desktop does (`ai/voiceMaster.ts`:
    BS.1770 loudness, -18 LUFS, peaks under -2 dBFS -> the clip's volume;
    matches ffmpeg ebur128 to 0.1 LU). Voice/short clips play through Web
    Audio (`editor/clipAudio.ts`: decoded ahead, scheduled on the audio
    clock) -- <audio> elements started late and jumped on drift fixes;
    pieces of one file (Split / Video Sync) now play straight through.
  - Timeline audio clips drawn as waveforms (native `waveform`, peaks per
    1/40 s cached beside the decoded sound; canvas tiles).
  - One round close/done button everywhere; AI keys as cards with a live
    check. Export screen like the desktop's (resolution, bit rate, frame
    rate, audio on/off + warning, Export SRT to Downloads, summary with
    size estimate -- 167.1 MB actual vs ~167 estimated).
  - Blur boxes (Sub & Blur): editable in the preview (backdrop-filter),
    a GL shader in the export (`BlurBoxEffect`), drawn before the texts.
  - Remove Vocals on the phone: UVR MDX-Net through ONNX Runtime
    (`Separation` -- identical to a Python reference -- `VocalRemover`:
    model download, decode, 44.1 kHz resample, AAC). Best = Inst_HQ_4
    (needs ~1.1 GB while running: offered from 6 GB RAM), Fast = 1_9703
    (~0.6 GB). The bed is the film's (`MediaRef.noVocals`), played as one
    stream following the video and exported as its own track. APK 61 MB
    (ONNX Runtime; arm64, armv7, x86_64 only).
  - Auto-Speed lines play through Web Audio too: stretched with their
    pitch kept (WSOLA, `editor/timeStretch.ts`, in a Worker) -- before,
    they fell back to <audio> and started late.
  - My Logos (tool **Logo**): logos saved on the phone for every project
    (`project/logos.ts`, at most 600 px, optional plain-background removal
    by flood fill), placed on the whole video or 5 s at the playhead in the
    top-right corner at the desktop's sizes (`logoCorner`), moved/resized
    on the picture, exported as timed overlays with their transparency.
  Not yet: real-key Gemini/KiriTTS test on a phone.
