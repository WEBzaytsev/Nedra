# Desktop validation

Nedra desktop release acceptance is defined by the current build and release workflows, not by inherited historical run notes.

A publishable source commit must pass:

- `.github/workflows/ci.yml` on the exact commit;
- `.github/workflows/desktop.yml` for all release targets;
- signature, version, artifact-name, manifest, checksum, SBOM, and provenance validation;

Native hardware behavior requires real macOS hardware; the build does not establish it.
