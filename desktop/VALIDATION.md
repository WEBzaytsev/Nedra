# Desktop validation

Nedra desktop release acceptance is defined by the current workflows and harnesses, not by inherited historical run notes.

A publishable source commit must pass:

- `.github/workflows/ci.yml` on the exact commit;
- `.github/workflows/desktop.yml` for all release targets;
- installed-package native WebView, private-core, browser-extension, and updater exercises;
- signature, version, artifact-name, manifest, checksum, SBOM, and provenance validation;
- rejection tests for wrong signatures, wrong versions, wrong sources, and incomplete target sets.

Physical Touch ID and Secure Enclave behavior must be checked on real macOS hardware. Hosted synthetic WebView input is not evidence of biometric hardware behavior.
