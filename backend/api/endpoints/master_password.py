from fastapi import (
    APIRouter,
    Depends,
    Request,
    status,
)

from api.endpoints.deps import (
    AuthContextDep,
    AuthCRUDDep,
    CredentialDep,
    SecurityFactorCRUDDep,
    SessionTokenHeader,
    VaultAccessDep,
    VaultSessionsDep,
    get_vault_key,
    get_vault_key_quietly,
    require_master_password,
)
from api.rate_limit import limiter, rate
from api.responses import inject_responses
from schemas import (
    MasterPassword,
    MasterPasswordCreate,
    MasterPasswordCreatePayload,
    MasterPasswordStatus,
    MasterPasswordUpdate,
    MasterPasswordUpdatePayload,
    SimpleDetailSchema,
    VaultLock,
    VaultSessionStatus,
    VaultUnlock,
)

router = APIRouter(tags=["master-password"])


@router.get(
    "/status",
    name="master-password:status",
    response_model=MasterPasswordStatus,
)
async def get_status(
    crud: AuthCRUDDep,
) -> MasterPasswordStatus:
    return MasterPasswordStatus(initialized=(await crud.status()).initialized)


@router.post(
    "/unlock",
    name="master-password:unlock",
    response_model=VaultUnlock,
    responses=inject_responses(
        {
            status.HTTP_404_NOT_FOUND: SimpleDetailSchema,
            status.HTTP_429_TOO_MANY_REQUESTS: SimpleDetailSchema,
        }
    ),
)
@limiter.limit(rate("30/hour"))
async def unlock(
    request: Request,
    body: MasterPassword,
    crud: AuthCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> VaultUnlock:
    result = await crud.login_primary(body.master_password)
    if result.security_key_required:
        user_id = await crud.primary_user_id()
        if user_id is None:
            raise RuntimeError("The primary vault owner is missing.")
        if body.security_key_assertion is None:
            return VaultUnlock(
                valid=False,
                security_key_required=True,
                security_key_challenge=await factors.login_challenge(user_id),
            )
        result = await crud.login_primary(
            body.master_password,
            await factors.verify_login(user_id, body.security_key_assertion),
        )
    return VaultUnlock(
        valid=result.valid,
        session_token=result.session_token,
        idle_timeout_ms=result.idle_timeout_ms,
    )


@router.post(
    "/lock",
    name="master-password:lock",
    response_model=VaultLock,
)
async def lock(
    token: SessionTokenHeader, vault_sessions: VaultSessionsDep
) -> VaultLock:
    vault_sessions.revoke(token)
    return VaultLock(locked=True)


@router.get(
    "/session",
    name="master-password:session",
    response_model=VaultSessionStatus,
    dependencies=[Depends(require_master_password), Depends(get_vault_key_quietly)],
    responses=inject_responses({status.HTTP_403_FORBIDDEN: SimpleDetailSchema}),
)
async def get_session_status(
    access: VaultAccessDep, credential: CredentialDep
) -> VaultSessionStatus:
    return access.status(credential)


@router.post(
    "/session",
    name="master-password:session-activity",
    response_model=VaultSessionStatus,
    dependencies=[Depends(require_master_password), Depends(get_vault_key)],
    responses=inject_responses({status.HTTP_403_FORBIDDEN: SimpleDetailSchema}),
)
async def record_session_activity(
    access: VaultAccessDep, credential: CredentialDep
) -> VaultSessionStatus:
    return access.status(credential)


@router.post(
    "/create",
    name="master-password:create",
    response_model=MasterPasswordCreate,
    responses=inject_responses(
        {
            status.HTTP_403_FORBIDDEN: SimpleDetailSchema,
            status.HTTP_429_TOO_MANY_REQUESTS: SimpleDetailSchema,
        }
    ),
)
@limiter.limit(rate("5/hour"))
async def create_master_password(
    request: Request,
    body: MasterPasswordCreatePayload,
    crud: AuthCRUDDep,
) -> MasterPasswordCreate:
    result = await crud.bootstrap("admin", body.master_password)
    if result.session_token is None or result.idle_timeout_ms is None:
        raise RuntimeError("A newly created vault did not open a session.")
    return MasterPasswordCreate(
        created=True,
        detail="Master password created successfully.",
        session_token=result.session_token,
        idle_timeout_ms=result.idle_timeout_ms,
    )


@router.patch(
    "/update",
    name="master-password:update",
    response_model=MasterPasswordUpdate,
    dependencies=[Depends(get_vault_key)],
    responses=inject_responses(
        {
            status.HTTP_404_NOT_FOUND: SimpleDetailSchema,
            status.HTTP_403_FORBIDDEN: SimpleDetailSchema,
            status.HTTP_400_BAD_REQUEST: SimpleDetailSchema,
            status.HTTP_429_TOO_MANY_REQUESTS: SimpleDetailSchema,
        }
    ),
)
@limiter.limit(rate("10/hour"))
async def update_master_password(
    request: Request,
    body: MasterPasswordUpdatePayload,
    context: AuthContextDep,
    crud: AuthCRUDDep,
) -> MasterPasswordUpdate:
    await crud.change_password(
        context,
        body.master_password,
        body.new_master_password,
        open_session=False,
    )
    return MasterPasswordUpdate(
        updated=True, detail="Master password updated successfully."
    )
