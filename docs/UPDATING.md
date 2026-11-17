# Updating Nedra

## Desktop

Download the package for your operating system and CPU from [GitHub Releases](https://github.com/WEBzaytsev/Nedra/releases/latest). The app includes its private Python core; Python, Docker, and development tools are not required.

- **macOS:** open the DMG and copy Nedra to Applications. Builds are ad-hoc signed but not notarized. If Gatekeeper blocks a trusted download, use **System Settings → Privacy & Security → Open Anyway** when macOS offers it; do not disable Gatekeeper globally.
- **Windows:** run the x64 or ARM64 NSIS installer. Builds are not Authenticode-signed, so SmartScreen may warn. Do not disable organizational security policy to install them.
- **Linux AppImage:** keep the file in a user-writable directory, make it executable, and run it. Built-in updates replace the AppImage in place.
- **Debian/Ubuntu:** install the `.deb` with `sudo apt install ./Nedra_*.deb`. Install a newer package the same way.

When update checks are enabled, Nedra reads `latest.json` from this repository after unlock. Installation starts only after **Download and install**. The Tauri updater verifies the embedded public key, signed version, target, and artifact before it closes the vault and launches the installer. An update check sends no vault contents, credentials, sessions, or entry metadata; GitHub still receives ordinary connection metadata.

Nedra 5 starts the independent desktop identity `com.nedra.desktop` and its own application-data directory. It does not discover, import, or update another application's local data, extension pairing, browser storage, or device registrations. Do not move an encrypted database between application identities. Use the one-time offline migration procedure below.

## Self-hosted Docker installation

Nedra stores the complete installation in its `vault_data` volume. Create a checked snapshot before replacing containers:

```shell
docker compose -f docker-compose.prod.yml exec backend nedra-admin snapshot
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker compose -f docker-compose.prod.yml exec backend nedra-admin check
```

`NEDRA_VERSION` selects `latest` or an exact release such as `5.0.0`. Sessions are memory-only and users must unlock again after a restart.

Published images are multi-architecture and signed by the release workflow. Verify both image references before a controlled deployment:

```shell
cosign verify ghcr.io/webzaytsev/nedra-backend:5.0.0 \
  --certificate-identity 'https://github.com/WEBzaytsev/Nedra/.github/workflows/release.yml@refs/tags/v5.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify ghcr.io/webzaytsev/nedra-frontend:5.0.0 \
  --certificate-identity 'https://github.com/WEBzaytsev/Nedra/.github/workflows/release.yml@refs/tags/v5.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Nedra 5 boundary and one-time migration

Nedra 5 is intentionally incompatible with installations that use another application identity, SQLite application id, schema, cryptographic domain, backup header, browser database, extension identity, native-host name, bundle id, Compose project, environment prefix, request header, or release artifact name. The runtime has no compatibility aliases, old-format decoder, automatic fallback, or transitional updater artifact.

A cutover is an offline operator procedure, not a transitional release:

1. Stop writes and keep the old service stopped for the entire conversion.
2. Create a consistent SQLite snapshot with the old runtime and verify its integrity and foreign keys.
3. Keep that snapshot and the old exact image references as the rollback pair.
4. Run the bounded offline converter against a copy. It decrypts with an authorized administrator credential, rewrites every authenticated value into the Nedra 5 domain, sets SQLite application id `0x4E454452`, schema `10`, and vault format `3`, and invalidates credentials that cannot be rewrapped without their owners.
5. Verify the converted file with `nedra-admin check`, then decrypt every entry and attachment through the normal Nedra 5 API before publication.
6. Start a clean Nedra 5 Compose project and volume. Do not reuse the old project name or volume.
7. Administrators reset affected human credentials and rotate MCP service tokens. Users re-enrol security keys, device unlock, Touch ID, browser extension pairing, and recovery codes.
8. Verify public health, login, ACL, MCP permissions, entry counts, attachments, backup export/import, and audit records before reopening writes.

Portable `.nedrabackup` files contain only entries visible to one account plus trash, history, attachments, folders, and settings. They do **not** contain users, roles, groups, grants, service accounts, factors, device registrations, or recovery state, so they are not a substitute for the full offline conversion.

Rollback means stopping Nedra 5 and restoring the old exact runtime together with its untouched pre-conversion snapshot. Never open a converted schema-10 vault with the old runtime, and never restore only one half of the pair.

## Snapshots, backups, and recovery

A **snapshot** is a checked SQLite copy of the whole installation, including accounts, groups, grants, and service permissions. `nedra-admin snapshot` uses SQLite's online backup API, includes committed WAL data, runs integrity and foreign-key checks, fsyncs the result, and publishes it under `/data/snapshots/`. Do not copy a live `vault.db` by itself.

A portable **backup** (`.nedrabackup`) contains entries visible to one account, including trash, history, attachments, folders, and settings. New exports use only Nedra backup format 3. Other backup headers and payload versions are refused.

Check either the live vault or a snapshot:

```shell
docker compose -f docker-compose.prod.yml exec backend nedra-admin check
docker compose -f docker-compose.prod.yml exec backend \
  nedra-admin check /data/snapshots/vault-<time>.db
```

Restore only while the backend is stopped:

```shell
docker compose -f docker-compose.prod.yml stop backend
docker compose -f docker-compose.prod.yml run --rm backend \
  nedra-admin restore /data/snapshots/vault-<time>.db
docker compose -f docker-compose.prod.yml start backend
```

Restore validates the candidate before replacement and keeps the displaced vault under `/data/snapshots/replaced-<time>/`. Changes committed after the restored snapshot are lost.

## Supported format

Nedra 5 creates and opens only SQLite application id `0x4E454452`, schema `10`, and vault format `3`. It does not migrate an older database on startup and does not expose historical `migrate-*` commands. An unknown application id, schema, vault format, backup header, or backup payload is refused before mutation.

## Failure handling

- If SQLite integrity or foreign-key checks fail, restore the latest known-good snapshot.
- If the vault was written by another schema or format, stop; do not edit `PRAGMA` values by hand.
- If another process owns the data directory, run only one backend against the volume.
- If permissions are wrong, the container runs as uid 1000; fix ownership of a bind-mounted data directory rather than weakening permissions.
- If individual encrypted rows are damaged, the UI reports them and `nedra damaged` lists them. Restore a snapshot or explicitly remove only the rechecked damaged rows with `nedra damaged --remove`.
