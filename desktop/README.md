# Nedra desktop

A Tauri 2 application around the React and Gravity UI interface and the production Python vault core. Normal vault operations run offline. No Docker, terminal, database server, or backend TCP listener is needed to use the packaged app.

Installers and signed updater artifacts are built on six native GitHub runners. See [installation and updates](../docs/UPDATING.md#desktop) and [release maintenance](RELEASING.md). Apple Developer ID/notarization and Windows Authenticode signing are not used.

## Launch on macOS

Build with `make desktop-build`, then open `desktop/src-tauri/target/release/bundle/macos/Nedra.app` in Finder. You may copy the complete `.app` to Applications. Do not copy its executable alone. The first screen creates a master password; subsequent launches unlock the persisted vault. Use **Log out**, or **Command/Ctrl+Shift+L**, to lock. Closing the window or quitting terminates the core.

macOS bundles are ad-hoc signed, not notarized, and Gatekeeper can reject an internet download. No library-validation bypass entitlement is added. Tauri updater signatures authorize updates independently of OS publisher signing.

## Data isolation

Nedra uses the production identity `com.nedra.desktop`. Tauri resolves its OS application-local directory:

- macOS: `~/Library/Application Support/com.nedra.desktop/data/vault.db`.
- Windows: the user's Local AppData directory under that identity.
- Linux: `$XDG_DATA_HOME/com.nedra.desktop/data/vault.db`, normally `~/.local/share/...`.

Debug builds use a separate `development/` subdirectory. Release builds ignore environment overrides for the core executable and vault path. Nedra does not scan or import another application identity's directory. Reinstalling the bundle leaves Nedra data untouched. Never delete the data directory to fix a startup failure.

The production storage layer creates POSIX directories `0700` and files `0600`, takes the existing single-process vault lock, checks an existing file read-only before opening it, and uses SQLite WAL, FULL synchronous writes, and the production schema/format identity. Unsupported or damaged vaults are refused, not migrated or replaced. Windows uses the current user's application-local directory and inherited OS ACLs; the installer does not grant other users access.

## Development

Prerequisites: uv, Node 22+, Rust 1.99 (rustup), and native Tauri build prerequisites. On macOS, install Xcode Command Line Tools. On Linux, see the package list in `.github/workflows/desktop.yml`.

```sh
make desktop-setup
make desktop-dev
make desktop-check
make check
```

`desktop-dev` runs Vite and the source Python core from the dedicated venv. Python edits require restarting the app, **not rebuilding PyInstaller**. Frontend edits hot reload. Debug Python and script paths are fixed relative to the checkout; the production binary selects only the bundled executable.

```sh
TAURI_SIGNING_PRIVATE_KEY=/path/to/owner-only/updater.key make desktop-build
```

This freezes Python 3.13.15 as PyInstaller **onedir**, then builds the real app. `requirements-desktop.lock` locks the dedicated runtime without uvicorn, PostgreSQL, CLI or Docker dependencies. `greenlet`, `aiosqlite`, and cryptography are explicit. The frozen runtime reports its actual SQLite version during the ready handshake; the production storage layer rejects an unpatched version. Local macOS builds use SQLite 3.53.1.

## Boundaries

- `backend/`: shared crypto, vault documents, backup format, SQL transactions, validation and endpoint behavior.
- `desktop/core/desktop_core/`: framed pipe server and in-process ASGI adapter. It runs the actual app lifespan. Diagnostics use stderr; stdout is reserved using duplicated descriptors. Header/body lengths are checked before allocation (64 KiB / 24 MiB). Requests, queues and concurrent operations are bounded. Cancellation acknowledges even a task cancelled before it starts.
- `desktop/src-tauri/`: supervisor, capabilities, native dialogs, clipboard and OS lock events. The ready handshake checks both protocol and core version. At most three crash restarts per minute; startup failures show a retry screen. Windows Job Objects fail closed, Linux uses parent-death signals, and macOS uses pipe EOF plus parent monitoring.
- `frontend/src/platform/`: the only platform switch. Axios uses normal HTTP for web builds and binary native IPC for desktop. Desktop sessions stay in memory. No vault key enters Rust or React. Native file paths never enter React; selected backups use expiring, single-use opaque grants.

Manual/idle/native lock destroys the core process and all in-flight key derivations, clears owned clipboard content, invalidates file grants and pending saves, and returns to the locked UI. SQLite rolls back unfinished transactions. A native window hide/navigation removes the old decrypted view before renderer events are processed. The native watchdog enforces trusted core expiry and hidden-window policy even when JavaScript timers cannot execute. The Python core separately enforces idle and absolute expiry; desktop permits one session.

Production capabilities allow only the app's narrow commands and event subscription. No filesystem/shell plugin is exposed. CSP forbids remote scripts/connections; navigation and new windows are restricted. Release devtools are disabled. The webview is incognito and password fields disable autocomplete; these are best-effort webview controls, not guarantees against a compromised OS.

## Files and backups

Attachment/CSV file inputs use the webview's OS picker. Downloads use a native Save dialog and create a new file with restricted permissions. Existing files are refused instead of silently overwritten. External entry links use a protocol allowlist and the system browser.

Backups use Nedra backup format 3 (`.nedrabackup`). Export streams the response to a private encrypted staging file next to the native-selected destination, fsyncs it, then atomically creates the final filename without replacement. Import reads bounded ciphertext chunks through the same production multipart endpoint, preserving auth, validation and transactional rollback. Neither direction sends the whole backup through an IPC frame. Wrong passwords, damage, cancellation, disk errors and a destination creation race must not produce a successful partial export or partially restored records.

An abrupt OS kill can leave a hidden `.nedra-*.partial` file containing ciphertext in the selected export folder. It is never presented as a completed backup and may be removed manually. No plaintext vault staging is used. Exported attachments and CSV source files are plaintext files explicitly chosen by the user.

Atomic backup publication requires a filesystem that supports hard links (for example APFS, NTFS or ext4). Export fails safely on filesystems without this support; choose a local supported folder and then copy the completed encrypted backup elsewhere.

## Native security limits

The clipboard timer runs in Rust while other apps are focused and compares ownership/content before clearing. macOS uses pasteboard change count and the concealed-content history hint; Windows uses its sequence number and monitoring exclusion hint. Linux compares the copied value, and clipboard history/compositor behavior varies. Clipboard managers can ignore hints, and clipboard APIs do not provide a cross-application atomic compare-and-clear guarantee on every OS.

macOS observes workspace sleep, screen sleep and session resignation, plus the undocumented `com.apple.screenIsLocked` notification. Windows registers WTS session and power notifications. Linux listens for logind sleep/session lock and common GNOME/freedesktop screen-saver events; desktops without these services are not guaranteed to notify. A native wall-clock gap check also locks after resume. Linux handlers and Windows handlers require their own native validation; do not infer it from macOS results.

The native window requests content protection. It cannot guarantee capture prevention on Linux/Wayland or against every modern macOS capture API. Python cannot zeroize all key copies, and the renderer necessarily holds displayed plaintext while unlocked. OS compromise, same-user process memory access and malicious clipboard managers remain outside the vault encryption guarantee.

## Updater boundary

The official Tauri updater runs only in Rust. Renderer capabilities expose `update_check`, `update_install` and `update_cancel`, with no endpoint, key, URL or installer arguments. The compiled configuration fixes the HTTPS GitHub endpoint and public key; there are no general updater plugin permissions. `requireSignedVersion` rejects version substitution, and a verified trusted-comment filename binds the artifact to its native target. Release collection renames artifacts before signing those canonical filenames. The plugin verifies before installation as well as after downloading.

The user confirms installation in the existing Update dialog. Only after verification does Rust invalidate native grants, remove decrypted UI, clear the owned clipboard and stop the core. Windows installs per user; macOS/Linux restart after replacement. Debian users receive manual package instructions.
