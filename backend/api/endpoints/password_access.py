from fastapi import APIRouter, Query

from api.endpoints.deps import AuthContextDep, SessionDep
from crud.access import EntryACL
from schemas import (
    AccessRelinquishResponse,
    AuditEvent,
    EntryAccess,
    ShareGrant,
    ShareUpdatePayload,
    SimpleDetailSchema,
)

router = APIRouter(tags=["sharing"])


@router.get("/access", response_model=list[EntryAccess])
async def access_map(
    context: AuthContextDep,
    session: SessionDep,
    trash: bool = Query(default=False),
) -> list[EntryAccess]:
    return await EntryACL(session, context).access_map(deleted=trash)


@router.get("/{entry_id}/shares", response_model=list[ShareGrant])
async def list_shares(
    entry_id: int, context: AuthContextDep, session: SessionDep
) -> list[ShareGrant]:
    return await EntryACL(session, context).list_shares(entry_id)


@router.put("/{entry_id}/shares/{user_id}", response_model=ShareGrant)
async def set_share(
    entry_id: int,
    user_id: int,
    body: ShareUpdatePayload,
    context: AuthContextDep,
    session: SessionDep,
) -> ShareGrant:
    return await EntryACL(session, context).set_share(
        entry_id, user_id, body.permission, body.expires_at
    )


@router.delete("/{entry_id}/shares/{user_id}", response_model=SimpleDetailSchema)
async def revoke_share(
    entry_id: int,
    user_id: int,
    context: AuthContextDep,
    session: SessionDep,
) -> SimpleDetailSchema:
    await EntryACL(session, context).revoke_share(entry_id, user_id)
    return SimpleDetailSchema(detail="Access revoked.")


@router.get("/{entry_id}/audit", response_model=list[AuditEvent])
async def entry_audit(
    entry_id: int, context: AuthContextDep, session: SessionDep
) -> list[AuditEvent]:
    return await EntryACL(session, context).audit(entry_id)


@router.delete("/{entry_id}/access", response_model=AccessRelinquishResponse)
async def relinquish(
    entry_id: int, context: AuthContextDep, session: SessionDep
) -> AccessRelinquishResponse:
    effective = await EntryACL(session, context).relinquish(entry_id)
    return AccessRelinquishResponse(
        detail="Direct access relinquished.",
        direct_access_relinquished=True,
        effective_access=effective,
    )
