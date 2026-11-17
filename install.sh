#!/bin/sh
# Install or update the self-hosted Nedra Docker stack.
#
#   curl -fsSL https://raw.githubusercontent.com/WEBzaytsev/Nedra/main/install.sh | sh
#
# Optional: NEDRA_REPO, NEDRA_REF, NEDRA_DIR, NEDRA_VERSION.
set -eu

REPO="${NEDRA_REPO:-WEBzaytsev/Nedra}"
REF="${NEDRA_REF:-main}"
DIR="${NEDRA_DIR:-nedra}"
BASE="https://raw.githubusercontent.com/${REPO}/${REF}"

say() { printf '%s\n' "Nedra: $*"; }
die() { printf '%s\n' "Nedra: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

backup_if_changed() {
  target="$1"
  candidate="$2"
  if [ -f "$target" ] && ! cmp -s "$target" "$candidate"; then
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    copy="$target.backup-$stamp"
    n=1
    while [ -e "$copy" ]; do
      n=$((n + 1))
      copy="$target.backup-$stamp-$n"
    done
    cp -p "$target" "$copy"
    say "saved previous $target as $copy"
  fi
}

have curl || die "curl is required"
have docker || die "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
docker info >/dev/null 2>&1 || die "Docker is not running or the current user cannot access it"

mkdir -p "$DIR"
cd "$DIR"
tmp=".nedra-install-$$"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -m 700 "$tmp"

curl -fsSL "$BASE/docker-compose.prod.yml" -o "$tmp/docker-compose.prod.yml" ||
  die "could not download docker-compose.prod.yml"
curl -fsSL "$BASE/scripts/nedra" -o "$tmp/nedra" || die "could not download the CLI wrapper"
[ -s "$tmp/docker-compose.prod.yml" ] || die "downloaded Compose file is empty"
[ -s "$tmp/nedra" ] || die "downloaded CLI wrapper is empty"
chmod 755 "$tmp/nedra"

backup_if_changed docker-compose.prod.yml "$tmp/docker-compose.prod.yml"
mv "$tmp/docker-compose.prod.yml" docker-compose.prod.yml
mv "$tmp/nedra" nedra

if [ ! -f .env ]; then
  umask 077
  {
    printf '%s\n' '# Nedra self-hosted configuration.'
    printf 'NEDRA_VERSION=%s\n' "${NEDRA_VERSION:-latest}"
    printf '%s\n' '# NEDRA_API_URL=https://vault.example/api'
    printf '%s\n' '# NEDRA_FRONTEND_ORIGIN=https://vault.example'
    printf '%s\n' '# NEDRA_BIND_ADDRESS=127.0.0.1'
  } >.env
  say "created .env"
else
  say "kept existing .env"
fi

if [ "${NEDRA_SKIP_PULL:-0}" = "1" ]; then
  say "using already available images"
else
  say "pulling images"
  docker compose -f docker-compose.prod.yml pull
fi
say "starting services"
docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker compose -f docker-compose.prod.yml ps

say "installed in $(pwd)"
say "open http://localhost:3000"
say "CLI: ./nedra --help"
say "before updates: docker compose -f docker-compose.prod.yml exec backend nedra-admin snapshot"
