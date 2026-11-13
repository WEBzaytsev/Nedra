FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS builder

COPY --from=ghcr.io/astral-sh/uv:latest@sha256:5cc1805e2426484abca4ad46ea783bab281fdb225fd82d8ce6d66a81254bac85 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PYTHON_PREFERENCE=only-managed

WORKDIR /app

COPY backend/pyproject.toml backend/uv.lock ./

RUN uv python install 3.13 \
    && uv sync --frozen --no-install-project --no-group dev \
    && .venv/bin/python -c "import sqlite3; v = sqlite3.sqlite_version_info; assert v >= (3, 51, 3), v; print('SQLite', sqlite3.sqlite_version)"


FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime

LABEL io.ciphermoth.min-updater-protocol="3"

ENV PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app/src \
    CIPHERMOTH_DATA_DIR=/data \
    CIPHERMOTH_API_URL=http://localhost/api

RUN useradd -m -u 1000 -s /bin/bash ciphermoth

WORKDIR /app/src

COPY --from=builder /opt/python /opt/python
COPY --from=builder /app/.venv /app/.venv
COPY backend/ .
RUN chmod +x entrypoint.sh
RUN printf '#!/bin/sh\nexec python /app/src/cli.py "$@"\n' > /usr/local/bin/ciphermoth \
    && printf '#!/bin/sh\nexec python /app/src/vault_admin.py "$@"\n' > /usr/local/bin/ciphermoth-admin \
    && chmod +x /usr/local/bin/ciphermoth /usr/local/bin/ciphermoth-admin
RUN mkdir -m 0700 /data && chown ciphermoth:ciphermoth /data

USER ciphermoth

VOLUME ["/data"]

CMD ["./entrypoint.sh"]
