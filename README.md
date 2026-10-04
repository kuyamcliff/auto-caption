# AutoCaption AE

Offline automatic captions for Adobe After Effects (Windows x64), with
word-accurate timing from WhisperX forced alignment.

Select an audio, video or precomp layer, click **Transcribe**, edit, pick
words-per-line and an animation, and click **Create Text Layers**. Nothing is
uploaded: transcription runs in a bundled local engine.

## Repository layout

| Path | What it is |
| --- | --- |
| `backend/autocaption/` | Local caption engine (Python): 127.0.0.1 HTTP API, job manager, worker process, WhisperX pipeline, self-test |
| `backend/schemas/` | JSON Schemas for engine results and exported projects |
| `extension/src/core/` | Caption engine shared by the panel: segmentation, editing, timing, export/import, animation, AE layer plan (pure TypeScript, unit tested) |
| `extension/src/ui/` | Panel UI (Preact) |
| `extension/src/host/` | Platform adapter (CEP today; the core never touches CEP APIs, so a UXP adapter can replace it) |
| `extension/host/host.jsx` | After Effects ExtendScript: selection, audio render, text layer creation |
| `build/` | Reproducible build: model fetcher, engine folder builder (`build_backend.py`, `make_pak.py`), launcher, release assembler, installer files |
| `docs/marketing/` | The motion ad: HTML timeline, frame renderer, voice-over / sound effect / mix scripts |
| `tests/` | Synthetic audio fixtures with exact ground truth, backend API and long-form tests |

## How timing works

```
selected layer → AE renders the layer's audio from a temporary duplicate comp
  → pyannote VAD → faster-whisper (batched, WhisperX pipeline)
  → wav2vec2 forced alignment per segment (numbers aligned in spoken form)
  → acoustic onset refinement → validated word timings (aligned / inferred / fallback)
  → composition time = render start + word time
  → caption grouping (never changes word timing) → frame-snapped AE text layers
```

Rendering the audio through After Effects means start time, trims, time
stretch, time remap and nested precomps are already applied; the mapping back
to composition time is a pure offset.

## Engine folder (what ships)

```
AutoCaption Engine/
  AutoCaption Engine.exe     launcher; only runs when the panel starts it (--panel + signed launch token)
  engine.pak                 engine code, models and data, read in place (half-precision word-timing weights)
  bin/                       embeddable CPython 3.11, trimmed site-packages, GPU DLLs (cuda/), ffmpeg.exe, manifest.json
  Third-party notices.txt    every bundled component and its license
```

The panel never names the components inside the engine: it shows "Engine",
"Fast" / "Accurate" and plain-language checks. `build_release.py` enforces this
with a wording audit (component names and long dashes in user-facing text).

## Lite edition (under 500 MB)

For machines that already have 64-bit Python 3.11 to 3.13. The download is the
panel plus a 367 MB engine folder: launcher, a lite `engine.pak` (Fast quality,
English word timing, speech detection) and `Set Up Engine.bat`, which creates
`bin\venv` from the user's Python and installs the same pinned libraries
(`setup/requirements.txt`, about 1 GB, once; NVIDIA support optional). The
launcher uses `bin\python.exe` when present (full edition), else `bin\venv`.

Optional add-on packs, dropped next to `engine.pak`, are merged in by the
engine: `Accurate quality.pak` (486 MB) and `More languages.pak` (755 MB,
French/German/Spanish/Italian word timing). Missing levels show as disabled /
"Not included" in the panel.

```
python build/build_lite.py out/lite --models out/models-stage --notices "out/build/AutoCaption Engine/Third-party notices.txt"
python build/build_release.py --lite --engine "out/lite/AutoCaption Engine" --out out/release-lite
```

## Building

Linux or Windows build machine with Python 3.11, Node 22 and mingw-w64:

```
python build/fetch_models.py out/models-stage
python build/build_backend.py "out/build/AutoCaption Engine" --models out/models-stage
python build/build_release.py --engine "out/build/AutoCaption Engine" --out out/release
```

On Windows, `build_release.bat` runs the whole pipeline. Runtime dependencies
are pinned in `build/requirements-win.lock`; model revisions are pinned in
`build/fetch_models.py`.

## Tests

```
cd extension && npx vitest run            # core + ExtendScript host (mock AE) tests
node tests/ui/e2e.mjs <engine dir> <shots>   # real panel in Chromium + real engine + simulated AE host
python tests/backend/run_backend_tests.py --cmd "python -m autocaption"   # API, security, timing, cancel
python tests/backend/run_longform.py --cmd "python -m autocaption"        # 10 s .. 60 min
```

Timing tolerance (synthetic fixtures with sample-exact ground truth): median
word-start error ≤ 80 ms and ≥ 90 % of words within 150 ms. Measured medians
are about 10 ms on clean speech.

## License

MIT for this project. Bundled third-party components keep their own licenses
(see `AutoCaption Engine/Third-party notices.txt` in the release). The French,
German, Spanish and Italian word-timing models are CC BY-NC 4.0.

Made by cyriqvfx.
