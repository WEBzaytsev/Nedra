# Changelog

This file records public Nedra releases. Development history before the independent Nedra release line is intentionally not presented as a product release history.

## [4.0.0] - 2026-11-17

### Product

- Established Nedra as the canonical product in `WEBzaytsev/Nedra`.
- Replaced the former product identity across the web app, desktop application, browser extension, CLI, MCP server, installers, packages, images, update metadata, SBOMs, and documentation.
- Introduced canonical `nedra`, `nedra-admin`, `NEDRA_*`, `nedra-*` package, and `ghcr.io/webzaytsev/nedra-*` names.
- Retained bounded compatibility readers and migration paths where changing an authenticated storage or installed-client identifier in place would make existing vaults, backups, pairings, or desktop installations unreadable.

### Vault and access

- Multi-user accounts, groups, folders, explicit and expiring read/write grants, session revocation, administrator-assisted reset, and independent MCP service permissions.
- AES-256-GCM encrypted entries, names, history, TOTP secrets, custom fields, favorites, attachments, settings, and authenticated portable backups.
- Voluntary security keys, recovery codes, browser device unlock, and private native Touch ID/Secure Enclave operations.
- Bulk move, trash, restore, purge, filters, context actions, keyboard operations, and guarded undo receipts.

### Clients and delivery

- Responsive Gravity UI web application without MUI compatibility layers.
- Chromium and Firefox extension with server and native desktop transports.
- Tauri desktop applications for macOS, Windows, and Linux, including native packaging and signed update verification.
- Multi-architecture container images with deterministic CycloneDX SBOMs, BuildKit provenance, and keyless cosign signatures.
- Checked schema migrations, installation snapshots, integrity verification, rollback gates, and reproducible release manifests.

[4.0.0]: https://github.com/WEBzaytsev/Nedra/releases/tag/v4.0.0
