import re

from starlette.exceptions import HTTPException
from starlette.formparsers import MultiPartParser
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backup_format import MAX_BACKUP_BYTES

_MIB = 1024 * 1024

DEFAULT_MAX_BODY_BYTES = 16 * _MIB
ATTACHMENT_MAX_BODY_BYTES = 6 * _MIB
CSV_IMPORT_MAX_BODY_BYTES = 11 * _MIB
BACKUP_IMPORT_MAX_BODY_BYTES = MAX_BACKUP_BYTES + _MIB

_PLAINTEXT_ROUTE_LIMITS = (
    ("POST", re.compile(r"/passwords/[^/]+/attachments$"), ATTACHMENT_MAX_BODY_BYTES),
    ("POST", re.compile(r"/passwords/import/csv$"), CSV_IMPORT_MAX_BODY_BYTES),
)
_ROUTE_LIMITS = (
    *_PLAINTEXT_ROUTE_LIMITS,
    ("POST", re.compile(r"/passwords/import$"), BACKUP_IMPORT_MAX_BODY_BYTES),
)


def body_limit_for(method: str, path: str) -> int:
    for route_method, pattern, limit in _ROUTE_LIMITS:
        if method == route_method and pattern.search(path):
            return limit
    return DEFAULT_MAX_BODY_BYTES


def _too_large(limit: int) -> str:
    return f"Request is too large. The limit for this request is {limit // _MIB} MB."


class RequestTooLarge(HTTPException):
    def __init__(self, limit: int) -> None:
        super().__init__(status_code=413, detail=_too_large(limit))


def keep_uploads_in_memory() -> None:
    """
    Starlette spools multipart file parts larger than 1 MB to a temporary file on
    disk, which would put attachments and CSV imports there in plaintext. Raising
    the spool threshold to the largest cap of every route that receives
    plaintext keeps those parts in memory. Encrypted backups, which can be far
    larger, may still be spooled: they hold only ciphertext.
    """
    MultiPartParser.spool_max_size = max(
        DEFAULT_MAX_BODY_BYTES, *(limit for _, _, limit in _PLAINTEXT_ROUTE_LIMITS)
    )


def _declared_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", []):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = body_limit_for(scope["method"], scope["path"])
        declared = _declared_length(scope)
        if declared is not None and declared > limit:
            response = JSONResponse(
                status_code=413, content={"detail": _too_large(limit)}
            )
            await response(scope, receive, send)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise RequestTooLarge(limit)
            return message

        await self.app(scope, limited_receive, send)
