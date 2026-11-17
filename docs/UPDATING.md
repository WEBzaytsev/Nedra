# Updating Nedra

## Desktop

Download the package for your operating system and CPU from [GitHub Releases](https://github.com/WEBzaytsev/Nedra/releases/latest). The app includes its private Python core; Python, Docker, and development tools are not required.

- **macOS:** open the DMG and copy Nedra to Applications. Builds are ad-hoc signed but not notarized. If Gatekeeper blocks a trusted download, use **System Settings → Privacy & Security → Open Anyway** when macOS offers it; do not disable Gatekeeper globally.
- **Windows:** run the x64 or ARM64 NSIS installer. Builds are not Authenticode-signed, so SmartScreen may warn. Do not disable organizational security policy to install them.
- **Linux AppImage:** keep the file in a user-writable directory, make it executable, and run it. Built-in updates replace the AppImage in place.
- **Debian/Ubuntu:** install the `.deb` with `sudo apt install ./Nedra_*.deb`. Install a newer package the same way.

When update checks are enabled, Nedra reads `latest.json` from this repository after unlock. Installation starts only after **Download and install**. The Tauri updater verifies the embedded public key, signed version, target, and artifact before it closes the vault and launches the installer. An update check sends no vault contents, credentials, sessions, or entry metadata; GitHub still receives ordinary connection metadata.

The production bundle and native-host identifier remains `com.ciphermoth.desktop` solely so Nedra 4 updates existing desktop installations in place and keeps their local vault and browser pairing. It is a frozen compatibility identifier, not the product name. The updater public key is likewise retained across the rename. Never delete an application-data directory to repair an update.

## Self-hosted Docker installation

Nedra stores the complete installation in the `vault_data` volume. Create a checked snapshot before replacing containers:

```shell
docker compose -f docker-compose.prod.yml exec backend nedra-admin snapshot
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker compose -f docker-compose.prod.yml exec backend nedra-admin check
```

`NEDRA_VERSION` selects `latest` or an exact release such as `4.0.0`. Sessions are memory-only and users must unlock again after a restart.

Published images are multi-architecture and signed by the release workflow. Verify both image references before a controlled deployment:

```shell
cosign verify ghcr.io/webzaytsev/nedra-backend:4.0.0 \
  --certificate-identity 'https://github.com/WEBzaytsev/Nedra/.github/workflows/release.yml@refs/tags/v4.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify ghcr.io/webzaytsev/nedra-frontend:4.0.0 \
  --certificate-identity 'https://github.com/WEBzaytsev/Nedra/.github/workflows/release.yml@refs/tags/v4.0.0' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Snapshots, backups, and rollback

A **snapshot** is a checked SQLite copy of the whole installation, including accounts, groups, grants, and service permissions. `nedra-admin snapshot` uses SQLite's online backup API, includes committed WAL data, runs integrity and foreign-key checks, fsyncs the result, and publishes it under `/data/snapshots/`. Do not copy a live `vault.db` by itself.

A portable **backup** (`.cmbackup`) contains entries visible to one account, including trash, history, attachments, and settings. It does not contain users, roles, grants, factors, or device registrations. Keep both snapshots and portable backups.

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

Restore validates the candidate before replacement and keeps the displaced vault under `/data/snapshots/replaced-<time>/`. Changes committed after the restored snapshot are lost. To roll application code back, pin the previous image version and restore the pre-update snapshot with a release that understands that schema.

## Schema migrations

Nedra 4 uses schema 9. A server refuses an older or newer schema instead of mutating it on startup. Stop the backend and run the exact checked migrations required by the reported source schema. Each command creates its own rollback snapshot and applies its changes in one transaction.

```shell
# schema 6 → 7
docker compose -f docker-compose.prod.yml run --rm backend \
  nedra-admin migrate-hardware-factors --yes
# schema 7 → 8
docker compose -f docker-compose.prod.yml run --rm backend \
  nedra-admin migrate-device-unlock --yes
# schema 8 → 9
docker compose -f docker-compose.prod.yml run --rm backend \
  nedra-admin migrate-native-device-unlock --yes
```

Earlier supported migration commands remain available for legacy CipherMoth vaults: `migrate-users`, `migrate-folders`, `migrate-service-permissions`, and `migrate-recovery`. Run them only for the exact schema named by `nedra-admin check`, in order, with the backend stopped.

Vault format 1 files from CipherMoth 2.0 and earlier are never converted in place. Export a portable backup with that legacy application, keep its raw snapshot for rollback, move the old vault aside with `nedra-admin set-aside`, bootstrap Nedra, and import the backup. Legacy ZIP backups remain read-only import formats; new exports always use the authenticated streaming backup format.

## Compatibility during the product rename

New configuration and clients use `NEDRA_*`, `x-nedra-session`, and `x-nedra-entry`. Nedra temporarily reads the corresponding `CIPHERMOTH_*` environment variables and `x-ciphermoth-*` request headers when no canonical value is present. Conflicting canonical and legacy request headers are rejected. Update automation to canonical names; compatibility readers may be removed in a future major release.

The following identifiers are intentionally frozen because changing them would invalidate existing data or installed clients:

- authenticated vault, backup, and browser-pairing cryptographic labels;
- the Firefox extension ID and Chromium extension key-derived ID;
- the extension IndexedDB pairing database containing non-extractable keys;
- the authenticated desktop-extension channel and page handoff message names;
- the production desktop bundle/native-host identifier;
- the Docker Compose project name, so existing `vault_data` volumes are reused;
- the updater signing public key and transitional `CipherMoth_*` artifact alias required by installed 3.x clients.

These values are compatibility contracts only. All product names, packages, commands, images, release files, update URLs, and user-facing interfaces are Nedra.

## Failure handling

- If SQLite integrity or foreign-key checks fail, restore the latest known-good snapshot.
- If the vault was written by a newer schema, update again or restore a snapshot created before the upgrade.
- If another process owns the data directory, run only one backend against the volume.
- If permissions are wrong, the container runs as uid 1000; fix ownership of a bind-mounted data directory rather than weakening permissions.
- If individual encrypted rows are damaged, the UI reports them and `nedra damaged` lists them. Restore a snapshot or explicitly remove only the rechecked damaged rows with `nedra damaged --remove`.
