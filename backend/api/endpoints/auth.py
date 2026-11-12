import base64

from fastapi import APIRouter, Request

from api.endpoints.deps import (
    AuthContextDep,
    AuthCRUDDep,
    CredentialDep,
    DeviceUnlockCRUDDep,
    PasswordChangeContextDep,
    SecurityFactorCRUDDep,
    VaultSessionsDep,
)
from api.rate_limit import limiter, rate
from schemas import (
    AuthBootstrapPayload,
    AuthPayload,
    AuthResponse,
    AuthStatus,
    AuthUser,
    DeviceUnlockLoginOptions,
    DeviceUnlockLoginOptionsRequest,
    DeviceUnlockLoginPayload,
    EntryDraftKey,
    PasswordChangePayload,
    RecoverPasswordPayload,
    RecoveryAuthResponse,
    RecoveryCodePayload,
    RecoveryCodeResult,
    RecoveryStatus,
    SecurityKeyLoginPayload,
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
async def login(
    request: Request,
    body: AuthPayload,
    crud: AuthCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> AuthResponse:
    response = await crud.login(body.username, body.password)
    if response.security_key_required:
        challenge = await factors.login_challenge_for_username(body.username)
        return response.model_copy(
            update={"security_key_challenge": challenge.model_dump(mode="json")}
        )
    return response


@router.post("/login/security-key", response_model=AuthResponse)
@limiter.limit(rate("30/hour"))
async def login_with_security_key(
    request: Request,
    body: SecurityKeyLoginPayload,
    crud: AuthCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> AuthResponse:
    response = await crud.login(body.username, body.password)
    if not response.security_key_required:
        return AuthResponse(valid=False)
    user_id = await factors.user_id_for_username(body.username)
    if user_id is None:
        return AuthResponse(valid=False)
    factor_key = await factors.verify_login(user_id, body.assertion)
    return await crud.login(body.username, body.password, factor_key)


@router.post("/login/device-unlock/options", response_model=DeviceUnlockLoginOptions)
@limiter.limit(rate("30/hour"))
async def device_unlock_options(
    request: Request,
    body: DeviceUnlockLoginOptionsRequest,
    devices: DeviceUnlockCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> DeviceUnlockLoginOptions:
    return await devices.login_options(body.username, factors)


@router.post("/login/device-unlock", response_model=AuthResponse)
@limiter.limit(rate("30/hour"))
async def login_with_device_unlock(
    request: Request,
    body: DeviceUnlockLoginPayload,
    crud: AuthCRUDDep,
    devices: DeviceUnlockCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> AuthResponse:
    unlocked = await devices.login(
        body.username, body.assertion, body.security_key_assertion, factors
    )
    if unlocked is None:
        return AuthResponse(valid=False)
    user_id, key, second_factor = unlocked
    return await crud.login_with_device(user_id, key, second_factor)


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
    factors: SecurityFactorCRUDDep,
) -> RecoveryCodeResult:
    factor_key = await factors.step_up(
        context,
        "recovery-create",
        body.security_key_assertion,
        {"current_password": body.current_password},
    )
    return await crud.create_recovery_code(context, body.current_password, factor_key)


@router.delete("/recovery", response_model=RecoveryStatus)
@limiter.limit(rate("10/hour"))
async def revoke_recovery_code(
    request: Request,
    body: RecoveryCodePayload,
    context: PasswordChangeContextDep,
    crud: AuthCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> RecoveryStatus:
    factor_key = await factors.step_up(
        context,
        "recovery-revoke",
        body.security_key_assertion,
        {"current_password": body.current_password},
    )
    return await crud.revoke_recovery_code(context, body.current_password, factor_key)


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
    factors: SecurityFactorCRUDDep,
) -> AuthResponse:
    factor_key = await factors.step_up(
        context,
        "password-change",
        body.security_key_assertion,
        {"current_password": body.current_password, "new_password": body.new_password},
    )
    return await crud.change_password(
        context, body.current_password, body.new_password, factor_key=factor_key
    )
