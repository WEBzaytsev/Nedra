"""
Clear answers for clients of the vault key protocol that v1.6.0 removed.

v1.4.x clients unlocked with ``POST /master_password/check``, received the vault
key and sent it back in the ``x-nedra-key-derivation`` header. Neither is
accepted any more. Both are answered here, before routing, so the key is never
derived for them and a request carrying the header never reaches a route,
whatever else it carries. The 403 uses the ``invalid_key`` code because that is
what makes a v1.4.6 or v1.4.7 browser tab drop its key and reload into the
current web UI.
"""

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

RETIRED_KEY_HEADER = "x-nedra-key-derivation"
LEGACY_RETIRED_KEY_HEADER = "x-ciphermoth-key-derivation"
RETIRED_UNLOCK = ("POST", "/api/master_password/check")
UPGRADE_REQUIRED = (
    "This Nedra server no longer hands out or accepts the vault key. "
    "Reload the browser tab, or update the Nedra CLI to 1.5.0 or newer, "
    "and unlock again."
)

_RETIRED_KEY_HEADERS = {
    RETIRED_KEY_HEADER.encode("latin-1"),
    LEGACY_RETIRED_KEY_HEADER.encode("latin-1"),
}


class RetiredClients:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            if any(
                name.lower() in _RETIRED_KEY_HEADERS for name, _ in scope["headers"]
            ):
                await _refuse(403, "invalid_key", scope, receive, send)
                return
            if (scope["method"], scope["path"]) == RETIRED_UNLOCK:
                await _refuse(410, "upgrade_required", scope, receive, send)
                return
        await self.app(scope, receive, send)


async def _refuse(
    status_code: int, code: str, scope: Scope, receive: Receive, send: Send
) -> None:
    response = JSONResponse(
        {"detail": UPGRADE_REQUIRED, "code": code}, status_code=status_code
    )
    await response(scope, receive, send)
