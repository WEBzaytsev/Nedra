import base64
import hashlib
import hmac
import json
import os

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from crud.auth import AuthContext
from crud.engine import after_commit
from crud.master_password import _store, fetch_vault
from errors import Forbidden, InvalidRequest, NotFound
from helpers import (
    DecryptionFailed,
    SecurityKeySlot,
    new_factor_key,
    wrap_factor_key,
    wrap_key_material,
)
from models import (
    AccessAuditModel,
    UserDeviceUnlockModel,
    UserDeviceUnlockPolicyModel,
    UserModel,
    UserRecoveryModel,
    UserSecurityKeyModel,
)
from schemas import (
    SecurityAction,
    SecurityKeyAdd,
    SecurityKeyAddAuthorization,
    SecurityKeyAssertion,
    SecurityKeyChallenge,
    SecurityKeyDescriptor,
    SecurityKeyDisable,
    SecurityKeyInfo,
    SecurityKeyRegistrationOptions,
    SecurityKeyRemove,
    SecurityKeyStepUpOptions,
    SecurityStatus,
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

_MAX_KEYS = 8
_USER_HANDLE = b"nedra-user-factor"


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _binding(user_id: int) -> bytes:
    return hashlib.sha256(f"nedra/security-factor/{user_id}".encode()).digest()


def step_up_context(
    token: str, action: SecurityAction, fields: dict[str, object]
) -> bytes:
    """A session-keyed digest binds exact request fields without retaining them."""
    encoded = json.dumps(
        fields, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hmac.new(
        token.encode(),
        b"nedra/security-step-up-context/v1\0" + action.encode() + b"\0" + encoded,
        hashlib.sha256,
    ).digest()


def _step_up_binding(token: str, action: SecurityAction, context: bytes) -> bytes:
    return hashlib.sha256(
        b"nedra/security-step-up-binding/v1\0"
        + session_binding(token)
        + b"\0"
        + action.encode()
        + b"\0"
        + context
    ).digest()


def _slot(
    row: UserSecurityKeyModel, *, require_wrapped_factor_key: bool = True
) -> SecurityKeySlot:
    values = (row.uid, row.credential_id, row.public_key, row.prf_salt)
    if not all(isinstance(value, bytes) for value in values) or len(row.uid) != 16:
        raise InvalidRequest("The security-key record is damaged.")
    if (
        len(row.prf_salt) != 32
        or not row.rp_id
        or (require_wrapped_factor_key and not row.wrapped_factor_key)
    ):
        raise InvalidRequest("The security-key record is damaged.")
    return SecurityKeySlot(
        row.uid, row.credential_id, row.public_key, row.rp_id, row.prf_salt
    )


class SecurityFactorCRUD:
    def __init__(
        self, session: AsyncSession, challenges: Challenges, vault_sessions
    ) -> None:
        self.session = session
        self.challenges = challenges
        self.vault_sessions = vault_sessions

    async def _rows(self, user_id: int) -> list[UserSecurityKeyModel]:
        return list(
            (
                await self.session.scalars(
                    select(UserSecurityKeyModel)
                    .where(UserSecurityKeyModel.user_id == user_id)
                    .order_by(UserSecurityKeyModel.id)
                    .execution_options(populate_existing=True)
                )
            ).all()
        )

    async def enabled(self, user_id: int) -> bool:
        return bool(
            await self.session.scalar(
                select(UserSecurityKeyModel.id)
                .where(UserSecurityKeyModel.user_id == user_id)
                .limit(1)
            )
        )

    async def status(self, user_id: int) -> SecurityStatus:
        rows = await self._rows(user_id)
        return SecurityStatus(
            enabled=bool(rows),
            security_keys=[
                SecurityKeyInfo(
                    id=row.id,
                    name=row.name,
                    rp_id=row.rp_id,
                    created=row.created,
                    last_used=row.last_used,
                )
                for row in rows
            ],
        )

    async def registration_options(
        self, context: AuthContext, authorization: SecurityKeyAddAuthorization | None
    ) -> SecurityKeyRegistrationOptions:
        rows = await self._rows(context.user.id)
        factor_key: bytes | None = None
        binding = _binding(context.user.id)
        if rows:
            if authorization is None:
                raise Forbidden(
                    "Fresh hardware-factor confirmation is required to add a backup "
                    "key."
                )
            factor_key = await self.step_up(
                context,
                "security-key-add",
                authorization.security_key_assertion,
                {
                    "current_password": authorization.current_password,
                    "rp_id": authorization.rp_id,
                },
            )
            from crud.auth import AuthCRUD

            await AuthCRUD(self.session, self.vault_sessions).verify_current_password(
                context, authorization.current_password, factor_key
            )
            assert context.token is not None
            binding = _step_up_binding(
                context.token,
                "security-key-add",
                step_up_context(
                    context.token,
                    "security-key-add",
                    {
                        "current_password": authorization.current_password,
                        "rp_id": authorization.rp_id,
                    },
                ),
            )
        rp_id = (
            authorization.rp_id
            if authorization
            else get_api_settings().webauthn_rp_ids[0]
        )
        if rp_id not in get_api_settings().webauthn_rp_ids:
            raise Forbidden(
                "WebAuthn is not configured for this vault address. "
                "Ask the administrator to set WEBAUTHN_RP_IDS to the exact "
                "HTTPS host and restart the backend."
            )
        binding = hashlib.sha256(binding + b"\0" + rp_id.encode()).digest()
        registration = self.challenges.issue("register", binding)
        prf_salt = os.urandom(32)
        secret = self.challenges.issue(
            "register-secret", binding, prf_salt + (factor_key or b"")
        )
        return SecurityKeyRegistrationOptions(
            challenge=_encode(registration),
            secret_challenge=_encode(secret),
            prf_salt=_encode(prf_salt),
            user_id=_encode(_USER_HANDLE),
            rp_name=RP_NAME,
            rp_id=rp_id,
            timeout_ms=TIMEOUT_MS,
            algorithms=list(ALGORITHMS),
            exclude_credentials=[_encode(row.credential_id) for row in rows],
        )

    async def add_key(
        self, context: AuthContext, body: SecurityKeyAdd
    ) -> SecurityStatus:
        rows = await self._rows(context.user.id)
        if len(rows) >= _MAX_KEYS:
            raise Forbidden(f"A user can have at most {_MAX_KEYS} security keys.")
        if body.registration_rp_id not in get_api_settings().webauthn_rp_ids:
            raise Forbidden(
                "WebAuthn is not configured for this vault address. "
                "Ask the administrator to set WEBAUTHN_RP_IDS to the exact "
                "HTTPS host and restart the backend."
            )
        binding = _binding(context.user.id)
        if rows:
            if context.token is None:
                raise Forbidden("A browser session is required for this confirmation.")
            binding = _step_up_binding(
                context.token,
                "security-key-add",
                step_up_context(
                    context.token,
                    "security-key-add",
                    {
                        "current_password": body.current_password,
                        "rp_id": body.registration_rp_id,
                    },
                ),
            )
        binding = hashlib.sha256(
            binding + b"\0" + body.registration_rp_id.encode()
        ).digest()
        try:
            client_data = body.registration.raw("client_data_json")
            challenge = client_challenge(client_data)
            self.challenges.consume(challenge, "register", binding)
            credential = verify_registration(
                registration_rp_id(client_data, body.registration_rp_id),
                challenge,
                client_data,
                body.registration.raw("attestation_object"),
            )
            if any(
                hmac.compare_digest(row.credential_id, credential.credential_id)
                for row in rows
            ):
                raise VerificationFailed("This security key is already registered.")
            assertion = body.assertion
            if not hmac.compare_digest(
                assertion.raw("credential_id"), credential.credential_id
            ):
                raise VerificationFailed("The registering security key did not answer.")
            assertion_data = assertion.raw("client_data_json")
            secret_challenge = client_challenge(assertion_data)
            secret = self.challenges.consume(
                secret_challenge, "register-secret", binding
            )
            if len(secret) not in (32, 64):
                raise VerificationFailed(
                    "The security-key registration expired or is damaged."
                )
            prf_salt, factor_key = secret[:32], secret[32:] or new_factor_key()
            sign_count = verify_assertion(
                credential,
                secret_challenge,
                assertion_data,
                assertion.raw("authenticator_data"),
                assertion.raw("signature"),
            )
        except VerificationFailed as error:
            raise InvalidRequest(str(error)) from None
        from crud.auth import AuthCRUD, store_user_material

        checker = AuthCRUD(self.session, self.vault_sessions)
        await checker.verify_current_password(
            context, body.current_password, factor_key if rows else None
        )
        row = UserSecurityKeyModel(
            user_id=context.user.id,
            uid=os.urandom(16),
            name=body.name,
            credential_id=credential.credential_id,
            public_key=credential.public_key,
            rp_id=credential.rp_id,
            prf_salt=prf_salt,
            sign_count=sign_count,
        )
        row.wrapped_factor_key = wrap_factor_key(
            assertion.raw("prf_output"),
            factor_key,
            _slot(row, require_wrapped_factor_key=False),
        )
        current = await self.session.get(type(context.user), context.user.id)
        vault = await fetch_vault(self.session)
        if current is None or vault is None or not context.key.matches(vault.key_check):
            raise Forbidden("The vault changed while the security key was added.")
        if not rows:
            await self.session.execute(
                delete(UserDeviceUnlockModel).where(
                    UserDeviceUnlockModel.user_id == current.id
                )
            )
            await self.session.execute(
                delete(UserDeviceUnlockPolicyModel).where(
                    UserDeviceUnlockPolicyModel.user_id == current.id
                )
            )
            replacement = await wrap_key_material(
                body.current_password, context.key, factor_key=factor_key
            )
            store_user_material(current, replacement)
            if vault.owner_user_id == current.id:
                _store(vault, replacement)
            await self.session.execute(
                delete(UserRecoveryModel).where(UserRecoveryModel.user_id == current.id)
            )
        self.session.add(row)
        self.session.add(
            AccessAuditModel(
                actor_user_id=current.id,
                action="hardware_factor_enabled"
                if not rows
                else "hardware_factor_key_added",
                resource_type="user",
                resource_id=current.id,
                target_user_id=current.id,
            )
        )
        await self.session.flush()
        after_commit(
            self.session,
            lambda user_id=current.id: self.vault_sessions.revoke_user(user_id),
        )
        return await self.status(current.id)

    async def user_id_for_username(self, username: str) -> int | None:
        return await self.session.scalar(
            select(UserSecurityKeyModel.user_id)
            .join(UserModel, UserModel.id == UserSecurityKeyModel.user_id)
            .where(
                UserModel.username == username,
                UserModel.active.is_(True),
                UserModel.role != "service",
            )
            .limit(1)
        )

    async def login_challenge_for_username(self, username: str) -> SecurityKeyChallenge:
        user_id = await self.user_id_for_username(username)
        if user_id is None:
            raise NotFound("No hardware factor is configured.")
        return await self.login_challenge(user_id)

    async def login_challenge(self, user_id: int) -> SecurityKeyChallenge:
        rows = await self._rows(user_id)
        if not rows:
            raise NotFound("No hardware factor is configured.")
        challenge = self.challenges.issue("login", _binding(user_id))
        return SecurityKeyChallenge(
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
        )

    async def step_up_options(
        self, context: AuthContext, action: SecurityAction, requested_context: str
    ) -> SecurityKeyStepUpOptions:
        if not await self.enabled(context.user.id):
            return SecurityKeyStepUpOptions(required=False)
        if context.token is None:
            raise Forbidden("A browser session is required for this confirmation.")
        try:
            context_hash = _decode(requested_context)
        except (ValueError, TypeError):
            raise InvalidRequest("The security-key request is malformed.") from None
        if len(context_hash) != 32:
            raise InvalidRequest("The security-key request is malformed.")
        return SecurityKeyStepUpOptions(
            required=True,
            challenge=await self._challenge(
                context.user.id,
                "step-up",
                _step_up_binding(context.token, action, context_hash),
            ),
        )

    async def step_up(
        self,
        context: AuthContext,
        action: SecurityAction,
        assertion: SecurityKeyAssertion | None,
        fields: dict[str, object],
    ) -> bytes | None:
        if not await self.enabled(context.user.id):
            if assertion is not None:
                raise Forbidden("No hardware factor is configured for this account.")
            return None
        if assertion is None:
            raise Forbidden("Fresh hardware-factor confirmation is required.")
        if context.token is None:
            raise Forbidden("A browser session is required for this confirmation.")
        return await self._verify(
            context.user.id,
            assertion,
            "step-up",
            _step_up_binding(
                context.token, action, step_up_context(context.token, action, fields)
            ),
        )

    async def _challenge(
        self, user_id: int, purpose: str, binding: bytes
    ) -> SecurityKeyChallenge:
        rows = await self._rows(user_id)
        if not rows:
            raise NotFound("No hardware factor is configured.")
        challenge = self.challenges.issue(purpose, binding)
        return SecurityKeyChallenge(
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
        )

    async def verify_login(
        self, user_id: int, assertion: SecurityKeyAssertion
    ) -> bytes:
        return await self._verify(user_id, assertion, "login", _binding(user_id))

    async def _verify(
        self,
        user_id: int,
        assertion: SecurityKeyAssertion,
        purpose: str,
        binding: bytes,
    ) -> bytes:
        rows = await self._rows(user_id)
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
            raise Forbidden("This security key is not registered for this user.")
        try:
            challenge = client_challenge(assertion.raw("client_data_json"))
            self.challenges.consume(challenge, purpose, binding)
            count = verify_assertion(
                Credential(row.credential_id, row.public_key, row.rp_id),
                challenge,
                assertion.raw("client_data_json"),
                assertion.raw("authenticator_data"),
                assertion.raw("signature"),
            )
        except VerificationFailed as error:
            raise Forbidden(str(error)) from None
        if not counter_advanced(row.sign_count, count):
            raise Forbidden(
                "The security-key counter did not advance. Use another key."
            )
        result = await self.session.execute(
            update(UserSecurityKeyModel)
            .where(
                UserSecurityKeyModel.id == row.id,
                UserSecurityKeyModel.sign_count == row.sign_count,
            )
            .values(sign_count=count, last_used=func.now())
        )
        if getattr(result, "rowcount", 0) != 1:
            raise Forbidden("The security key was used concurrently. Try again.")
        try:
            from helpers import unwrap_factor_key

            return unwrap_factor_key(
                assertion.raw("prf_output"), row.wrapped_factor_key, _slot(row)
            )
        except DecryptionFailed:
            raise Forbidden(
                "The security key did not return the expected secret."
            ) from None

    async def remove_key(
        self, context: AuthContext, key_id: int, body: SecurityKeyRemove
    ) -> SecurityStatus:
        factor_key = await self.step_up(
            context,
            "security-key-remove",
            body.security_key_assertion,
            {"current_password": body.current_password, "target_key_id": key_id},
        )
        from crud.auth import AuthCRUD

        await AuthCRUD(self.session, self.vault_sessions).verify_current_password(
            context, body.current_password, factor_key
        )
        rows = await self._rows(context.user.id)
        if len(rows) < 2:
            raise Forbidden("Add a backup key before removing your last security key.")
        if not any(row.id == key_id for row in rows):
            raise NotFound("Security key not found.")
        await self.session.execute(
            delete(UserSecurityKeyModel).where(
                UserSecurityKeyModel.user_id == context.user.id,
                UserSecurityKeyModel.id == key_id,
            )
        )
        self.session.add(
            AccessAuditModel(
                actor_user_id=context.user.id,
                action="hardware_factor_key_removed",
                resource_type="user",
                resource_id=context.user.id,
                target_user_id=context.user.id,
            )
        )
        await self.session.flush()
        after_commit(
            self.session,
            lambda user_id=context.user.id: self.vault_sessions.revoke_user(user_id),
        )
        return await self.status(context.user.id)

    async def disable(
        self, context: AuthContext, body: SecurityKeyDisable
    ) -> SecurityStatus:
        factor_key = await self.step_up(
            context,
            "security-factor-disable",
            body.security_key_assertion,
            {"current_password": body.current_password},
        )
        from crud.auth import AuthCRUD, store_user_material

        checker = AuthCRUD(self.session, self.vault_sessions)
        await checker.verify_current_password(
            context, body.current_password, factor_key
        )
        current = await self.session.get(UserModel, context.user.id)
        vault = await fetch_vault(self.session)
        if current is None or vault is None or not context.key.matches(vault.key_check):
            raise Forbidden("The session expired.")
        replacement = await wrap_key_material(body.current_password, context.key)
        store_user_material(current, replacement)
        if vault.owner_user_id == current.id:
            _store(vault, replacement)
        await self.session.execute(
            delete(UserSecurityKeyModel).where(
                UserSecurityKeyModel.user_id == current.id
            )
        )
        await self.session.execute(
            delete(UserDeviceUnlockModel).where(
                UserDeviceUnlockModel.user_id == current.id
            )
        )
        await self.session.execute(
            delete(UserDeviceUnlockPolicyModel).where(
                UserDeviceUnlockPolicyModel.user_id == current.id
            )
        )
        self.session.add(
            AccessAuditModel(
                actor_user_id=current.id,
                action="hardware_factor_disabled",
                resource_type="user",
                resource_id=current.id,
                target_user_id=current.id,
            )
        )
        await self.session.flush()
        after_commit(
            self.session,
            lambda user_id=current.id: self.vault_sessions.revoke_user(user_id),
        )
        return SecurityStatus(enabled=False, security_keys=[])
