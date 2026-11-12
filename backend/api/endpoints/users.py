from fastapi import APIRouter

from api.endpoints.deps import (
    AdminContextDep,
    AuthContextDep,
    AuthCRUDDep,
    SecurityFactorCRUDDep,
    SessionDep,
)
from crud.access import EntryACL
from crud.folder import FolderCRUD
from schemas import (
    AuthUser,
    ServiceOperationsUpdatePayload,
    ServiceTokenRotatePayload,
    ShareTarget,
    SimpleDetailSchema,
    UserCreatePayload,
    UserCreateResponse,
    UserFolderAccess,
    UserPasswordResetPayload,
    UserUpdatePayload,
)

router = APIRouter(tags=["users"])


@router.get("/share-targets", response_model=list[ShareTarget])
async def share_targets(
    context: AuthContextDep, session: SessionDep
) -> list[ShareTarget]:
    return await EntryACL(session, context).share_targets()


@router.get("", response_model=list[AuthUser])
async def list_users(context: AdminContextDep, crud: AuthCRUDDep) -> list[AuthUser]:
    return await crud.list_users(context)


@router.get("/{user_id}/folder-access", response_model=list[UserFolderAccess])
async def user_folder_access(
    user_id: int,
    context: AdminContextDep,
    session: SessionDep,
) -> list[UserFolderAccess]:
    return await FolderCRUD(session, context).user_access(user_id, context.key)


@router.post("", response_model=UserCreateResponse)
async def create_user(
    body: UserCreatePayload,
    context: AdminContextDep,
    crud: AuthCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> UserCreateResponse:
    factor_key = (
        await factors.step_up(
            context,
            "service-token-create",
            body.security_key_assertion,
            {
                "current_password": body.current_password or "",
                "target_role": str(body.role),
                "target_username": body.username,
            },
        )
        if body.role == "service"
        else None
    )
    return await crud.create_user(
        context,
        username=body.username,
        role=body.role,
        temporary_password=body.temporary_password,
        current_password=body.current_password,
        factor_key=factor_key,
    )


@router.patch("/{user_id}", response_model=AuthUser)
async def update_user(
    user_id: int,
    body: UserUpdatePayload,
    context: AdminContextDep,
    crud: AuthCRUDDep,
) -> AuthUser:
    return await crud.update_user(context, user_id, role=body.role, active=body.active)


@router.post("/{user_id}/sessions/revoke", response_model=SimpleDetailSchema)
async def revoke_sessions(
    user_id: int,
    context: AdminContextDep,
    crud: AuthCRUDDep,
) -> SimpleDetailSchema:
    count = await crud.revoke_user_sessions(context, user_id)
    return SimpleDetailSchema(detail=f"Revoked {count} active sessions.")


@router.post("/{user_id}/require-password-change", response_model=AuthUser)
async def require_password_change(
    user_id: int,
    context: AdminContextDep,
    crud: AuthCRUDDep,
) -> AuthUser:
    return await crud.require_password_change(context, user_id)


@router.post("/{user_id}/service-token", response_model=UserCreateResponse)
async def rotate_service_token(
    user_id: int,
    body: ServiceTokenRotatePayload,
    context: AdminContextDep,
    crud: AuthCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> UserCreateResponse:
    factor_key = await factors.step_up(
        context,
        "service-token-rotate",
        body.security_key_assertion,
        {"current_password": body.current_password, "target_user_id": user_id},
    )
    return await crud.rotate_service_token(
        context, user_id, body.current_password, factor_key
    )


@router.put("/{user_id}/service-operations", response_model=AuthUser)
async def update_service_operations(
    user_id: int,
    body: ServiceOperationsUpdatePayload,
    context: AdminContextDep,
    crud: AuthCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> AuthUser:
    factor_key = await factors.step_up(
        context,
        "service-operations",
        body.security_key_assertion,
        {
            "current_password": body.current_password,
            "operations": [str(operation) for operation in body.operations],
            "target_user_id": user_id,
        },
    )
    return await crud.update_service_operations(
        context, user_id, body.operations, body.current_password, factor_key
    )


@router.put("/{user_id}/password", response_model=AuthUser)
async def reset_password(
    user_id: int,
    body: UserPasswordResetPayload,
    context: AdminContextDep,
    crud: AuthCRUDDep,
) -> AuthUser:
    return await crud.reset_password(context, user_id, body.temporary_password)


@router.delete("/{user_id}", response_model=SimpleDetailSchema)
async def delete_user(
    user_id: int,
    context: AdminContextDep,
    crud: AuthCRUDDep,
) -> SimpleDetailSchema:
    await crud.delete_user(context, user_id)
    return SimpleDetailSchema(detail="User deleted.")
