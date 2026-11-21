# Browser extension validation

Nedra extension packages are accepted only when the current source commit passes:

- TypeScript type checking, ESLint, and formatting;
- deterministic Chromium and Firefox package builds;
- Firefox manifest linting;
- package-content checks excluding QA hooks, source maps, credentials, and development endpoints.

The release workflow publishes extension artifacts together with the matching Nedra desktop and server release.
