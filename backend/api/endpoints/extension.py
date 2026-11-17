"""Fill-only browser-extension routes with server-enforced session scope."""

from datetime import UTC, datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, Request

from api.endpoints.deps import (
    AuthContextDep,
    AuthCRUDDep,
    ExtensionContextDep,
    ExtensionCredentialDep,
    ExtensionCRUDDep,
    VaultSessionsDep,
)
from api.rate_limit import limiter, rate
from errors import Forbidden
from schemas import (
    ExtensionCredential,
    ExtensionHandoffApprove,
    ExtensionHandoffApproved,
    ExtensionHandoffRedeem,
    ExtensionHandoffSession,
    ExtensionHandoffStart,
    ExtensionLoginRequest,
    ExtensionLogins,
    ExtensionMatchRequest,
    ExtensionSearchRequest,
    ExtensionSessionInfo,
    ExtensionTotp,
    ExtensionUnlockPayload,
    VaultLock,
    VaultSessionStatus,
    VaultUnlock,
)
from settings import get_api_settings
from vault_sessions import Scope

router = APIRouter(tags=["extension"])


@router.post("/unlock", name="extension:unlock", response_model=VaultUnlock)
@limiter.limit(rate("30/hour"))
async def unlock(
    request: Request, body: ExtensionUnlockPayload, crud: AuthCRUDDep
) -> VaultUnlock:
    session = await crud.login_extension(
        body.username, body.password, body.browser, body.client
    )
    if session is None:
        return VaultUnlock(valid=False)
    return VaultUnlock(
        valid=True,
        session_token=session.session_token,
        idle_timeout_ms=session.idle_timeout_ms,
    )


def _trusted_handoff_origin(origin: str) -> str:
    parsed = urlsplit(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.path
        or parsed.query
        or parsed.fragment
        or origin not in get_api_settings().cors_origins
    ):
        raise Forbidden("Extension handoff origin is not configured.")
    return origin


@router.post("/handoffs/start", name="extension:handoff-start")
@limiter.limit(rate("10/hour"))
async def start_handoff(
    request: Request, body: ExtensionHandoffStart, vault_sessions: VaultSessionsDep
) -> dict[str, bool]:
    if not vault_sessions.start_extension_handoff(
        body.request,
        body.tab,
        _trusted_handoff_origin(body.origin),
        body.browser,
        body.client,
    ):
        raise Forbidden("Extension handoff is unavailable.")
    return {"ok": True}


@router.post(
    "/handoffs/approve",
    name="extension:handoff-approve",
    response_model=ExtensionHandoffApproved,
)
@limiter.limit(rate("10/hour"))
async def approve_handoff(
    request: Request,
    body: ExtensionHandoffApprove,
    context: AuthContextDep,
    vault_sessions: VaultSessionsDep,
) -> ExtensionHandoffApproved:
    assert context.token is not None
    redeem = vault_sessions.approve_extension_handoff(
        body.request,
        body.tab,
        _trusted_handoff_origin(body.origin),
        body.browser,
        body.client,
        context.user.id,
        context.token,
    )
    if redeem is None:
        raise Forbidden("Extension handoff is unavailable.")
    return ExtensionHandoffApproved(redeem=redeem)


@router.post(
    "/handoffs/redeem",
    name="extension:handoff-redeem",
    response_model=ExtensionHandoffSession,
)
@limiter.limit(rate("10/hour"))
async def redeem_handoff(
    request: Request, body: ExtensionHandoffRedeem, vault_sessions: VaultSessionsDep
) -> ExtensionHandoffSession:
    session = vault_sessions.redeem_extension_handoff(
        body.request, body.tab, body.redeem, body.browser, body.client
    )
    if session is None:
        raise Forbidden("Extension handoff is unavailable.")
    token, handle = session
    return ExtensionHandoffSession(
        session_token=token,
        id=handle,
        idle_timeout_ms=vault_sessions.idle_timeout_ms,
    )


@router.post("/handoffs/cancel", name="extension:handoff-cancel")
async def cancel_handoff(
    body: ExtensionHandoffStart, vault_sessions: VaultSessionsDep
) -> dict[str, bool]:
    vault_sessions.cancel_extension_handoff(body.request, body.tab, body.client)
    return {"ok": True}


@router.get(
    "/sessions", name="extension:sessions", response_model=list[ExtensionSessionInfo]
)
async def list_sessions(
    context: AuthContextDep, vault_sessions: VaultSessionsDep
) -> list[ExtensionSessionInfo]:
    return [
        ExtensionSessionInfo(
            id=session.handle,
            browser=session.browser,
            created=datetime.fromtimestamp(session.created, UTC),
            last_used=datetime.fromtimestamp(session.last_used, UTC),
        )
        for session in vault_sessions.extension_sessions(context.user.id)
    ]


@router.delete(
    "/sessions/{session_id}", name="extension:disconnect", response_model=VaultLock
)
async def disconnect(
    session_id: str, context: AuthContextDep, vault_sessions: VaultSessionsDep
) -> VaultLock:
    if not vault_sessions.revoke_extension(session_id, context.user.id):
        return VaultLock(locked=True)
    return VaultLock(locked=True)


@router.post("/matches", name="extension:matches", response_model=ExtensionLogins)
async def matches(
    body: ExtensionMatchRequest, crud: ExtensionCRUDDep, context: ExtensionContextDep
) -> ExtensionLogins:
    return await crud.matches(context.key, body.origin, subdomains=body.subdomains)


@router.post("/search", name="extension:search", response_model=ExtensionLogins)
async def search(
    body: ExtensionSearchRequest, crud: ExtensionCRUDDep, context: ExtensionContextDep
) -> ExtensionLogins:
    return await crud.search(context.key, body.query)


@router.post(
    "/credential", name="extension:credential", response_model=ExtensionCredential
)
@limiter.limit(rate("300/hour"))
async def credential(
    request: Request,
    body: ExtensionLoginRequest,
    crud: ExtensionCRUDDep,
    context: ExtensionContextDep,
) -> ExtensionCredential:
    return await crud.credential(
        context.key,
        body.id,
        body.origin,
        subdomains=body.subdomains,
        confirmed_mismatch=body.confirmed_mismatch,
    )


@router.post("/totp", name="extension:totp", response_model=ExtensionTotp)
@limiter.limit(rate("300/hour"))
async def totp(
    request: Request,
    body: ExtensionLoginRequest,
    crud: ExtensionCRUDDep,
    context: ExtensionContextDep,
) -> ExtensionTotp:
    return await crud.totp(
        context.key,
        body.id,
        body.origin,
        subdomains=body.subdomains,
        confirmed_mismatch=body.confirmed_mismatch,
    )


@router.post(
    "/session", name="extension:session-activity", response_model=VaultSessionStatus
)
async def session_activity(
    credential: ExtensionCredentialDep, vault_sessions: VaultSessionsDep
) -> VaultSessionStatus:
    vault_sessions.resolve(credential.token, scope=Scope.EXTENSION)
    info = vault_sessions.info(credential.token, scope=Scope.EXTENSION)
    return VaultSessionStatus(
        idle_timeout_ms=info.idle_timeout_ms, expires_in_ms=info.expires_in_ms
    )


@router.post("/lock", name="extension:lock", response_model=VaultLock)
async def lock(
    credential: ExtensionCredentialDep, vault_sessions: VaultSessionsDep
) -> VaultLock:
    vault_sessions.revoke(credential.token, scope=Scope.EXTENSION)
    return VaultLock(locked=True)
