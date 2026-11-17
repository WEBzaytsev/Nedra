import time

STARTED = time.monotonic()


def _bootstrap() -> int:
    import sys
    from pathlib import Path

    if not getattr(sys, "frozen", False):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
    from desktop_core.entry import main

    return main(STARTED)


if __name__ == "__main__":
    import os
    import sys

    code = _bootstrap()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
