#!/usr/bin/env bash
# Tag an already versioned, tested source commit. Publication is CI-gated.
set -euo pipefail
version="${1:-}"
version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'usage: scripts/release.sh X.Y.Z [--dry-run]' >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
test -z "$(git status --porcelain)" || { echo 'Commit or preserve local changes first.' >&2; exit 1; }
git fetch origin main --tags
head="$(git rev-parse HEAD)"
test "$head" = "$(git rev-parse origin/main)" || { echo 'Release source must equal origin/main.' >&2; exit 1; }
python3 desktop/release/version.py --check "$version"
if git rev-parse "refs/tags/v$version" >/dev/null 2>&1; then echo 'Tag already exists; never replace it.' >&2; exit 1; fi
# Require completed successful standard and native desktop validation
# on this exact commit. Native QA uses separate disposable app identities.
for workflow in ci.yml desktop.yml; do
  gh run list --repo WEBzaytsev/Nedra --workflow "$workflow" --commit "$head" --status success --json headSha --jq 'length' | python3 -c 'import sys; assert int(sys.stdin.read()) > 0, "Missing successful final-source CI"'
done
if [ "${2:-}" = '--dry-run' ]; then echo "Verified source $head; would tag v$version. No files changed."; exit 0; fi
test "$(git var GIT_AUTHOR_IDENT | cut -d '>' -f 1)>" = 'krolbot <krolbot@users.noreply.github.com>'
test "$(git var GIT_COMMITTER_IDENT | cut -d '>' -f 1)>" = 'krolbot <krolbot@users.noreply.github.com>'
git tag -a "v$version" -m "Nedra v$version"
git push origin "refs/tags/v$version"
echo 'Release CI will build, verify, stage and publish only after all gates pass. Monitor the run through publication.'
