import base64

from fastapi import APIRouter, Request

from api.endpoints.deps import (
    AuthContextDep,
    AuthCRUDDep,
    CredentialDep,
    PasswordChangeContextDep,
    VaultSessionsDep,
)
from api.rate_limit import limiter, rate
from schemas import (
    AuthBootstrapPayload,
    AuthPayload,
    AuthResponse,
    AuthStatus,
    AuthUser,
    EntryDraftKey,
    PasswordChangePayload,
    RecoverPasswordPayload,
    RecoveryAuthResponse,
    RecoveryCodePayload,
    RecoveryCodeResult,
    RecoveryStatus,
    SimpleDetailSchema,
)

router = APIRouter(tags=["auth"])


@router.get("/status", response_model=AuthStatus)
async def status(crud: AuthCRUDDep) -> AuthStatus:
    return await crud.status()


@router.post("/bootstrap", response_model=AuthResponse)
@limiter.limit(rate("5/hour"))
async def bootstrap(
    request: Request, body: AuthBootstrapPayload, crud: AuthCRUDDep
) -> AuthResponse:
    return await crud.bootstrap(body.username, body.password)


@router.post("/login", response_model=AuthResponse)
@limiter.limit(rate("30/hour"))
async def login(request: Request, body: AuthPayload, crud: AuthCRUDDep) -> AuthResponse:
    return await crud.login(body.username, body.password)


@router.post("/recover", response_model=RecoveryAuthResponse)
@limiter.limit(rate("10/hour"))
async def recover_password(
    request: Request, body: RecoverPasswordPayload, crud: AuthCRUDDep
) -> RecoveryAuthResponse:
    return await crud.recover_password(
        body.username, body.recovery_code, body.new_password
    )


@router.get("/me", response_model=AuthUser)
async def me(context: PasswordChangeContextDep, crud: AuthCRUDDep) -> AuthUser:
    return crud.to_user(context.user)


@router.post("/logout", response_model=SimpleDetailSchema)
async def logout(
    credential: CredentialDep, vault_sessions: VaultSessionsDep
) -> SimpleDetailSchema:
    vault_sessions.revoke(credential.token)
    return SimpleDetailSchema(detail="Logged out.")


@router.get("/recovery", response_model=RecoveryStatus)
async def recovery_status(
    context: PasswordChangeContextDep, crud: AuthCRUDDep
) -> RecoveryStatus:
    return await crud.recovery_status(context)


@router.post("/recovery", response_model=RecoveryCodeResult)
@limiter.limit(rate("10/hour"))
async def create_recovery_code(
    request: Request,
    body: RecoveryCodePayload,
    context: PasswordChangeContextDep,
    crud: AuthCRUDDep,
) -> RecoveryCodeResult:
    return await crud.create_recovery_code(context, body.current_password)


@router.delete("/recovery", response_model=RecoveryStatus)
@limiter.limit(rate("10/hour"))
async def revoke_recovery_code(
    request: Request,
    body: RecoveryCodePayload,
    context: PasswordChangeContextDep,
    crud: AuthCRUDDep,
) -> RecoveryStatus:
    return await crud.revoke_recovery_code(context, body.current_password)


@router.get("/entry-draft-key", response_model=EntryDraftKey)
async def entry_draft_key(context: AuthContextDep) -> EntryDraftKey:
    return EntryDraftKey(
        user_id=context.user.id,
        key=base64.b64encode(context.key.entry_draft_key(context.user.id)).decode(),
    )


@router.put("/password", response_model=AuthResponse)
@limiter.limit(rate("10/hour"))
async def change_password(
    request: Request,
    body: PasswordChangePayload,
    context: PasswordChangeContextDep,
    crud: AuthCRUDDep,
) -> AuthResponse:
    return await crud.change_password(context, body.current_password, body.new_password)
