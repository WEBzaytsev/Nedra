import os

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)


def rate(default: str) -> str:
    return (
        os.environ.get("NEDRA_RATE_LIMIT")
        or os.environ.get("CIPHERMOTH_RATE_LIMIT")
        or default
    )
