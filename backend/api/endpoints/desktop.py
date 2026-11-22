from urllib.parse import quote

from fastapi import APIRouter, Request

from api.endpoints.deps import AuthContextDep, VaultSessionsDep
from api.rate_limit import limiter, rate
from errors import Forbidden
from schemas import (
    DesktopConnectionAnswer,
    DesktopConnectionApproved,
    DesktopConnectionPoll,
    DesktopConnectionStart,
    DesktopConnectionStatus,
    VaultLock,
)
from vault_sessions import DESKTOP_HANDOFF_TTL_MS

router = APIRouter(tags=["desktop"])


@router.post("/connections", response_model=DesktopConnectionStart)
@limiter.limit(rate("10/hour"))
async def start_connection(
    request: Request, vault_sessions: VaultSessionsDep
) -> DesktopConnectionStart:
    request_id, secret = vault_sessions.start_desktop_handoff()
    return DesktopConnectionStart(
        request=request_id,
        secret=secret,
        verification_url=f"/desktop-connect?request={quote(request_id)}",
        expires_in_ms=DESKTOP_HANDOFF_TTL_MS,
    )


@router.post("/connections/poll", response_model=DesktopConnectionStatus)
@limiter.limit(rate("600/hour"))
async def poll_connection(
    request: Request, body: DesktopConnectionPoll, vault_sessions: VaultSessionsDep
) -> DesktopConnectionStatus:
    return DesktopConnectionStatus.model_validate(
        vault_sessions.poll_desktop_handoff(body.request, body.secret)
    )


@router.post("/connections/cancel", response_model=VaultLock)
@limiter.limit(rate("600/hour"))
async def cancel_connection(
    request: Request, body: DesktopConnectionPoll, vault_sessions: VaultSessionsDep
) -> VaultLock:
    vault_sessions.cancel_desktop_handoff(body.request, body.secret)
    return VaultLock(locked=True)


@router.post("/connections/answer", response_model=DesktopConnectionApproved)
@limiter.limit(rate("20/hour"))
async def answer_connection(
    request: Request,
    body: DesktopConnectionAnswer,
    context: AuthContextDep,
    vault_sessions: VaultSessionsDep,
) -> DesktopConnectionApproved:
    assert context.token is not None
    handle = vault_sessions.answer_desktop_handoff(
        body.request, body.allow, context.user.id, context.token
    )
    if handle is None:
        raise Forbidden("Desktop connection request is unavailable.")
    return DesktopConnectionApproved(
        state="approved" if body.allow else "denied", id=handle or None
    )


@router.delete("/connections/{connection_id}", response_model=VaultLock)
async def revoke_connection(
    connection_id: str, context: AuthContextDep, vault_sessions: VaultSessionsDep
) -> VaultLock:
    vault_sessions.revoke_desktop(connection_id, context.user.id)
    return VaultLock(locked=True)
