# Optional TTS Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add downloadable local read-aloud while keeping inference out of the base executable.

**Architecture:** Rust verifies and installs a pinned engine/English voice pack, manages its process, and proxies synthesis. A small frontend controller queues WAV chunks and provides shared playback controls.

**Tech Stack:** Existing Tauri, reqwest, plain JavaScript; SHA-256 and minimal archive decoding. No inference dependency.

**Spec:** `docs/superpowers/specs/2026-11-08-optional-tts-design.md`

## Global Constraints

- No bundled inference engine/models; no Python or cloud speech dependency.
- Explicit opt-in download, verified artifacts, atomic installation, local inference.
- Initial English Alba voice; summaries and PDF selections including fullscreen.
- Required test_runner checks and release-size measurement before completion.

## Review Focus

- Corrupt/truncated downloads must never become executable installations.
- Stop/new text/tab switch must suppress late audio and kill the owned process.
- Setup and narration must work without AI credentials.
- Fullscreen and modal dialogs must keep playback controls/errors usable.
- Missing files, unsupported targets, offline setup, and subprocess failures must be actionable.

### Task 1: Optional engine and voice installation

**Files:** Create `src-tauri/src/tts.rs`, `src-tauri/src/tts_catalog.json`, `src-tauri/src/tts_english.yaml`, `src-tauri/tests/tts.rs`; update `Cargo.toml`, `lib.rs`, `main.rs`.

**Interfaces:** `TtsManager`, `status(directory)`, `install(directory)`, `stop()`, `remove(directory)`, `synthesize(directory, text, request_id)`; Tauri commands `tts_status`, `tts_install`, `tts_stop`, `tts_remove`, `tts_synthesize`.

- [x] Add failing tests for checksum/size rejection, missing installations, cancellation, bounded audio, and process shutdown.
- [x] Implement pinned artifact download, safe extraction, staged installation and app-managed process lifetime.
- [x] Verify Rust tests; exercise the actual downloaded runtime with local model assets.

### Task 2: Playback controller and reader controls

**Files:** Create `src/tts.js`, `tests/tts.test.js`; update `index.html`, `src/main.js`, `src/style.css`, `tauri.conf.json`, `tests/reader.spec.js`.

**Interfaces:** `speechChunks(text)`, `createSpeechPlayer({synthesize,stopEngine,createAudio,onChange})`, `play(text,label)`, `pause()`, `resume()`, `stop()`, `setRate(rate)`.

- [x] Add failing tests for line-break normalization, bounded chunks, stale synthesis, paused pending audio, and failed playback.
- [x] Implement shared playback plus optional setup/download UI, selection and answer entry points, fullscreen access and cleanup.
- [x] Add browser regression coverage and run JavaScript checks.

### Task 3: Verification, packaging and documentation

**Files:** Update `README.md`, release profile in `src-tauri/Cargo.toml`, and this plan.

- [x] Document installation, offline behavior, storage, limits and removal.
- [x] Run test_runner over unit/browser tests, Rust checks and production frontend build. Fix regressions and rerun affected checks.
- [x] Build release executable; record size and real-engine smoke results.
- [x] Review the full diff and record any platform verification limits.

## Execution record

- Pinned Pocket TTS v4.0.0 release assets (upstream binary reports 3.3.0), English model, Alba embedding, and tokenizer. SHA-256 checks caught an interrupted smoke-test download before it was accepted.
- Real native CLI smoke: generated 4.4 seconds of audio in 1.465 seconds on the local i7-1165G7. Engine and voice files remained outside the app executable.
- Linux x86_64 release: 9,660,136 bytes unpacked; portable archive 5,260,379 bytes. Archive contains only `folio`.
- Independent review found and verified fixes for stale preflight narration, inter-chunk replay, initial-request cancellation, and installation preflight cancellation. Download and playback cancellation now use independent counters, so reading navigation does not cancel downloads.
- Linux build/runtime verified locally. macOS and Windows build/runtime checks remain for their native environments; no cross-platform success is claimed.
- Final test_runner verification: 32 JavaScript unit tests and 35 browser tests passed; Rust suite, rustfmt, Cargo check, production frontend build, and the separately invoked real managed-runtime integration test passed. The initial shared-server browser interruption was resolved by an isolated full-suite rerun. Vite retains its existing large-chunk advisory.
