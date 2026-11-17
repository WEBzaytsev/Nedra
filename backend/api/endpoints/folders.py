from fastapi import APIRouter, status

from api.endpoints.deps import AuthContextDep, SessionDep
from crud.folder import FolderCRUD
from schemas import (
    AuditEvent,
    FolderCreatePayload,
    FolderGrant,
    FolderResponse,
    FolderUpdatePayload,
    ShareUpdatePayload,
    SimpleDetailSchema,
)

router = APIRouter(tags=["folders"])


@router.get("", response_model=list[FolderResponse])
async def list_folders(
    context: AuthContextDep, session: SessionDep
) -> list[FolderResponse]:
    return await FolderCRUD(session, context).list_folders(context.key)


@router.post("", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: FolderCreatePayload,
    context: AuthContextDep,
    session: SessionDep,
) -> FolderResponse:
    return await FolderCRUD(session, context).create(body.name, context.key)


@router.patch("/{folder_id}", response_model=FolderResponse)
async def rename_folder(
    folder_id: int,
    body: FolderUpdatePayload,
    context: AuthContextDep,
    session: SessionDep,
) -> FolderResponse:
    return await FolderCRUD(session, context).rename(folder_id, body.name, context.key)


@router.delete("/{folder_id}", response_model=SimpleDetailSchema)
async def delete_folder(
    folder_id: int, context: AuthContextDep, session: SessionDep
) -> SimpleDetailSchema:
    await FolderCRUD(session, context).remove(folder_id)
    return SimpleDetailSchema(detail="Folder deleted.")


@router.get("/{folder_id}/grants", response_model=list[FolderGrant])
async def list_folder_grants(
    folder_id: int, context: AuthContextDep, session: SessionDep
) -> list[FolderGrant]:
    return await FolderCRUD(session, context).list_grants(folder_id)


@router.put("/{folder_id}/grants/users/{user_id}", response_model=FolderGrant)
async def set_user_grant(
    folder_id: int,
    user_id: int,
    body: ShareUpdatePayload,
    context: AuthContextDep,
    session: SessionDep,
) -> FolderGrant:
    return await FolderCRUD(session, context).set_user_grant(
        folder_id, user_id, body.permission, body.expires_at
    )


@router.delete("/{folder_id}/grants/users/{user_id}", response_model=SimpleDetailSchema)
async def revoke_user_grant(
    folder_id: int,
    user_id: int,
    context: AuthContextDep,
    session: SessionDep,
) -> SimpleDetailSchema:
    await FolderCRUD(session, context).revoke_user_grant(folder_id, user_id)
    return SimpleDetailSchema(detail="Folder access revoked.")


@router.put("/{folder_id}/grants/groups/{group_id}", response_model=FolderGrant)
async def set_group_grant(
    folder_id: int,
    group_id: int,
    body: ShareUpdatePayload,
    context: AuthContextDep,
    session: SessionDep,
) -> FolderGrant:
    return await FolderCRUD(session, context).set_group_grant(
        folder_id, group_id, body.permission, body.expires_at
    )


@router.delete(
    "/{folder_id}/grants/groups/{group_id}", response_model=SimpleDetailSchema
)
async def revoke_group_grant(
    folder_id: int,
    group_id: int,
    context: AuthContextDep,
    session: SessionDep,
) -> SimpleDetailSchema:
    await FolderCRUD(session, context).revoke_group_grant(folder_id, group_id)
    return SimpleDetailSchema(detail="Folder access revoked.")


@router.get("/{folder_id}/audit", response_model=list[AuditEvent])
async def folder_audit(
    folder_id: int, context: AuthContextDep, session: SessionDep
) -> list[AuditEvent]:
    return await FolderCRUD(session, context).audit(folder_id)
