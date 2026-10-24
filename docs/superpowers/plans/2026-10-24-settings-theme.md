# Saved settings and dark mode

The user requested implementation of saved AI credentials/settings and dark mode. Keep the existing app and dependencies. Save endpoint, key, model, theme and chosen zoom in Tauri's app config directory as JSON. Write atomically with owner-only Unix permissions; disclose that the key is unencrypted. Save changes immediately so normal app close needs no asynchronous exit handler. Defaults follow the system theme until the user chooses light or dark. Keep PDF pages white to preserve document appearance.

Scope: Rust settings storage and IPC registration; frontend restore/save flow and serialized saves; theme toggle and appearance selector; dark CSS for all app controls/dialogs; persistence and theme tests; update privacy documentation; rebuild the executable.

- [x] Write failing storage tests, implement validation/atomic persistence and register commands.
- [x] Restore/save settings, add theme/zoom persistence and dark UI, update browser boundary tests.
- [x] Run relevant checks through test_runner; fix failures, rerun and rebuild executable.

No new dependency or OS keyring integration. Settings are plaintext on disk, protected by local account permissions.

Verification: test_runner confirmed 9 JavaScript tests, 6 Rust storage tests, frontend build, Rust formatting, desktop compile check, and rebuilt debug executable. Existing AI tests: 3 validation tests pass; 3 HTTP tests remain blocked by sandbox local-socket permissions. Browser integration tests were attempted but similarly blocked. Review fixes prevent theme/zoom autosaves from replacing an unreadable credential file and allow appearance-only settings without a provider.
