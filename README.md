<div align="center">

# Nedra

**A self-hosted password manager for teams and local AI agents.**

[![CI](https://github.com/WEBzaytsev/Nedra/actions/workflows/ci.yml/badge.svg)](https://github.com/WEBzaytsev/Nedra/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-151515.svg)](./LICENSE)

</div>

Nedra combines an encrypted vault, managed users, groups, explicit read/write sharing, browser integration, native desktop applications, and scoped MCP access in one product. It runs on infrastructure you control and has no hosted account, subscription, telemetry, or vendor cloud.

## Capabilities

- administrator-managed human and service accounts;
- users, groups, folders, expiring grants, and per-entry read/write access;
- encrypted passwords, secure notes, TOTP seeds, custom fields, history, and attachments;
- recovery, administrator-assisted access reset, voluntary security keys, and device unlock;
- bulk move, trash, restore, purge, filters, keyboard actions, and local undo;
- Chromium and Firefox extension for explicit search, fill, copy, and TOTP actions;
- native macOS, Windows, and Linux applications built with Tauri;
- MCP service accounts with independent operation permissions and the same entry ACLs;
- authenticated portable backups, installation snapshots, and strict schema validation;
- signed desktop updates and signed multi-architecture container images with SBOM and provenance.

## Quick start

### Docker Compose

```shell
git clone https://github.com/WEBzaytsev/Nedra.git
cd Nedra
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The first account becomes the administrator; registration is closed after bootstrap.

For a release installation:

```shell
curl -fsSL https://raw.githubusercontent.com/WEBzaytsev/Nedra/main/install.sh | sh
```

The production Compose file binds the UI and API to `127.0.0.1` by default. Put HTTPS in front before exposing an installation beyond the local machine. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the supported environment variables and server setup.

### Desktop

Download the package for your platform from [GitHub Releases](https://github.com/WEBzaytsev/Nedra/releases):

- macOS: Apple Silicon or Intel DMG;
- Windows: x64 or ARM64 installer;
- Linux: x64 or ARM64 AppImage and Debian package.

Desktop vaults are local. The application can pair with the Nedra browser extension without exposing a TCP listener. Update packages are verified with the embedded release key before installation.

## Security model

Nedra is **server-trusted**, not zero-knowledge. Each vault has a random 256-bit key. Every active human or service account receives its own authenticated wrapper of that key; entry contents are encrypted with AES-256-GCM. The server process holds the opened key while a vault is unlocked and enforces users, groups, ACLs, service permissions, and session policy.

A stolen database exposes account names, roles, grant metadata, counts, timestamps, and ciphertext sizes, but not entry names or contents. Nedra does not protect an unlocked device from malware, a compromised server process, weak credentials, rollback by someone who controls the storage, or loss of every administrator credential.

The cryptographic and storage contracts are documented in [docs/VAULT_FORMAT.md](./docs/VAULT_FORMAT.md). Nedra has not received an independent security audit; report vulnerabilities through [GitHub Security Advisories](https://github.com/WEBzaytsev/Nedra/security/advisories/new).

## Repository

```text
backend/             FastAPI vault, CLI, MCP, storage, and tests
desktop/             Tauri application, private core, packaging, and updater
extension/           Chromium and Firefox extension
frontend/            React and Gravity UI web interface
docker/              production images and runtime validation
docs/                operator, CLI, extension, and vault-format documentation
testdata/             interoperability and cryptographic vectors
```

Important documentation:

- [Installation and updates](./docs/UPDATING.md)
- [Command-line interface](./docs/CLI.md)
- [Browser extension](./docs/EXTENSION.md)
- [Vault format](./docs/VAULT_FORMAT.md)
- [Desktop development and packaging](./desktop/README.md)
- [Contributing and self-hosting](./CONTRIBUTING.md)

## Development

The backend requires Python 3.13 and `uv`; the frontend and extension require Node.js 22 and npm; desktop builds additionally require Rust and the platform Tauri dependencies.

```shell
make test
```

The release workflows build natively for amd64 and arm64, verify installed desktop packages and update fixtures, produce CycloneDX SBOMs, and publish only after the required checks pass.

## License

MIT. See [LICENSE](./LICENSE).