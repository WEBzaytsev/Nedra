from fastapi import APIRouter, Request

from api.endpoints.deps import (
    AuthContextDep,
    DeviceUnlockCRUDDep,
    SecurityFactorCRUDDep,
)
from api.rate_limit import limiter, rate
from schemas import (
    DeviceUnlockEnroll,
    DeviceUnlockEnrollAuthorization,
    DeviceUnlockPolicyUpdate,
    DeviceUnlockRegistrationOptions,
    DeviceUnlockStatus,
    SecurityKeyAdd,
    SecurityKeyAddAuthorization,
    SecurityKeyDisable,
    SecurityKeyRegistrationOptions,
    SecurityKeyRemove,
    SecurityKeyStepUpOptions,
    SecurityKeyStepUpOptionsPayload,
    SecurityStatus,
)

router = APIRouter(tags=["security"])


@router.get("", response_model=SecurityStatus)
async def status(
    context: AuthContextDep, factors: SecurityFactorCRUDDep
) -> SecurityStatus:
    return await factors.status(context.user.id)


@router.post("/keys/options", response_model=SecurityKeyRegistrationOptions)
@limiter.limit(rate("10/hour"))
async def registration_options(
    request: Request,
    body: SecurityKeyAddAuthorization | None = None,
    *,
    context: AuthContextDep,
    factors: SecurityFactorCRUDDep,
) -> SecurityKeyRegistrationOptions:
    return await factors.registration_options(context, body)


@router.post("/keys", response_model=SecurityStatus)
@limiter.limit(rate("10/hour"))
async def add_key(
    request: Request,
    body: SecurityKeyAdd,
    context: AuthContextDep,
    factors: SecurityFactorCRUDDep,
) -> SecurityStatus:
    return await factors.add_key(context, body)


@router.delete("/keys/{key_id}", response_model=SecurityStatus)
@limiter.limit(rate("10/hour"))
async def remove_key(
    request: Request,
    key_id: int,
    body: SecurityKeyRemove,
    context: AuthContextDep,
    factors: SecurityFactorCRUDDep,
) -> SecurityStatus:
    return await factors.remove_key(context, key_id, body)


@router.post("/step-up/options", response_model=SecurityKeyStepUpOptions)
@limiter.limit(rate("30/hour"))
async def step_up_options(
    request: Request,
    body: SecurityKeyStepUpOptionsPayload,
    context: AuthContextDep,
    factors: SecurityFactorCRUDDep,
) -> SecurityKeyStepUpOptions:
    return await factors.step_up_options(context, body.action, body.context)


@router.delete("/keys", response_model=SecurityStatus)
@limiter.limit(rate("10/hour"))
async def disable(
    request: Request,
    body: SecurityKeyDisable,
    context: AuthContextDep,
    factors: SecurityFactorCRUDDep,
) -> SecurityStatus:
    return await factors.disable(context, body)


@router.get("/device-unlock", response_model=DeviceUnlockStatus)
async def device_unlock_status(
    context: AuthContextDep, devices: DeviceUnlockCRUDDep
) -> DeviceUnlockStatus:
    return await devices.status(context.user.id)


@router.post("/device-unlock/options", response_model=DeviceUnlockRegistrationOptions)
@limiter.limit(rate("10/hour"))
async def device_unlock_options(
    request: Request,
    body: DeviceUnlockEnrollAuthorization,
    context: AuthContextDep,
    devices: DeviceUnlockCRUDDep,
    factors: SecurityFactorCRUDDep,
) -> DeviceUnlockRegistrationOptions:
    factor_key = await factors.step_up(
        context,
        "device-unlock-enroll",
        body.security_key_assertion,
        {"current_password": body.current_password, "rp_id": body.rp_id},
    )
    return await devices.registration_options(context, body, factor_key)


@router.post("/device-unlock", response_model=DeviceUnlockStatus)
@limiter.limit(rate("10/hour"))
async def enroll_device_unlock(
    request: Request,
    body: DeviceUnlockEnroll,
    context: AuthContextDep,
    devices: DeviceUnlockCRUDDep,
) -> DeviceUnlockStatus:
    return await devices.enroll(context, body)


@router.delete("/device-unlock/{device_id}", response_model=DeviceUnlockStatus)
@limiter.limit(rate("10/hour"))
async def revoke_device_unlock(
    request: Request,
    device_id: int,
    context: AuthContextDep,
    devices: DeviceUnlockCRUDDep,
) -> DeviceUnlockStatus:
    return await devices.remove(context, device_id)


@router.put("/device-unlock/policy", response_model=DeviceUnlockStatus)
@limiter.limit(rate("10/hour"))
async def update_device_unlock_policy(
    request: Request,
    body: DeviceUnlockPolicyUpdate,
    context: AuthContextDep,
    devices: DeviceUnlockCRUDDep,
) -> DeviceUnlockStatus:
    return await devices.update_policy(context, body)
