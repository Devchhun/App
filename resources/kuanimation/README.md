# Kuanimation skill

Kuanimation is an [Agent Skill](https://agentskills.io/specification) for making illustrated animated stories and explainers. It includes a Canvas drawing runtime with five looks (a 2D pencil sketch by default, plus watercolour, hazy painted forest, paper diorama and felt-tip marker), a film template, an offline renderer and mixer, optional text-to-speech scripts, and two complete examples: Angkor (watercolour, Khmer voice-over) and the life cycle of a sunflower (pencil sketch, captions and music). The skill name is **`kuanimation`**; install the repository in a directory with that name so agents can discover it.

The example includes its voice clips, so you can preview and rebuild it **without an API key**. A Gemini API key is needed only if you choose to generate new speech with Gemini TTS. Microsoft Edge TTS is another option.

## In this app

The AI Animation tab uses this kit directly from the app's resources: Gemini writes the lines and the scene code, Edge TTS speaks them, a hidden window draws every frame and ffmpeg packs the MP4. Nothing needs to be installed.

## Requirements for rendering

- Node.js and npm
- Google Chrome or Chromium (set `CHROME=/path/to/browser` if it is not in the usual location)
- FFmpeg and FFprobe
- Python 3 only for generating new speech

The renderer uses `puppeteer-core`, installed with `npm install` in each film project. The included example needs no TTS dependency or key.

## Try the included example

Run this from the cloned skill directory. It copies the sample into a separate folder so generated files never alter the skill:

```bash
DEMO_DIR="$(mktemp -d)"
cp -R assets/. "$DEMO_DIR/"
cp -R examples/angkor/. "$DEMO_DIR/"
cd "$DEMO_DIR"
npm install --no-audit --no-fund
node render.mjs film.html --grid 12
```

Open `out/film-grid.jpg` to inspect the preview. To produce the narrated film, run:

```bash
node mix.mjs film.html
node render.mjs film.html
```

The final film is `out/film-final.mp4`. For the pencil-sketch example, copy `examples/sunflower/` instead of `examples/angkor/`; it needs no voice files at all. The full render takes longer than the preview. See [the example guide](examples/angkor/README.md) and [the skill instructions](SKILL.md) to make your own film.

## Keep credentials out of Git

The Gemini script reads `GEMINI_API_KEY` from your environment; it does not need a key in any project file. Set the variable in your shell or a secret manager, and never paste a real value into `SKILL.md`, narration, examples, commits, or issue reports. This repository ignores common local secret files, virtual environments, dependencies, and render output.

The repository includes a staged-file secret check. Enable the hook in a clone with `git config core.hooksPath .githooks`, then run `python3 scripts/check_secrets.py --all` whenever you want to check the current files. GitHub Actions also scans tracked files on pushes and pull requests. A successful scan reduces risk but cannot guarantee that every possible credential format will be caught. If a real key is ever committed, revoke it and remove it from the repository history before sharing the repository again.
