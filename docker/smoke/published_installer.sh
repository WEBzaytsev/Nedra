#!/bin/sh
# Installs a published release with the installer fetched from its release
# tag, exactly as a user would, then reruns it on the result. Runs the real
# install.sh (ports 3000/8000), so it refuses to run outside GitHub Actions; the
# Compose project is nedra-release-installer and is removed afterwards.
#
#   docker/smoke/published_installer.sh 2.0.0
set -eu

[ "${GITHUB_ACTIONS:-}" = "true" ] || {
  echo "runs the real installer on ports 3000/8000; GitHub Actions only" >&2
  exit 2
}

VERSION="$1"
REF="v${VERSION}"
MASTER="Release-Installer-Smoke-2026!"
WORK="${RUNNER_TEMP:-/tmp}/published-installer"
DIR="$WORK/nedra"
INSTALLER="$WORK/install.sh"
export COMPOSE_PROJECT_NAME=nedra-release-installer

pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -f "$DIR/docker-compose.prod.yml" ]; then
    docker compose -f "$DIR/docker-compose.prod.yml" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 1 90); do
    if body="$(curl -fsS http://127.0.0.1:8000/api/health 2>/dev/null)"; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  docker compose -f "$DIR/docker-compose.prod.yml" logs backend >&2
  fail "the installed backend never became healthy"
}

json() {
  python3 -c "import json, sys; print(json.load(sys.stdin)$1)"
}

mkdir -p "$WORK"
curl -fsSL "https://raw.githubusercontent.com/WEBzaytsev/Nedra/${REF}/install.sh" -o "$INSTALLER"
git show "${REF}:install.sh" >"$WORK/install.tagged.sh"
cmp -s "$INSTALLER" "$WORK/install.tagged.sh" || fail "the published install.sh differs from the ${REF} source"
pass "install.sh fetched from the ${REF} release source"

NEDRA_REF="$REF" NEDRA_DIR="$DIR" sh "$INSTALLER" </dev/null
health="$(wait_healthy)"
[ "$(printf '%s' "$health" | json "['version']")" = "$VERSION" ] ||
  fail "the installed backend reports $health"
grep -q '^NEDRA_VERSION=latest$' "$DIR/.env" || fail "the generated .env"
git show "${REF}:docker-compose.prod.yml" | cmp -s "$DIR/docker-compose.prod.yml" - || fail "the installed compose file"
pass "fresh install through the published installer: $health"

running="$(docker compose -f "$DIR/docker-compose.prod.yml" images -q backend)"
tagged="$(docker image inspect "ghcr.io/webzaytsev/nedra-backend:${VERSION}" --format '{{.Id}}')"
[ "$running" = "${tagged#sha256:}" ] || [ "$running" = "$tagged" ] ||
  fail "latest ($running) is not the ${VERSION} image ($tagged)"
pass "latest resolves to the ${VERSION} images"

token="$(curl -fsS -X POST http://127.0.0.1:8000/api/master_password/create \
  -H 'content-type: application/json' \
  -d "{\"master_password\": \"$MASTER\"}" | json "['session_token']")"
curl -fsS -o /dev/null -X POST http://127.0.0.1:8000/api/passwords/create \
  -H 'content-type: application/json' -H "x-nedra-session: $token" \
  -d '{"password_name": "installer-entry", "password_value": "installer-Value-1"}'

cd "$DIR"
printf '%s\n' "$MASTER" | ./nedra password list | grep -q installer-entry || fail "./nedra password list"
./nedra --help >/dev/null || fail "./nedra --help"
docker compose -f docker-compose.prod.yml exec -T backend nedra-admin snapshot | grep -q "Snapshot written" ||
  fail "nedra-admin snapshot"
docker compose -f docker-compose.prod.yml exec -T backend nedra-admin check >/dev/null ||
  fail "nedra-admin check"
pass "./nedra and nedra-admin work in the installed stack"

sed "s/^NEDRA_VERSION=.*/NEDRA_VERSION=${VERSION}/" .env >.env.edited
printf 'NEDRA_RATE_LIMIT=500/hour\n' >>.env.edited
mv .env.edited .env
cp .env "$WORK/env.before"
NEDRA_REF="$REF" NEDRA_DIR="$DIR" sh "$INSTALLER" </dev/null
cmp -s .env "$WORK/env.before" || fail "a rerun changed the .env of a ${VERSION} install"
if ls ./*.backup-* .env.backup-* >/dev/null 2>&1; then
  fail "a rerun with nothing to change made backups"
fi
wait_healthy >/dev/null
valid="$(curl -fsS -X POST http://127.0.0.1:8000/api/master_password/unlock \
  -H 'content-type: application/json' \
  -d "{\"master_password\": \"$MASTER\"}" | json "['valid']")"
[ "$valid" = "True" ] || fail "the vault did not survive a rerun of the installer"
pass "rerunning the installer keeps the ${VERSION} pin, the settings and the vault"
