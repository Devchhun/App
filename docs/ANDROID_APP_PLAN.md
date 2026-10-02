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
