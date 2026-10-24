# Folio

A small Rust desktop PDF reader with macOS-inspired outline icons and controls. Tauri hosts a local PDF.js reader; the Rust backend handles AI requests.

## Run

Install Rust, Node.js 22.13+ (or 24+), and the [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On Linux, this includes WebKitGTK 4.1 and GTK 3.

```sh
cd folio
npm ci
npm run desktop
```

`npm run dev` opens the reader in a browser for UI development. AI requests require the desktop app.

Build a standalone desktop executable:

```sh
npm run tauri -- build --no-bundle
```

The executable is written to `src-tauri/target/release/folio` (`folio.exe` on Windows). Packaging installers and signing are not configured.

Build a debug executable with `npm run tauri -- build --debug --no-bundle`. The result is at `src-tauri/target/debug/folio` and can run directly without Node.js or a development server. Compiled binaries are not included in this repository.

## Read and ask

1. Open a local PDF with **Open PDF** or Cmd/Ctrl+O.
2. Navigate with the page field, toolbar arrows, left/right arrow keys, or Vim-style **h** (previous page) and **l** (next page). Use **j** to scroll down and **k** to scroll up; holding a key repeats. These shortcuts stay inactive while typing or using Settings. Use the zoom or fit-width controls as needed.
3. Open **AI settings** and enter your endpoint URL, API key, and model.
4. Highlight PDF text, then choose **Summarize** or **Ask selection**. Use **Summarize page** or **Ask page** for the visible page.
5. For a question, type in the question box and click the send arrow (or Cmd/Ctrl+Enter).

Click the expand icon beside a completed AI answer to read it in a large, scrollable popup. The source and question stay with the answer, and the copy button remains available. Close it with **Esc** or the close button to return the same answer to the sidebar.

In the answer popup, **j** and **k** scroll the answer down/up. When the question box is focused, those keys type normally. PDF page navigation stays inactive behind the popup.

Click **PDF fullscreen** beside the zoom controls or press **F11** for fullscreen reading with the AI sidebar and app header hidden. The PDF toolbar, Vim navigation, zoom, and recoloring remain available. Press **Esc**, **F11**, or the fullscreen button again to return. Fullscreen is a temporary viewing mode and is not saved for the next launch.

In PDF fullscreen, right-click the page for **Summarize selection**, **Ask selection**, **Summarize current page**, and **Ask current page**. Selection actions require highlighted PDF text. Questions and answers open in the large popup without leaving fullscreen. The menu supports arrow-key navigation, Enter, and Esc; Esc dismisses the menu or popup before leaving fullscreen.

Provider settings are saved when you click **Use these settings** and restored on the next launch. The sun/moon button switches light/dark mode; **Appearance** in Settings can also follow your system theme. Theme and zoom changes are saved immediately, so closing the app needs no extra save step. PDF pages retain their original colors unless PDF recoloring is enabled.

Press **Ctrl+R** (**Cmd+R** on macOS), or click the half-filled circle next to the zoom controls, to toggle dark PDF recoloring. This gives pages a dark background and light text independently of the app theme, and the preference is remembered. It only changes the display: the file, selected text, and text sent to AI remain original. Images and diagram colors are also recolored; toggle it off when color accuracy matters.

Folio automatically reopens the last PDF on startup at its saved page, using your saved zoom and recoloring preference. Disable **Reopen last PDF on startup** in Settings for an empty reader at launch. After updating from an older build, open a PDF once with **Open PDF** to remember its path. If the file is moved, deleted, or inaccessible, Folio shows a notice and lets you select another file normally.

Reading positions are remembered for the 100 most recently opened PDFs, identified by a local hash of their contents, so selecting a renamed file preserves its position. The native desktop file picker remembers the original path; the document is not copied into the app's settings.

The question box and each answer show their source page. Navigating after choosing **Ask** keeps that original source, even if the displayed page changes. Select **Ask page** again to ask about the new page.

## Provider settings

Use an OpenAI-compatible Chat Completions API with a text response at `choices[0].message.content`. The client uses non-streaming `POST` requests with `model` and `messages`, and Bearer authentication when a key is supplied. See the [Chat Completions API reference](https://developers.openai.com/api/reference/resources/chat).

Examples of endpoint format:

| Endpoint | Request URL |
| --- | --- |
| `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| `https://example.com/custom/chat/completions` | Used as given |
| `http://localhost:11434/v1` | `http://localhost:11434/v1/chat/completions` |

Include your provider's version prefix. HTTPS is required except for HTTP on loopback addresses. A key can be left blank for a local server. Redirects are rejected; configure the final API URL. Provider errors report the HTTP status without displaying potentially sensitive error bodies. Connection timeout is 15 seconds and total request timeout is 90 seconds.

## Privacy and limits

- PDF rendering, fonts, and worker assets stay local. There is no analytics or automatic AI request.
- Only text from the selected passage or chosen page, plus your question, is sent to your configured provider when you trigger an action. That provider's privacy policy applies.
- Endpoint URL, API key, model, appearance, and chosen zoom are saved in `settings.json` in Tauri's app config directory. On Linux, this is normally `~/.config/local.folio.reader/settings.json` (or under `$XDG_CONFIG_HOME`). The API key is stored **unencrypted**. On Linux/macOS, the app creates the directory with owner-only `0700` permissions and the file with `0600` permissions; Windows uses the user profile directory's inherited permissions. Treat the file and any backups as credentials.
- Settings writes replace the file atomically. Failed writes are reported, and the previous settings file is retained. Saved changes survive app close; changes typed into the settings dialog must be applied first.
- If saved settings cannot be read, automatic theme/zoom saves are blocked to protect the existing credentials. Re-enter and apply Settings explicitly to replace the unreadable file.
- The last opened PDF's absolute path and the startup reopening option are saved with your settings. PDF contents, questions, and answers are not copied or saved. Automatic reopening reads the local file only; it never sends text to AI. The application does not store credentials in browser localStorage.
- Text PDFs are supported. Scanned/image-only pages can be viewed but need OCR before AI actions are available. Password-protected PDFs must be unlocked first.
- PDFs are limited to 100 MiB; AI source text to 120,000 characters; questions to 8,000 characters; API responses to 2 MiB. Model-specific context limits still apply.
- No OCR, annotation editing, saved chats, streaming, or installer signing.

## Checks

```sh
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
cargo check --manifest-path src-tauri/Cargo.toml
npm run test:e2e
```

The Rust tests use a real loopback HTTP server and require permission to open local sockets. Browser tests use an installed Google Chrome (`channel: 'chrome'`); install it first or change the channel in `playwright.config.js` to your installed Playwright browser. They render the included three-page fixture (two text pages and a blank page). Only the desktop IPC boundary is replaced in browser tests; the Rust tests cover the real HTTP transport.

PDF rendering and selection use [Mozilla PDF.js](https://mozilla.github.io/pdf.js/examples/), bundled locally under its Apache 2.0 license.
