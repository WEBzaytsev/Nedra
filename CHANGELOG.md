# Changelog

This file records public Nedra releases.

## [5.0.3] - 2026-11-22

- Use a reserved example domain in the Desktop connection form and setup guide.

## [5.0.2] - 2026-11-22

- Added Desktop connection to an existing Nedra server through explicit approval in the system browser, without entering server credentials in Desktop.
- Added server-side connection revocation and a reconnect-only state when access ends, while retaining the local vault and ordinary web login.

## [5.0.1] - 2026-11-21

- Aligned server and browser-extension URL matching for control characters and invalid addresses.
- Improved manual update error reporting and recovery in the web interface.
- Simplified unused code and removed the retired test harnesses without changing the Nedra 5 storage or backup formats.

## [5.0.0] - 2026-11-17

### Independent product boundary

- Established Nedra as the only product identity across the web app, desktop application, browser extension, CLI, MCP server, installers, packages, images, update metadata, SBOMs, storage, protocols, and documentation.
- Introduced the Nedra 5 cryptographic domain, vault format 3, backup format 3, SQLite application id `0x4E454452`, schema 10, `com.nedra.desktop`, new browser-extension identities, Nedra-only storage names, and Nedra-only release artifacts.
- Removed compatibility aliases, old-format backup import, retired-client middleware, transitional update artifacts, and runtime fallback paths.
- Defined the previous installation boundary as a one-time offline conversion with checked snapshots and paired rollback, not a transitional release.

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
- Checked installation snapshots, integrity verification, rollback gates, and reproducible release manifests.

[5.0.2]: https://github.com/WEBzaytsev/Nedra/releases/tag/v5.0.2
[5.0.1]: https://github.com/WEBzaytsev/Nedra/releases/tag/v5.0.1
[5.0.0]: https://github.com/WEBzaytsev/Nedra/releases/tag/v5.0.0
