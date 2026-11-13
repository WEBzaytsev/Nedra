import base64
import hashlib
import hmac
import os
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from crud.auth import AuthContext, AuthCRUD, fetch_user, hardware_factor_enabled
from crud.engine import after_commit
from crud.master_password import fetch_vault
from errors import Forbidden, InvalidRequest, NotFound
from helpers import (
    DecryptionFailed,
    DeviceUnlockSlot,
    VaultKey,
    unwrap_device_unlock_key,
    wrap_device_unlock_key,
)
from models import (
    AccessAuditModel,
    UserDeviceUnlockModel,
    UserDeviceUnlockPolicyModel,
    UserModel,
)
from schemas import (
    DeviceUnlockEnroll,
    DeviceUnlockEnrollAuthorization,
    DeviceUnlockInfo,
    DeviceUnlockLoginOptions,
    DeviceUnlockPolicyUpdate,
    DeviceUnlockRegistrationOptions,
    DeviceUnlockStatus,
    SecurityKeyAssertion,
    SecurityKeyChallenge,
    SecurityKeyDescriptor,
)
from settings import get_api_settings
from webauthn import (
    ALGORITHMS,
    RP_NAME,
    TIMEOUT_MS,
    Challenges,
    Credential,
    VerificationFailed,
    client_challenge,
    counter_advanced,
    registration_rp_id,
    session_binding,
    verify_assertion,
    verify_registration,
)

_MAX_DEVICES = 8
_USER_HANDLE = b"nedra-device-unlock"
_PASSWORD_INTERVAL_DAYS = (7, 14, 30)
_CLOCK_TOLERANCE = timedelta(minutes=5)


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _enroll_binding(token: str, rp_id: str) -> bytes:
    return hashlib.sha256(
        b"nedra/device-unlock/enroll/v1\0"
        + session_binding(token)
        + b"\0"
        + rp_id.encode()
    ).digest()


def _login_binding(user_id: int) -> bytes:
    return hashlib.sha256(f"nedra/device-unlock/login/v1/{user_id}".encode()).digest()


def _slot(row: UserDeviceUnlockModel) -> DeviceUnlockSlot:
    values = (row.uid, row.credential_id, row.public_key, row.prf_salt)
    if (
        not all(isinstance(value, bytes) for value in values)
        or len(row.uid) != 16
        or len(row.prf_salt) != 32
        or not row.rp_id
    ):
        raise InvalidRequest("The device-unlock record is damaged.")
    return DeviceUnlockSlot(
        row.user_id,
        row.uid,
        row.credential_id,
        row.public_key,
        row.rp_id,
        row.prf_salt,
        row.requires_factor,
    )


class DeviceUnlockCRUD:
    def __init__(
        self, session: AsyncSession, challenges: Challenges, vault_sessions
    ) -> None:
        self.session = session
        self.challenges = challenges
        self.vault_sessions = vault_sessions

    async def _rows(self, user_id: int) -> list[UserDeviceUnlockModel]:
        return list(
            (
                await self.session.scalars(
                    select(UserDeviceUnlockModel)
                    .where(UserDeviceUnlockModel.user_id == user_id)
                    .order_by(UserDeviceUnlockModel.id)
                    .execution_options(populate_existing=True)
                )
            ).all()
        )

    async def _policy(self, user_id: int) -> UserDeviceUnlockPolicyModel | None:
        return await self.session.get(UserDeviceUnlockPolicyModel, user_id)

    @staticmethod
    def _password_required(policy: UserDeviceUnlockPolicyModel | None) -> bool:
        if policy is None:
            return True
        now = datetime.now(UTC).replace(tzinfo=None)
        elapsed = now - policy.last_password_at
        return elapsed < -_CLOCK_TOLERANCE or elapsed >= timedelta(
            days=policy.password_interval_days
        )

    @staticmethod
    def _info(row: UserDeviceUnlockModel) -> DeviceUnlockInfo:
        return DeviceUnlockInfo(
            id=row.id,
            name=row.name,
            rp_id=row.rp_id,
            requires_factor=row.requires_factor,
            created=row.created,
            last_used=row.last_used,
        )

    async def status(self, user_id: int) -> DeviceUnlockStatus:
        rows = await self._rows(user_id)
        policy = await self._policy(user_id)
        return DeviceUnlockStatus(
            enabled=bool(rows),
            devices=[self._info(row) for row in rows],
            password_interval_days=(policy.password_interval_days if policy else 14),
        )

    async def registration_options(
        self,
        context: AuthContext,
        body: DeviceUnlockEnrollAuthorization,
        factor_key: bytes | None,
    ) -> DeviceUnlockRegistrationOptions:
        if context.token is None:
            raise Forbidden("A browser session is required for device unlock.")
        if body.rp_id not in get_api_settings().webauthn_rp_ids:
            raise Forbidden(
                "WebAuthn is not configured for this vault address. Ask the "
                "administrator to set WEBAUTHN_RP_IDS to the exact HTTPS host."
            )
        rows = await self._rows(context.user.id)
        if len(rows) >= _MAX_DEVICES:
            raise Forbidden(f"A user can have at most {_MAX_DEVICES} device unlocks.")
        binding = _enroll_binding(context.token, body.rp_id)
        registration = self.challenges.issue("device-register", binding)
        prf_salt = os.urandom(32)
        secret = self.challenges.issue(
            "device-register-secret", binding, prf_salt + (factor_key or b"")
        )
        return DeviceUnlockRegistrationOptions(
            challenge=_encode(registration),
            secret_challenge=_encode(secret),
            prf_salt=_encode(prf_salt),
            user_id=_encode(_USER_HANDLE),
            rp_name=RP_NAME,
            rp_id=body.rp_id,
            timeout_ms=TIMEOUT_MS,
            algorithms=list(ALGORITHMS),
            exclude_credentials=[_encode(row.credential_id) for row in rows],
        )

    async def enroll(
        self, context: AuthContext, body: DeviceUnlockEnroll
    ) -> DeviceUnlockStatus:
        if context.token is None:
            raise Forbidden("A browser session is required for device unlock.")
        if body.registration_rp_id not in get_api_settings().webauthn_rp_ids:
            raise Forbidden("WebAuthn is not configured for this vault address.")
        binding = _enroll_binding(context.token, body.registration_rp_id)
        rows = await self._rows(context.user.id)
        if len(rows) >= _MAX_DEVICES:
            raise Forbidden(f"A user can have at most {_MAX_DEVICES} device unlocks.")
        try:
            registration_data = body.registration.raw("client_data_json")
            registration_challenge = client_challenge(registration_data)
            self.challenges.consume(registration_challenge, "device-register", binding)
            credential = verify_registration(
                registration_rp_id(registration_data, body.registration_rp_id),
                registration_challenge,
                registration_data,
                body.registration.raw("attestation_object"),
            )
            if any(
                hmac.compare_digest(row.credential_id, credential.credential_id)
                for row in rows
            ):
                raise VerificationFailed(
                    "This device credential is already registered."
                )
            assertion_data = body.assertion.raw("client_data_json")
            if not hmac.compare_digest(
                body.assertion.raw("credential_id"), credential.credential_id
            ):
                raise VerificationFailed("The registering device did not answer.")
            secret_challenge = client_challenge(assertion_data)
            secret = self.challenges.consume(
                secret_challenge, "device-register-secret", binding
            )
            if len(secret) not in (32, 64):
                raise VerificationFailed("The device enrollment expired or is damaged.")
            prf_salt, factor_key = secret[:32], secret[32:] or None
            sign_count = verify_assertion(
                credential,
                secret_challenge,
                assertion_data,
                body.assertion.raw("authenticator_data"),
                body.assertion.raw("signature"),
            )
        except VerificationFailed as error:
            raise InvalidRequest(str(error)) from None
        await AuthCRUD(self.session, self.vault_sessions).verify_current_password(
            context, body.current_password, factor_key
        )
        requires_factor = factor_key is not None
        if requires_factor != await hardware_factor_enabled(
            self.session, context.user.id
        ):
            raise Forbidden(
                "The hardware-factor state changed. Start device enrollment again."
            )
        current = await fetch_user(self.session, context.user.id)
        vault = await fetch_vault(self.session)
        if current is None or vault is None or not context.key.matches(vault.key_check):
            raise Forbidden("The vault changed while device unlock was enrolled.")
        row = UserDeviceUnlockModel(
            user_id=current.id,
            uid=os.urandom(16),
            name=body.name,
            credential_id=credential.credential_id,
            public_key=credential.public_key,
            rp_id=credential.rp_id,
            prf_salt=prf_salt,
            requires_factor=requires_factor,
            sign_count=sign_count,
        )
        row.wrapped_key = wrap_device_unlock_key(
            body.assertion.raw("prf_output"), context.key, _slot(row), factor_key
        )
        self.session.add(row)
        policy = await self._policy(current.id)
        if policy is None:
            policy = UserDeviceUnlockPolicyModel(user_id=current.id)
            self.session.add(policy)
        else:
            policy.last_password_at = datetime.now(UTC).replace(tzinfo=None)
        self.session.add(
            AccessAuditModel(
                actor_user_id=current.id,
                action="device_unlock_enrolled",
                resource_type="user",
                resource_id=current.id,
                target_user_id=current.id,
            )
        )
        await self.session.flush()
        return await self.status(current.id)

    async def remove(self, context: AuthContext, device_id: int) -> DeviceUnlockStatus:
        row = await self.session.get(UserDeviceUnlockModel, device_id)
        if row is None or row.user_id != context.user.id:
            raise NotFound("Device unlock not found.")
        await self.session.delete(row)
        self.session.add(
            AccessAuditModel(
                actor_user_id=context.user.id,
                action="device_unlock_revoked",
                resource_type="user",
                resource_id=context.user.id,
                target_user_id=context.user.id,
            )
        )
        await self.session.flush()
        if not await self._rows(context.user.id):
            policy = await self._policy(context.user.id)
            if policy is not None:
                await self.session.delete(policy)
        after_commit(
            self.session,
            lambda user_id=context.user.id: self.vault_sessions.revoke_user(user_id),
        )
        return await self.status(context.user.id)

    async def update_policy(
        self, context: AuthContext, body: DeviceUnlockPolicyUpdate
    ) -> DeviceUnlockStatus:
        if not await self._rows(context.user.id):
            raise NotFound("No device unlock is configured.")
        policy = await self._policy(context.user.id)
        if policy is None:
            policy = UserDeviceUnlockPolicyModel(user_id=context.user.id)
            self.session.add(policy)
        policy.password_interval_days = body.password_interval_days
        await self.session.flush()
        return await self.status(context.user.id)

    async def login_options(self, username: str, factors) -> DeviceUnlockLoginOptions:
        user = await self.session.scalar(
            select(UserModel).where(
                UserModel.username == username,
                UserModel.active.is_(True),
                UserModel.role != "service",
            )
        )
        if user is None:
            return DeviceUnlockLoginOptions(password_required=False)
        rows = await self._rows(user.id)
        policy = await self._policy(user.id)
        if not rows or self._password_required(policy):
            return DeviceUnlockLoginOptions(password_required=bool(rows))
        challenge = self.challenges.issue("device-login", _login_binding(user.id))
        needs_factor = any(row.requires_factor for row in rows)
        return DeviceUnlockLoginOptions(
            password_required=False,
            challenge=SecurityKeyChallenge(
                challenge=_encode(challenge),
                timeout_ms=TIMEOUT_MS,
                keys=[
                    SecurityKeyDescriptor(
                        credential_id=_encode(row.credential_id),
                        rp_id=row.rp_id,
                        prf_salt=_encode(row.prf_salt),
                    )
                    for row in rows
                ],
            ),
            security_key_challenge=(
                await factors.login_challenge(user.id) if needs_factor else None
            ),
        )

    async def login(
        self,
        username: str,
        assertion: SecurityKeyAssertion,
        factor_assertion: SecurityKeyAssertion | None,
        factors,
    ) -> tuple[int, VaultKey, bool] | None:
        user = await self.session.scalar(
            select(UserModel).where(
                UserModel.username == username,
                UserModel.active.is_(True),
                UserModel.role != "service",
            )
        )
        if user is None:
            return None
        if self._password_required(await self._policy(user.id)):
            return None
        rows = await self._rows(user.id)
        credential_id = assertion.raw("credential_id")
        row = next(
            (
                item
                for item in rows
                if hmac.compare_digest(item.credential_id, credential_id)
            ),
            None,
        )
        if row is None:
            return None
        factor_enabled = await hardware_factor_enabled(self.session, user.id)
        if row.requires_factor != factor_enabled or (
            row.requires_factor and factor_assertion is None
        ):
            return None
        try:
            challenge = client_challenge(assertion.raw("client_data_json"))
            self.challenges.consume(challenge, "device-login", _login_binding(user.id))
            count = verify_assertion(
                Credential(row.credential_id, row.public_key, row.rp_id),
                challenge,
                assertion.raw("client_data_json"),
                assertion.raw("authenticator_data"),
                assertion.raw("signature"),
            )
        except VerificationFailed:
            return None
        if not counter_advanced(row.sign_count, count):
            return None
        result = await self.session.execute(
            update(UserDeviceUnlockModel)
            .where(
                UserDeviceUnlockModel.id == row.id,
                UserDeviceUnlockModel.sign_count == row.sign_count,
            )
            .values(sign_count=count, last_used=func.now())
        )
        if getattr(result, "rowcount", 0) != 1:
            return None
        factor_key = (
            await factors.verify_login(user.id, factor_assertion)
            if row.requires_factor
            else None
        )
        try:
            key = unwrap_device_unlock_key(
                assertion.raw("prf_output"), row.wrapped_key, _slot(row), factor_key
            )
        except DecryptionFailed:
            return None
        return user.id, key, row.requires_factor

    async def record_password_unlock(self, user_id: int) -> None:
        await self.session.execute(
            update(UserDeviceUnlockPolicyModel)
            .where(UserDeviceUnlockPolicyModel.user_id == user_id)
            .values(last_password_at=func.now())
        )

    async def invalidate_user(self, user_id: int) -> None:
        await self.session.execute(
            delete(UserDeviceUnlockModel).where(
                UserDeviceUnlockModel.user_id == user_id
            )
        )
        await self.session.execute(
            delete(UserDeviceUnlockPolicyModel).where(
                UserDeviceUnlockPolicyModel.user_id == user_id
            )
        )
