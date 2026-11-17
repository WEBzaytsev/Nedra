from fastapi import APIRouter, status

from api.endpoints.deps import AdminContextDep, AuthContextDep, SessionDep
from crud.folder import GroupCRUD
from schemas import (
    AuditEvent,
    GroupCreatePayload,
    GroupMember,
    GroupResponse,
    GroupUpdatePayload,
    SimpleDetailSchema,
)

router = APIRouter(tags=["groups"])


@router.get("", response_model=list[GroupResponse])
async def list_groups(
    context: AuthContextDep, session: SessionDep
) -> list[GroupResponse]:
    return await GroupCRUD(session, context).list_groups(context.key)


@router.post("", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(
    body: GroupCreatePayload,
    context: AdminContextDep,
    session: SessionDep,
) -> GroupResponse:
    return await GroupCRUD(session, context).create(body.name, context.key)


@router.patch("/{group_id}", response_model=GroupResponse)
async def rename_group(
    group_id: int,
    body: GroupUpdatePayload,
    context: AdminContextDep,
    session: SessionDep,
) -> GroupResponse:
    return await GroupCRUD(session, context).rename(group_id, body.name, context.key)


@router.delete("/{group_id}", response_model=SimpleDetailSchema)
async def delete_group(
    group_id: int, context: AdminContextDep, session: SessionDep
) -> SimpleDetailSchema:
    await GroupCRUD(session, context).remove(group_id)
    return SimpleDetailSchema(detail="Group deleted.")


@router.get("/{group_id}/members", response_model=list[GroupMember])
async def list_members(
    group_id: int, context: AdminContextDep, session: SessionDep
) -> list[GroupMember]:
    return await GroupCRUD(session, context).members(group_id)


@router.put("/{group_id}/members/{user_id}", response_model=GroupMember)
async def add_member(
    group_id: int,
    user_id: int,
    context: AdminContextDep,
    session: SessionDep,
) -> GroupMember:
    return await GroupCRUD(session, context).add_member(group_id, user_id)


@router.delete("/{group_id}/members/{user_id}", response_model=SimpleDetailSchema)
async def remove_member(
    group_id: int,
    user_id: int,
    context: AdminContextDep,
    session: SessionDep,
) -> SimpleDetailSchema:
    await GroupCRUD(session, context).remove_member(group_id, user_id)
    return SimpleDetailSchema(detail="Group member removed.")


@router.get("/{group_id}/audit", response_model=list[AuditEvent])
async def group_audit(
    group_id: int, context: AdminContextDep, session: SessionDep
) -> list[AuditEvent]:
    return await GroupCRUD(session, context).audit(group_id)
