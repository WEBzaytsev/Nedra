import re
from urllib.parse import unquote

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

ENCODED_SLASH = "\x00"
NUL_IN_PATH_DETAIL = "Entry names cannot contain NUL characters."
_ENCODED_SLASH = re.compile(rb"%2f", re.IGNORECASE)


def entry_name(value: str) -> str:
    return value.replace(ENCODED_SLASH, "/")


def _route_path(raw_path: bytes) -> str:
    return "/".join(
        unquote(segment).replace("/", ENCODED_SLASH)
        for segment in raw_path.decode("latin-1").split("/")
    )


class EntryNamePaths:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        raw_path = scope.get("raw_path") if scope["type"] == "http" else None
        if raw_path:
            if b"%00" in raw_path:
                response = JSONResponse(
                    status_code=400, content={"detail": NUL_IN_PATH_DETAIL}
                )
                await response(scope, receive, send)
                return
            if _ENCODED_SLASH.search(raw_path):
                scope = {**scope, "path": _route_path(raw_path)}
        await self.app(scope, receive, send)
