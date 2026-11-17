# Browser extension validation

Nedra extension packages are accepted only when the current source commit passes:

- TypeScript type checking, ESLint, formatting, and unit tests;
- deterministic Chromium and Firefox package builds;
- Firefox manifest linting;
- server-mode search, fill, TOTP, clipboard, handoff, session expiry, and revocation flows;
- installed native-host pairing, encrypted-channel, lock, revoke, restart, and uninstall flows;
- hostile-page tests proving secrets are not injected without an explicit user action;
- package-content checks excluding test hooks, source maps, credentials, and development endpoints.

The release workflow publishes extension artifacts together with the matching Nedra desktop and server release.
