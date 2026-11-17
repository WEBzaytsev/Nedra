# Maintaining a Nedra release

This is a maintainer guide. Never put a private signing key, password, test vault or credential in this repository or a workflow artifact.

## Trust and recovery

The production updater key is embedded in `src-tauri/tauri.conf.json`. Its minisign key ID is **1BF84A7870A3622C**. Preserve this key across releases: installed applications cannot learn a replacement key from an unsigned manifest. Apple/Microsoft publisher signing is unrelated.

The original key is stored in the maintainer's owner-only `~/.config/nedra/release-signing/updater.key`; a second local copy is in `~/.local/share/nedra-release-signing-backup/updater.key`. Both locations are outside Git. Keep the enclosing directories mode `0700` and private files `0600`. The key is not password-protected; filesystem access controls protect these copies. Back up the directory to encrypted offline storage that you control. Two locations on the same computer do not protect against losing that computer. Keep the matching `.pub` with the backup.

GitHub environment **desktop-release** holds `TAURI_SIGNING_PRIVATE_KEY`; no password secret is needed for this key. The workflow passes an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and writes the key only into its private runner-temporary directory. PR builds generate disposable keys, never receive the production key and never publish installers. Environment branch/tag policies restrict production signing; stable version tags cannot be updated or deleted. Do not grant forks or arbitrary branches access to this environment.

To recover on an owner-controlled machine, restore the key directory with restrictive permissions, compare the public key to the committed configuration, then upload without printing it:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --env desktop-release \
  --repo WEBzaytsev/Nedra < ~/.config/nedra/release-signing/updater.key
```

Verify continuity by signing a disposable file using `tauri signer sign --app-version X.Y.Z` and checking it with the `verify_update` example and committed public key. Do not rotate just because a new runner or computer is used. If a key is compromised, stop publication and assess recovery for installed users before changing trust.

## Build and publication

Use the existing maintainer Git identity, normal commits, and no bot co-author trailers. Merge tested implementation work to `main`. The desktop workflow reuses six native runners (macOS ARM/Intel, Windows ARM/x64, Linux ARM/x64), Python 3.13.15 and the committed dependency lockfiles. It runs the frozen core vectors/tests, native QA workflows, production package collection and installed-app updater acceptance. No synthetic vaults or QA installers are uploaded as public assets.

1. Update the changelog and run `PATH="$HOME/.cargo/bin:$PATH" python3 desktop/release/version.py X.Y.Z`. Review and commit the version change; `--check X.Y.Z` checks every version source without changing files.
2. Pass PR CI and the desktop matrix on the final source. Release CI exercises the protected production signing key and retains verified packages before publication. A missing production secret must fail, never fall back to a test key. If key provisioning needs a separate check, Desktop can also be dispatched on trusted `main` with `release=true`.
3. Create an annotated `vX.Y.Z` tag on the verified commit and push it once. `scripts/release.sh` validates this sequence; it does not publish an unchecked release.
4. The single Release workflow builds/signs the existing multi-architecture GHCR images and invokes the Desktop workflow. Published Docker smoke checks verify cosign identities/digests and exercise isolated Compose installs.
5. `artifacts.py` collects actual bundle output and assigns the only supported names, `Nedra_VERSION_OS-ARCH.EXT`. Production package provenance records the commit, version, target, byte sizes and hashes. Tauri `createUpdaterArtifacts` produces macOS `.app.tar.gz`, Windows NSIS `.exe` and Linux AppImage update bundles; DMGs and Debian packages remain regular downloads. No aliases or transitional artifacts are published.
6. `manifest.py` refuses missing/duplicate targets, wrong commits/versions, missing packages or invalid signatures. It builds `latest.json` from the six actual signatures and generates `SHA256SUMS`. The endpoint is permanently `https://github.com/WEBzaytsev/Nedra/releases/latest/download/latest.json`.
7. Only after all gates pass, `publish.py` creates one draft, uploads the complete set, downloads it again and checks every hash, then publishes it as a normal stable Latest release. Existing releases are never silently overwritten. If a failed upload leaves a draft, inspect the draft and failure before resuming; do not replace the tag.
8. Verify the public release and downloads without authentication, the Latest manifest, and a released app's no-update result. Keep the CI run and commit in the release validation report. Do not call the release complete while a platform or Docker gate is failing.

`requireSignedVersion` is mandatory. Do not disable TLS, allow downgrades, expose generic updater plugin capabilities, or sign arbitrary external payloads. Canonical filenames are part of the signature's trusted comment and bind architecture; re-sign after renaming, never edit a `.sig` by hand.

## Installed update tests

`build_update_fixtures.py` temporarily builds versions 3.0.98 and 3.0.99 of the separate QA application, then restores source files. It packages the same production core and updater implementation with an isolated QA identity. `harness/update.py` installs the old app and serves the signed newer package over local HTTPS using an ephemeral CA trusted only in that QA process. Production contains neither this endpoint override nor QA commands.

The host drives the native webview, creates a synthetic vault, quits/reopens it, tests negative manifests/downloads, installs through the real Tauri updater, and verifies the new version, original password, content/attachment fingerprints, encrypted backups and process cleanup. AppImage is tested separately from the Debian installation. This proves native updater mechanics; it does not simulate Gatekeeper internet quarantine, SmartScreen reputation or an organization's endpoint policy. Record actual OS limitations honestly. Never disable system protections for a passing result.

Use fresh absolute disposable roots. The normal application has no override for its vault directory. Do not test with a personal vault, installed Alpha app or real Docker volume. CI retains only selected JSON/XML evidence, never the full synthetic-data tree or signing directory.
