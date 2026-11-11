<div align="center">

# CipherMoth

**Your secrets stay in the dark.**

A self-hosted and desktop password manager with **encrypted local storage, managed accounts, explicit sharing, and MCP access.**

[![CI](https://github.com/krolbot/ciphermoth/actions/workflows/ci.yml/badge.svg)](https://github.com/krolbot/ciphermoth/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/krolbot/ciphermoth?color=000000&label=release)](https://github.com/krolbot/ciphermoth/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-000000.svg)](./LICENSE)
[![Python](https://img.shields.io/badge/python-3.13-000000.svg)](https://www.python.org/)
[![SQLite](https://img.shields.io/badge/sqlite-3.53-000000.svg)](https://www.sqlite.org/)
[![Desktop](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-7dd3c0.svg?labelColor=000000)](#get-started)

</div>

---

## What is this?

CipherMoth keeps account provisioning and encrypted vault data on infrastructure you control. It has no hosted
CipherMoth account, subscription, telemetry, or vendor cloud.

I wanted something that lives on my own machine, has no telemetry, and doesn't wake up one day
to announce it's been acquired and migrating to some new platform. No Google. No OAuth. No analytics pinging home. Nothing.

It lives on your hardware and keeps secrets in an encrypted local vault. Administrators create human and service
accounts; every active account wraps the same random vault key under its own password or token. Entry access is denied
unless the account owns the entry or has an explicit read/write grant. The optional update check asks GitHub about
releases; vault contents stay put. If someone gets the vault file, they get encrypted blobs, not your passwords.

## Screenshots

|  |  |
|---|---|
| **First run: set up your master password** | **The vault** |
| ![Set up your vault](docs/screenshots/00-login.png) | ![Vault overview](docs/screenshots/01-vault.png) |
| **Add a password, generate a strong one** | **Vault health, computed on your device** |
| ![Add password with generator](docs/screenshots/02-add-generator.png) | ![Vault health report](docs/screenshots/03-health.png) |

## Get started

**[Download the latest release](https://github.com/krolbot/ciphermoth/releases/latest)**. No Python, Docker, or developer tools needed.

| Your machine | Download |
|---|---|
| macOS, Apple Silicon (M-series) | `darwin-aarch64.dmg` |
| macOS, Intel | `darwin-x86_64.dmg` |
| Windows, Intel/AMD | `windows-x86_64.exe` |
| Windows, ARM64 | `windows-aarch64.exe` |
| Linux, Intel/AMD | `linux-x86_64.AppImage` or `.deb` |
| Linux, ARM64 | `linux-aarch64.AppImage` or `.deb` |

Open the DMG and drag **CipherMoth** to Applications, run the Windows installer, or make the Linux AppImage executable and open it. Debian/Ubuntu users can install the `.deb` with `sudo apt install ./<downloaded-file>.deb`.

Open CipherMoth, choose the first administrator name and a strong password, and add your first entry. Your vault lives
in the data folder and survives app updates. The old Alpha app and Docker edition have separate vaults; nothing is moved
automatically.

These are free, unsigned-publisher downloads: macOS may require **System Settings → Privacy & Security → Open Anyway**, and Windows may show a SmartScreen warning. Only approve a download you obtained from this project's release page. Organizational policies may prevent installation. [Installation details and updates](docs/UPDATING.md#desktop-updates) explain the limits; never disable OS protections globally.

**Prefer Docker?** The self-hosted edition is still here, with the same encrypted vault core:

```shell
curl -fsSL https://raw.githubusercontent.com/krolbot/ciphermoth/master/install.sh | sh
```

Then open **[http://localhost:3000](http://localhost:3000)**. [CONTRIBUTING.md](CONTRIBUTING.md) covers manual setup and servers. Coming from 2.0 or PostgreSQL? Read the [upgrade procedure](docs/UPDATING.md) first; those vaults are never converted automatically.

> ⚠️ **There is no external password recovery.** An administrator can reset another human account, but if the only
> administrator loses its password, no reset link, support desk or backdoor can unlock the vault. Keep that credential
> somewhere safe and take a backup once you've added a few entries.

## What it does

- closed registration: the first administrator bootstraps the vault, then administrators provision, disable, reset and remove accounts
- administrator, member and service roles, with session revocation and required password changes
- explicit per-entry read/write grants; no grant means no access
- MCP over streamable HTTP for service accounts, using bearer tokens and the same entry grants as the web UI
- all entry contents encrypted at rest with a random vault key, wrapped independently under each account credential
- store a username, website, tags, folders, a two-factor (TOTP) secret, and your own custom fields alongside each entry, all encrypted, entry names included (see [Security](#security))
- built-in two-factor: paste a 2FA secret, and CipherMoth shows the live rolling code, computed in the browser
- secure notes for free-form secrets (recovery codes, Wi-Fi, passport details), encrypted just like passwords
- attach files to any entry (recovery-code PDFs, license keys, key files), up to 5 MB each, encrypted with your vault key
- search, favorites, folders, tags, and password history to keep a growing vault tidy
- trash for deletions you can restore from or empty for good when you're sure
- light and dark themes that flip across the whole app, toggled by a moth that flutters off as the colours fade (and remembers your pick)
- vault health check that flags weak, reused, and old passwords, entirely on your device
- cryptographically secure password generator (not the `Math.random()` kind) with a strength indicator on every entry
- import from Chrome, Bitwarden, KeePass, Proton Pass, and friends via CSV
- encrypted backups (`.cmbackup`) of every entry visible to the current account, including trash, password history, attachments and settings; account and grant configuration stays in installation snapshots
- a CLI (`ciphermoth`) for the self-hosted edition, and native desktop auto-lock plus clipboard-clearing (for the small things that matter ^^)
- optional desktop update checks through GitHub Releases: you choose when to install, Tauri verifies the signature, and your local vault stays in place. No account or telemetry. AppImage supports built-in updates; Debian uses package updates. Docker images remain signed with cosign

## Users, sharing, and MCP

The first account is an administrator. Registration stays closed: administrators create human accounts or service
accounts from **Users**, can require password changes, revoke sessions, disable accounts, reset human passwords, and
rotate service tokens, and choose each service's allowed MCP operations. Issuing, rotating, or changing those
operations requires the administrator's current password. Tokens are shown once; store them as credentials, not in source control.

Entry owners grant `read` or `write` access explicitly. Service accounts have no web login and can reach only entries
granted to them and operations explicitly enabled for that service. Connect MCP clients to `/mcp` with `Authorization: Bearer <service-token>`;
the streamable HTTP endpoint applies the same grants as the web API after the per-service operation check. A service token is not a
human session token and does not work on `/api`.

## Who it's for (and who it isn't)

CipherMoth is probably a good fit if you:

- want a password manager on your own computer or server, with no vendor account or telemetry
- run a trusted small team and need administrator-managed users, explicit sharing, or MCP agents
- want it to work offline, with optional updates and backups you control
- like small, auditable software and are happy owning your own backups

It's probably not for you (yet) if you need browser autofill, a mobile app, managed cloud sync, public untrusted
multi-tenancy, or a way to recover a forgotten administrator password without another administrator resetting it.

## Security

Straight up, because this is a password manager and you deserve it: **CipherMoth has not been independently audited.**
It's a personal project I use myself and built carefully, with the crypto kept small and readable on purpose, but it has
not been through a formal third-party security review. It's designed for personal use on hardware you trust,
not as a public, untrusted multi-tenant service. Run it only for people and agents you intend to share one vault with.

How it works (the full specification is [docs/VAULT_FORMAT.md](./docs/VAULT_FORMAT.md)):

- each vault has a random 256-bit **vault key**. It is wrapped separately for every active account with AES-256-GCM
  under a key derived from that account's password or service token with **Argon2id** (OWASP 2024 interactive profile,
  a random salt per account). A password commitment derived through the same Argon2id work rejects wrong credentials
  without a cheaper guessing path. New human credentials require at least 12 characters with mixed types;
- **everything you put in an entry is encrypted** with **AES-256-GCM**: its name, username, password or note, website,
  2FA secret, description, tags, folder, custom fields, password history, favorite flag and type, and each attachment's
  name, type and bytes. Every encrypted value is bound to its own record, so it cannot be swapped into another entry
  without being detected. Entries are found by name through a keyed hash (HMAC-SHA256) of the name, never a plaintext
  copy;
- **what the vault file still shows** without an account password: account names, roles and active state; entry owners
  and grants; counts, trash state, timestamps and approximate encrypted record sizes; and timeout settings. Entry names,
  credentials, notes, history, attachment metadata and attachment bytes remain encrypted;
- changing or resetting one account password rewraps the same vault key for that account and revokes its sessions. It
  does not rewrite every entry or affect another account's credential;
- Python owns the vault keys; React authenticates with an **opaque session token**, never a vault key. Desktop sessions stay in memory, and the bundled Python core talks to Rust through private binary pipes: no backend TCP listener. Locking clears the owned clipboard and stops the process holding the keys. The Docker edition keeps vault keys in its server process and the browser's session token in `sessionStorage`;
- unsaved **new-entry drafts** are encrypted in the current tab's `sessionStorage` with AES-256-GCM and a separate per-account draft key. After automatic locking, unlock the same account in the same tab to resume. Creating the entry or cancelling the form removes the draft; closing the tab normally clears it. This is not a backup, and does not preserve edits to existing entries;
- a strict Content-Security-Policy restricts the UI. Desktop release checks run in Rust against the fixed GitHub release source; no vault contents, passwords, session tokens or entry metadata are sent;
- **backups** (`.cmbackup`) are authenticated portable exports of entries visible to the current account, including
  trash, history, attachments and settings. They are encrypted with AES-256-GCM under Argon2id with a fresh salt and
  that account's password. Users, roles and grants are installation state and are preserved by a **snapshot**
  (`ciphermoth-admin snapshot`, see [docs/UPDATING.md](./docs/UPDATING.md#snapshots)), not by a portable backup. A wrong
  password, damaged or cut-off backup changes nothing on restore;
- the Docker UI and API listen on `127.0.0.1` by default; exposing them to other machines is an explicit setting;
- the password generator uses `crypto.getRandomValues` with rejection sampling, no `Math.random()`, no shortcuts;

**It protects against** someone who steals the vault file, a snapshot, a backup or the disk (they get ciphertext and
the metadata listed above, and each password guess costs a full Argon2id run), someone who edits the file without an
account password (changes to encrypted data are detected and the vault refuses to show it), accidental server-side
exposure (the server never persists account passwords, the vault key or session tokens), and casual
inspection of stored data. A session token that leaks works only until that session ends; it never reveals the key.

**It does not protect against** malware or a keylogger on the device you unlock from, a weak account password, exposing
the instance on the public internet without `https`, someone with write access to the vault file rolling it back to an
older copy or deleting entries, or losing every administrator credential. Run it on a machine and network you trust,
use strong passwords, and keep backups and snapshots.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Python 3.13, FastAPI, SQLAlchemy 2.0, aiosqlite |
| Database | SQLite 3.53 (one file, WAL, full sync) |
| Frontend | React 19, Vite, Gravity UI 8, easy-peasy |
| Package manager | uv (backend), npm (frontend) |
| Desktop | Tauri 2, Rust, PyInstaller onedir |
| Infrastructure | Docker, Docker Compose v2, GitHub Actions |

## Docs

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** - hacking on CipherMoth, self-hosting on a server, configuration, and updates
- **[docs/UPDATING.md](./docs/UPDATING.md)** - desktop installation and updates, Docker snapshots and older vaults
- **[desktop/README.md](desktop/README.md)** - native builds, data paths and desktop internals
- **[docs/CLI.md](./docs/CLI.md)** - the `ciphermoth` command-line reference. A plain Docker install already has it: `install.sh` leaves a `cip` script in your CipherMoth folder, so `./cip password list` just works (no Python, no clone)
- **[SECURITY.md](./SECURITY.md)** - reporting a vulnerability
- Logo, wordmark, and favicon live in [`docs/brand/`](./docs/brand)

## License

MIT: see [LICENSE](./LICENSE).
