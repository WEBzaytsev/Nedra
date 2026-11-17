#!/usr/bin/env bash
set -euo pipefail
if [ -n "${POSTGRES_HOST:-}" ]; then
  echo "Nedra now keeps the vault in SQLite and no longer uses PostgreSQL." >&2
  echo "This container was started from an older docker-compose.prod.yml." >&2
  echo "Install the new compose file as a fresh vault: see docs/UPDATING.md." >&2
  exit 78
fi
exec uvicorn main:app --workers 1 --host 0.0.0.0 --port 80
