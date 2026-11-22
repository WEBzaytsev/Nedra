import argparse
import asyncio
import logging
import os
import sys
import time
from pathlib import Path

CORE_VERSION = "5.0.3"


async def serve(proto_in, proto_out, data_dir, applied, started):
    import sqlite3

    from crud.engine import Database
    from main import get_application
    from settings import get_api_settings, get_vault_defaults
    from vault_sessions import VaultSessions

    from .server import CoreServer

    get_api_settings().disable_docs = True
    app = get_application(
        database=Database(data_dir),
        vault_sessions=VaultSessions(
            max_sessions=1, idle_timeout_ms=get_vault_defaults().inactivity_ms
        ),
    )

    app.state.limiter.enabled = False
    async with app.router.lifespan_context(app):
        server = CoreServer(app, proto_in, proto_out)
        server.ready(
            {
                "core_version": CORE_VERSION,
                "pid": os.getpid(),
                "python": sys.version.split()[0],
                "sqlite": sqlite3.sqlite_version,
                "frozen": bool(getattr(sys, "frozen", False)),
                "startup_ms": round((time.monotonic() - started) * 1000, 1),
                "hardening": applied,
            }
        )
        return await server.serve()


def main(started):
    os.environ["CRYPTOGRAPHY_OPENSSL_NO_LEGACY"] = "1"
    parser = argparse.ArgumentParser(prog="nedra-core")
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--security-key", action="store_true")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args()
    if args.version:
        print(CORE_VERSION)
        return 0
    if args.security_key:
        from .security_key import run

        return run()
    if not args.data_dir or not args.data_dir.is_absolute():
        parser.error("an absolute --data-dir supplied by the shell is required")
    if os.name != "nt":
        os.umask(0o077)
    from .hardening import disable_crash_dumps, isolate_stdio, watch_parent

    proto_in, proto_out = isolate_stdio()
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(levelname)s %(name)s %(message)s",
    )
    applied = disable_crash_dumps()
    watch_parent(lambda: os._exit(4))
    try:
        return asyncio.run(serve(proto_in, proto_out, args.data_dir, applied, started))
    except Exception as exc:
        logging.getLogger("nedra.core").error("startup failed: %s", type(exc).__name__)
        from . import framing

        os.write(
            proto_out,
            framing.encode(
                framing.ERROR,
                0,
                {
                    "code": "startup_failed",
                    "message": (
                        "The vault could not be opened. Check folder permissions, "
                        "close other Nedra windows, or restore a compatible backup. "
                        "Your vault was not replaced."
                    ),
                },
            ),
        )
        return 1
