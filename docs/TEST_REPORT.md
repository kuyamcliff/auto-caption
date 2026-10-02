# AutoCaption AE 1.0.0: test report

Everything below was actually run during the build. Where something could
not be run in the build environment (a Linux container without After Effects,
Windows or an NVIDIA GPU), it is listed under **Not tested** instead of being
reported as passing.

Build environment: Ubuntu 24.04 container, 4 CPU cores, 15 GB RAM, no GPU.
The Windows backend was tested by running the **packaged Windows x64 build**
under Wine 11.18 with networking disabled (`unshare -rn`). The panel was tested
in Chromium with the real panel bundle, the real engine, and a scripted
After Effects host.

## Release

| Item | Value |
| --- | --- |
| Archive | `AutoCaptionAE_COMPLETE_v1.0.0.zip` |
| Size | 5,228,794,586 bytes (5.23 GB), 28,319 entries |
| SHA-256 | `a6a87a818696697ad3a3f60a6b15a8c3d6542d12e5123441ff1e8c7aaa4b9191` |
| MD5 | `f15f2514cdf14de8a7ebfb4c40ebf57d` (matches the MD5 GoFile reported after upload) |
| Download | https://gofile.io/d/tOIEIw7i |
| Extension (unpacked) | 0.2 MB |
| Backend (unpacked) | 5.78 GB: runtime 1.1 GB, CUDA DLLs 1.92 GB, models 2.54 GB, FFmpeg 0.1 GB |
| Models | Whisper base 148 MB, small 486 MB; alignment en/fr/de/es/it 378 MB each; VAD 18 MB |

Pinned versions: CPython 3.11.9 (embeddable), WhisperX 3.8.6, faster-whisper
1.2.1, CTranslate2 4.8.2, PyTorch/torchaudio 2.8.0 (CPU), pyannote.audio 4.0.7,
FFmpeg 9.0.2, cuBLAS 12.9 + cuDNN 9.27. The full lock is
`build/requirements-win.lock`, and model revisions are in `build/fetch_models.py`
and `backend/manifest.json`.

## Final archive test (extracted into a new directory)

| Check | Result |
| --- | --- |
| Archive CRC of every member | PASS |
| `checksums.txt` entries | PASS (all OK) |
| `backend/manifest.json`: SHA-256 of all 15,719 backend files | PASS (0 mismatches) |
| Backend `--self-test --full`, offline, Windows build under Wine | PASS (12/12; GPU "not available" on this machine) |
| Panel UI end-to-end, offline, extension from the extracted archive | PASS (30/30) |
| Backend moved to `C:\Tools\Auto Caption AE\backend` and self-tested | PASS |

## Unit tests (`extension/`, vitest): 56/56 PASS

Covered:
- **Segmentation:** deterministic results, word limit, the spec's example, sentence and clause breaks, pauses, article/number rules.
- **Line balancing** and caption display timing.
- **Timeline cases A–H:** comp at 0, non-zero comp start, layer offset, trims, 50% stretch, nested precomp, 8 frame rates, reversed layer.
- **Editing:** inserted words marked inferred, 1:1 corrections, deletions, split, merge, timing edits, locked regrouping, reset.
- **Infrastructure:** undo/redo, project JSON round trip, SRT/VTT/TXT/ASS export, SRT/VTT import, the animation formulas, presets.
- **ExtendScript host** against a mock AE object model:
  - parses as ES3;
  - audio render from a temporary duplicate comp, leaving the original layers and the user's render queue untouched;
  - frame-accurate layer creation;
  - "Replace" removes only AutoCaption layers.

## Backend API tests (`tests/backend/run_backend_tests.py`)

Linux dev build: **55/55**. Packaged Windows build under Wine, offline: **57/58**.

Covered:
- **Security:** token required, Host-header check, relative, traversal and device paths rejected, unexpected fields rejected, job id validation, version compatibility.
- **Timing accuracy** on every fixture (below).
- **Alignment endpoint** with known text.
- **Concurrency:** a second concurrent job is refused (409).
- **Cancellation:** the job stops and its temp audio is removed; the engine still works afterwards.
- **Diagnostics:** no token leaks.

Word-start error against sample-exact ground truth (packaged Windows build, Whisper Base):

| Fixture | Words matched | Median | p95 |
| --- | --- | --- | --- |
| clean_english | 17/18 | 11 ms | 14 ms |
| fast_english | 16/18 | 12 ms | 153 ms |
| slow_english | 10/10 | 11.5 ms | 57 ms |
| leading_silence (3 s) | 6/6 | 9.5 ms | 14 ms |
| trailing_silence (4 s) | 5/6 | 11 ms | 14 ms |
| multiple_pauses | **5/12** | 12 ms | 13 ms |
| numbers ($25, 1999, 42) | 8/10 | 10 ms | 13 ms |
| punctuation / apostrophes / hyphens | 9/9 | 10 ms | 14 ms |
| quiet_speech (-30 dB) | 17/18 | 10 ms | 13 ms |
| music_speech | 17/18 | 13 ms | 148 ms |
| background_noise (-24 dB white noise, stress) | 13/18 | 58 ms | 522 ms |
| stereo 44.1 kHz / 48 kHz | 17/18 | 11 ms | 14 ms |
| short (2 words) | 2/2 | 11.5 ms | 13 ms |
| silence | no words invented (SILENT_AUDIO) | | |
| long (5 min, auto language) | 572/624 | 9 ms | 14 ms |
| align known text | 18/18 | 9.5 ms | 13 ms |

**Tolerance:** median ≤ 80 ms, and ≥ 90% of words within 150 ms. This was
chosen after measuring the results above. wav2vec2 frames are 20 ms, and
acoustic onset refinement brought the medians from 60–90 ms down to about 10 ms.

**The one failure:** `multiple_pauses` under Wine. Whisper Base output only 7
words; the Linux build of the same code gets 10/12. The words it did produce are
aligned within 13 ms, so this is a recognition difference, not an alignment
error. I could not establish whether it also happens on native Windows.

## Long-form (Linux build of the same engine, 4 CPU cores, Whisper Base)

| Minutes | Wall time | × realtime | Peak RAM | Words | Median | p95 | Temp cleaned |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.17 | 28.3 s (includes engine cold start) | 2.77 | 1.6 GB | 21/21 | 10 ms | 82 ms | yes |
| 1 | 9.3 s | 0.16 | 2.0 GB | 112/125 | 9 ms | 13 ms | yes |
| 5 | 178.7 s* | 0.60 | 2.3 GB | 579/624 | 9 ms | 14 ms | yes |
| 15 | 331 s* | 0.37 | 2.6 GB | 1733/1873 | 9 ms | 14 ms | yes |
| 30 | 436 s | 0.24 | 2.6 GB | 3476/3748 | 9 ms | 14 ms | yes |
| 60 | 505 s | 0.14 | 2.9 GB | 6951/7498 | 9 ms | 14 ms | yes |

\* These runs overlapped with release archive compression on the same 4 cores,
so their wall times are inflated.

## Offline / network audit

- **Backend offline:** every backend test above ran inside a network namespace with only loopback.
- **Panel offline:** the UI end-to-end run was also offline.
- **Code audit** (`reports/network_audit.txt`): runtime code only connects to 127.0.0.1. Library downloads and telemetry are disabled through `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `HF_HUB_DISABLE_TELEMETRY` and `PYANNOTE_METRICS_ENABLED=0`. Every download URL is in `build/` (build time only).
- **Placeholder scan:** no TODO/FIXME/MOCK/STUB/etc. in shipped source.

## Not tested (no access in the build environment)

- **Inside After Effects.**
  - `host.jsx` was validated as ES3 and exercised against a mock AE object model, but never in After Effects.
  - The output-module template choice for audio-only render ("WAV", else "AIFF 48kHz") depends on the templates your AE version ships.
  - The text animator / expression-selector property match names follow Adobe's documented names but were not executed in AE.
- **The CEP runtime.** The panel ran in Chromium with a test platform layer, not in CEP. `src/host/cep.ts` (Node `child_process`, CEP file dialogs, `evalScript`) is untested.
- **Native Windows.** The backend was tested under Wine 11, not Windows 10/11. `INSTALL_EXTENSION.bat` / `tools/install.ps1` and `VERIFY_INSTALLATION.bat` were not executed (no PowerShell or Windows registry here).
- **GPU.** There is no GPU here. The bundled cuBLAS/cuDNN path is untested; the code falls back to CPU if CUDA cannot initialise.

## Issues found and fixed during testing

1. **Late word starts.** CTC alignment placed starts 60–200 ms late. Fixed with speech-band onset refinement; medians are now about 10 ms.
2. **Silent alignment failure.** NLTK refuses hard-linked data files, and the result was a silent fallback to proportional timing. NLTK data is never hard-linked now, and a total alignment failure raises a visible warning.
3. **Windows pipe deadlock.** A thread blocked reading a pipe stalled imports in the worker process (Windows synchronous-pipe semantics). Worker commands now use an authenticated localhost socket. The launcher watches its parent process instead of reading stdin.
4. **Launcher stdio.** Std-handle inheritance in the launcher was made robust (missing or invalid handles fall back to NUL).
5. **Temp-file ordering.** Temp audio is now deleted before a job reports its final state.
6. **Panel bugs:** menus were clipped inside scrolling lists (now portaled), Enter re-opened the caption editor, the 300 px layout overflowed, and the paused preview could show an empty stage.

## Screenshots

`docs/screenshots/`: verification, caption editor, animation/style panel, wide layout.
