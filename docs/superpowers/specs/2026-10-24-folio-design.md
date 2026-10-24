# Folio

Build a simple Rust desktop PDF reader with an embedded web interface. The user approved this approach and asked to proceed. Use macOS-inspired outline icons and controls, not Material You.

## Behavior

Open a local PDF, render one page at a time with selectable text, previous/next and page-number navigation, and zoom. A sidebar offers summarize selection, ask selection, summarize page, and ask page. Questions use a text box. Freeze the source text and page label when an action starts so later navigation cannot relabel the answer.

Settings accept an OpenAI-compatible base URL (including version prefix) or full chat-completions URL, API key, and model. Keep credentials and settings in memory only. The Rust client sends Chat Completions requests, with timeout, bounded input and response sizes, no redirects, and HTTPS except loopback HTTP. No network request happens until an AI action. Render responses as text, never HTML.

## Approaches

The chosen Tauri + PDF.js approach supplies mature selectable PDF rendering and a Rust HTTP backend. Fully native Rust UI was considered but needs considerably more PDF selection work. Use vanilla JavaScript and CSS rather than a UI framework.

## Limits and risks

No OCR, annotations, cloud storage, persistence, streaming, or cross-document chat. Image-only pages show a clear text-unavailable message. PDF contents sent to the configured service are subject to that service's policies. PDF rendering stays local, including fonts and worker assets. Existing exercise projects are untouched.

## Validation

Rust tests exercise URL/input validation and real HTTP against a local stub. Frontend tests exercise extraction, selection boundaries, and source snapshots. A browser test opens a two-page fixture and verifies navigation, selection, all AI actions, settings, and error states. Compile the desktop app and build bundled frontend assets.
