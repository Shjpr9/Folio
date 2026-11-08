# Optional local read-aloud

The base Folio download stays small. No speech inference library, model, Python environment, or engine executable is linked or bundled into it. Users explicitly download an optional native Pocket TTS runtime and one English Alba voice. Downloads and documents are independent of AI-provider settings.

The user approved this architecture and requested planning and implementation. Implementation proceeds inline; the required test_runner verifies the change before completion.

## Approaches

Embedding sherpa-onnx would offer a useful API but enlarge every Folio download. Loading an optional shared library adds ABI and packaging complexity. The selected approach downloads a pinned standalone Pocket TTS executable and model assets, runs it as an app-managed loopback service, and sends text through Rust. This preserves the base-size requirement and avoids Python.

## Behavior

- Settings contains Read aloud with download size, progress, cancellation, retry, and removal. Nothing downloads or starts automatically at launch.
- The initial pack is English / Alba, CPU only. Other engines, languages, voice cloning, automatic narration, and audio export are outside this change.
- Read selection and Read answer feed the same playback controller. Selection is captured before controls change focus. Fullscreen selection actions and expanded answers are supported.
- Playback has pause/resume, stop, and speed. Stop/tab changes/new answers invalidate pending audio; stopping also terminates the optional process to cancel computation and release memory.
- Text is normalized and split into bounded sentence chunks. The frontend plays WAV chunks and prefetches at most one chunk. UI errors remain visible in fullscreen and dialogs.
- Engine and model downloads use pinned HTTPS URLs, explicit size limits, and SHA-256 verification. Installation is staged and published only when complete. Cancel/failure never marks a partial pack installed.
- Engine binds to loopback only, runs without a shell, uses local model paths, and is terminated on application exit. Speech text is never sent to an AI/cloud provider.
- Runtime code is optional; model files live in the app data directory. Release size is measured; approximately 6 MB is a target, not an unverified claim.

## Validation

Rust tests cover artifact integrity, installation rollback, text limits, managed process lifecycle, and HTTP/audio boundaries. JavaScript tests cover chunking, cancellation, pause, playback errors, and stale results. Browser tests cover opt-in setup, selected text, summary narration, popup/fullscreen controls, and removal. A real engine smoke test and release build establish practical compatibility and size where the environment permits.
