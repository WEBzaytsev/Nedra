import asyncio
import base64
import hashlib
import logging
import secrets
from dataclasses import dataclass, field

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from crud.base import BaseCRUD
from crud.engine import Database, after_commit, after_rollback
from crud.folder import migrate_folder_links
from crud.master_password import _store, fetch_vault, key_material
from crud.settings import SettingsCRUD
from errors import (
    Forbidden,
    InvalidRequest,
    NotFound,
    SessionRequired,
    UseHandoff,
    VaultBusy,
)
from helpers import (
    KDF_NAME,
    DecryptionFailed,
    KdfParams,
    KeyMaterial,
    UnsupportedKdf,
    VaultKey,
    create_key_material,
    unlock_key_material,
    wrap_key_material,
)
from models import (
    AccessAuditModel,
    AttachmentModel,
    EntryAccessModel,
    EntryModel,
    FolderModel,
    UserDeviceUnlockModel,
    UserDeviceUnlockPolicyModel,
    UserModel,
    UserRecoveryModel,
    UserSecurityKeyModel,
    VaultModel,
)
from schemas import (
    DEFAULT_SERVICE_OPERATIONS,
    AuthResponse,
    AuthStatus,
    AuthUser,
    ExtensionSessionCreated,
    RecoveryAuthResponse,
    RecoveryCodeResult,
    RecoveryStatus,
    ServiceOperation,
    UserCreateResponse,
    UserRole,
    service_operation_mask,
    service_operations_from_mask,
)
from vault_sessions import Scope, VaultSessions

logger = logging.getLogger(__name__)

_INVALID_LOGIN = "Invalid username or password."
_SESSION_ENDED = "Your session expired, was revoked, or the account was disabled."
_DAMAGED = (
    "An account key record failed to verify. The vault file may be damaged; "
    "restore a snapshot (docs/UPDATING.md)."
)
_HARDWARE_STEP_UP_REQUIRED = (
    "Hardware-factor re-confirmation is required; this sensitive action is unavailable "
    "until that step-up flow is implemented."
)


@dataclass(frozen=True, slots=True)
class AuthContext:
    user: UserModel
    key: VaultKey = field(repr=False)
    token: str | None = field(default=None, repr=False)

    @property
    def owner_id(self) -> int:
        return self.user.service_owner_id or self.user.id


async def _record_password_unlock(database: Database, user_id: int) -> None:
    try:
        async with database.transaction() as session:
            await session.execute(
                update(UserDeviceUnlockPolicyModel)
                .where(UserDeviceUnlockPolicyModel.user_id == user_id)
                .values(last_password_at=func.now())
            )
    except VaultBusy:
        pass


def token_digest(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def user_key_material(
    model: UserModel | UserRecoveryModel, second_factor: bool = False
) -> KeyMaterial:
    for value, length in (
        (model.kdf_salt, 16),
        (model.password_check, 32),
        (model.wrapped_key, 61),
        (model.key_check, 32),
    ):
        if not isinstance(value, bytes) or len(value) != length:
            raise InvalidRequest(_DAMAGED)
    if model.kdf != KDF_NAME:
        raise InvalidRequest("The account uses a key format this release cannot read.")
    params = KdfParams(model.kdf_memory_kib, model.kdf_iterations, model.kdf_lanes)
    try:
        params.require_supported()
    except UnsupportedKdf as error:
        raise InvalidRequest(str(error)) from None
    return KeyMaterial(
        params=params,
        salt=model.kdf_salt,
        password_check=model.password_check,
        wrapped_key=model.wrapped_key,
        key_check=model.key_check,
        second_factor=second_factor,
    )


def store_user_material(model: UserModel, material: KeyMaterial) -> None:
    model.kdf = KDF_NAME
    model.kdf_memory_kib = material.params.memory_kib
    model.kdf_iterations = material.params.iterations
    model.kdf_lanes = material.params.lanes
    model.kdf_salt = material.salt
    model.password_check = material.password_check
    model.wrapped_key = material.wrapped_key
    model.key_check = material.key_check


def recovery_code() -> str:
    raw = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    return "-".join(raw[index : index + 4] for index in range(0, len(raw), 4))


def normalize_recovery_code(value: str) -> str | None:
    normalized = "".join(value.upper().split()).replace("-", "")
    if len(normalized) != 32 or any(
        char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" for char in normalized
    ):
        return None
    return normalized


def store_recovery_material(model: UserRecoveryModel, material: KeyMaterial) -> None:
    model.kdf = KDF_NAME
    model.kdf_memory_kib = material.params.memory_kib
    model.kdf_iterations = material.params.iterations
    model.kdf_lanes = material.params.lanes
    model.kdf_salt = material.salt
    model.password_check = material.password_check
    model.wrapped_key = material.wrapped_key
    model.key_check = material.key_check


async def fetch_user(session: AsyncSession, user_id: int) -> UserModel | None:
    statement = (
        select(UserModel)
        .where(UserModel.id == user_id)
        .execution_options(populate_existing=True)
    )
    return await session.scalar(statement)


def credential_fingerprint(model: UserModel, second_factor: bool = False) -> bytes:
    material = user_key_material(model, second_factor)
    digest = hashlib.sha256()
    for value in (
        model.kdf.encode(),
        material.params.memory_kib.to_bytes(8, "big"),
        material.params.iterations.to_bytes(8, "big"),
        material.params.lanes.to_bytes(8, "big"),
        material.salt,
        material.password_check,
        material.wrapped_key,
        material.key_check,
    ):
        digest.update(len(value).to_bytes(4, "big"))
        digest.update(value)
    return digest.digest()


async def hardware_factor_enabled(session: AsyncSession, user_id: int) -> bool:
    return bool(
        await session.scalar(
            select(UserSecurityKeyModel.id)
            .where(UserSecurityKeyModel.user_id == user_id)
            .limit(1)
        )
    )


def _same_stored_material(left: KeyMaterial, right: KeyMaterial) -> bool:
    """`second_factor` is wrapper semantics, not a vault-table column."""
    return (
        left.params == right.params
        and left.salt == right.salt
        and left.password_check == right.password_check
        and left.wrapped_key == right.wrapped_key
        and left.key_check == right.key_check
    )


async def validate_vault_material(
    session: AsyncSession, vault: VaultModel
) -> KeyMaterial:
    material = key_material(vault)
    if vault.owner_user_id is None:
        return material
    owner = await fetch_user(session, vault.owner_user_id)
    if owner is None or not _same_stored_material(
        user_key_material(owner, await hardware_factor_enabled(session, owner.id)),
        material,
    ):
        raise InvalidRequest(_DAMAGED)
    return material


async def open_material(
    password: str, material: KeyMaterial, factor_key: bytes | None = None
) -> VaultKey | None:
    try:
        return await unlock_key_material(password, material, factor_key)
    except UnsupportedKdf as error:
        raise InvalidRequest(str(error)) from None
    except DecryptionFailed:
        logger.error("An account key record failed to verify.")
        raise InvalidRequest(_DAMAGED) from None


class AuthCRUD(BaseCRUD):
    def __init__(
        self,
        session: AsyncSession,
        vault_sessions: VaultSessions,
        database: Database | None = None,
    ) -> None:
        super().__init__(session)
        self.vault_sessions = vault_sessions
        self.database = database

    @staticmethod
    def to_user(model: UserModel) -> AuthUser:
        return AuthUser(
            id=model.id,
            username=model.username,
            role=UserRole(model.role),
            active=model.active,
            must_change_password=model.must_change_password,
            service_operations=(
                service_operations_from_mask(model.service_operations)
                if model.role == UserRole.service
                else []
            ),
        )

    async def status(self) -> AuthStatus:
        count = await self.session.scalar(select(func.count()).select_from(UserModel))
        return AuthStatus(initialized=bool(count))

    async def _refresh_timeout(self) -> None:
        inactivity_ms = await SettingsCRUD(
            self.session, self.vault_sessions
        ).inactivity_ms()
        self.vault_sessions.set_idle_timeout(inactivity_ms)

    def _open_session(
        self, user: UserModel, key: VaultKey, second_factor: bool = False
    ) -> AuthResponse:
        token = self.vault_sessions.open(
            key, user.id, credential_fingerprint(user, second_factor)
        )
        after_rollback(self.session, lambda: self.vault_sessions.revoke(token))
        return AuthResponse(
            valid=True,
            user=self.to_user(user),
            session_token=token,
            idle_timeout_ms=self.vault_sessions.idle_timeout_ms,
        )

    async def bootstrap(self, username: str, password: str) -> AuthResponse:
        vault = await fetch_vault(self.session)
        if await self.session.scalar(select(UserModel.id).limit(1)) is not None:
            if vault is None:
                raise InvalidRequest(_DAMAGED)
            raise Forbidden("CipherMoth is already initialized.")
        if vault is None:
            if (
                await self.session.scalar(select(EntryModel.id).limit(1)) is not None
                or await self.session.scalar(select(AttachmentModel.id).limit(1))
                is not None
            ):
                raise InvalidRequest(
                    "The vault file holds records but no key record, so it is damaged. "
                    "Restore a snapshot, or move it aside with 'ciphermoth-admin "
                    "set-aside' to start a new vault (docs/UPDATING.md)."
                )
            await self.session.commit()
            material, key = await create_key_material(password)
            if await self.session.scalar(select(UserModel.id).limit(1)) is not None:
                raise Forbidden("CipherMoth is already initialized.")
            if await fetch_vault(self.session) is not None:
                raise Forbidden("CipherMoth is already initialized.")
            user = UserModel(
                username=username,
                role=UserRole.admin,
                active=True,
                must_change_password=False,
            )
            store_user_material(user, material)
            self.session.add(user)
            await self.session.flush()
            vault = VaultModel(id=1, owner_user_id=user.id)
            _store(vault, material)
            self.session.add(vault)
        else:
            observed = key_material(vault)
            await self.session.commit()
            key = await open_material(password, observed)
            if key is None:
                return AuthResponse(valid=False)
            if await self.session.scalar(select(UserModel.id).limit(1)) is not None:
                raise Forbidden("CipherMoth is already initialized.")
            current = await fetch_vault(self.session)
            if current is None or key_material(current) != observed:
                raise Forbidden("The vault changed while the account was created.")
            user = UserModel(
                username=username,
                role=UserRole.admin,
                active=True,
                must_change_password=False,
            )
            store_user_material(user, observed)
            self.session.add(user)
            await self.session.flush()
            current.owner_user_id = user.id
        await self.session.execute(
            update(EntryModel)
            .where(EntryModel.owner_id.is_(None))
            .values(owner_id=user.id)
        )
        await migrate_folder_links(self.session, key)
        await self._refresh_timeout()
        return self._open_session(user, key)

    async def login(
        self, username: str, password: str, factor_key: bytes | None = None
    ) -> AuthResponse:
        user = await self.session.scalar(
            select(UserModel).where(
                UserModel.username == username,
                UserModel.active.is_(True),
                UserModel.role != UserRole.service,
            )
        )
        if user is None:
            await self.session.commit()
            await create_key_material(password)
            return AuthResponse(valid=False)
        factor_enabled = bool(
            await self.session.scalar(
                select(UserSecurityKeyModel.id)
                .where(UserSecurityKeyModel.user_id == user.id)
                .limit(1)
            )
        )
        if factor_enabled and factor_key is None:
            return AuthResponse(valid=False, security_key_required=True)
        observed = user_key_material(user, factor_enabled)
        user_id = user.id
        vault = await fetch_vault(self.session)
        if vault is None:
            raise InvalidRequest(_DAMAGED)
        key_material(vault)
        await self.session.commit()
        key = await open_material(password, observed, factor_key)
        if key is None:
            return AuthResponse(valid=False)
        current = await fetch_user(self.session, user_id)
        vault = await fetch_vault(self.session)
        if vault is None:
            raise InvalidRequest(_DAMAGED)
        canonical = await validate_vault_material(self.session, vault)
        if (
            current is None
            or not current.active
            or current.role == UserRole.service
            or user_key_material(current, factor_enabled) != observed
        ):
            return AuthResponse(valid=False)
        if not key.matches(canonical.key_check):
            raise InvalidRequest(_DAMAGED)
        if (
            self.database is not None
            and await self.session.get(UserDeviceUnlockPolicyModel, current.id)
            is not None
        ):
            database = self.database
            after_commit(
                self.session,
                lambda: asyncio.create_task(
                    _record_password_unlock(database, current.id)
                ),
            )
        await migrate_folder_links(self.session, key)
        await self._refresh_timeout()
        return self._open_session(current, key, factor_enabled)

    async def login_primary(
        self, password: str, factor_key: bytes | None = None
    ) -> AuthResponse:
        vault = await fetch_vault(self.session)
        if vault is None:
            raise NotFound("No master password found.")
        if vault.owner_user_id is None:
            return await self.bootstrap("admin", password)
        user = await fetch_user(self.session, vault.owner_user_id)
        if user is None:
            raise InvalidRequest(_DAMAGED)
        return await self.login(user.username, password, factor_key)

    async def login_extension(
        self, username: str, password: str, browser: str, client: str | None
    ) -> ExtensionSessionCreated | None:
        """Mint only a fill-scoped token; a factor account must use web handoff."""
        response = await self.login(username, password)
        if response.security_key_required:
            raise UseHandoff(
                "This account needs a security key. Unlock it in Nedra, then connect "
                "the extension."
            )
        if not response.valid or response.session_token is None:
            return None
        full_token = response.session_token
        key = self.vault_sessions.resolve(full_token)
        user_id = self.vault_sessions.user_id(full_token)
        fingerprint = self.vault_sessions.credential_fingerprint(full_token)
        token, handle = self.vault_sessions.open_extension(
            key, user_id, fingerprint, browser, client
        )
        self.vault_sessions.revoke(full_token, scope=Scope.FULL)
        after_rollback(self.session, lambda: self.vault_sessions.revoke(token))
        return ExtensionSessionCreated(
            session_token=token,
            id=handle,
            idle_timeout_ms=self.vault_sessions.idle_timeout_ms,
        )

    async def primary_user_id(self) -> int | None:
        vault = await fetch_vault(self.session)
        return vault.owner_user_id if vault is not None else None

    async def login_with_device(
        self, user_id: int, key: VaultKey, second_factor: bool
    ) -> AuthResponse:
        current = await fetch_user(self.session, user_id)
        vault = await fetch_vault(self.session)
        if (
            current is None
            or not current.active
            or current.role == UserRole.service
            or vault is None
            or second_factor != await hardware_factor_enabled(self.session, user_id)
        ):
            return AuthResponse(valid=False)
        canonical = await validate_vault_material(self.session, vault)
        if not key.matches(canonical.key_check):
            return AuthResponse(valid=False)
        await migrate_folder_links(self.session, key)
        await self._refresh_timeout()
        return self._open_session(current, key, second_factor)

    async def context(
        self,
        token: str,
        *,
        refresh: bool = True,
        allow_password_change: bool = False,
        scope: Scope = Scope.FULL,
    ) -> AuthContext:
        key = self.vault_sessions.resolve(token, refresh=refresh, scope=scope)
        user_id = self.vault_sessions.user_id(token, scope=scope)
        session_fingerprint = self.vault_sessions.credential_fingerprint(
            token, scope=scope
        )
        user = await fetch_user(self.session, user_id)
        factor_enabled = (
            bool(
                await self.session.scalar(
                    select(UserSecurityKeyModel.id)
                    .where(UserSecurityKeyModel.user_id == user_id)
                    .limit(1)
                )
            )
            if user is not None
            else False
        )
        vault = await fetch_vault(self.session)
        try:
            current_fingerprint = (
                credential_fingerprint(user, factor_enabled)
                if user is not None
                else None
            )
        except InvalidRequest:
            current_fingerprint = None
        if (
            user is None
            or not user.active
            or user.role == UserRole.service
            or vault is None
            or session_fingerprint != current_fingerprint
        ):
            self.vault_sessions.revoke(token)
            raise SessionRequired(_SESSION_ENDED)
        try:
            canonical = await validate_vault_material(self.session, vault)
        except InvalidRequest:
            self.vault_sessions.revoke(token)
            raise SessionRequired(_SESSION_ENDED) from None
        if not key.matches(canonical.key_check):
            self.vault_sessions.revoke(token)
            raise SessionRequired(_SESSION_ENDED)
        if user.must_change_password and not allow_password_change:
            raise Forbidden("Password change is required before accessing the vault.")
        return AuthContext(user=user, key=key, token=token)

    async def create_user(
        self,
        actor: AuthContext,
        *,
        username: str,
        role: UserRole,
        temporary_password: str | None,
        current_password: str | None,
        factor_key: bytes | None = None,
    ) -> UserCreateResponse:
        self.require_admin(actor)
        if role == UserRole.service:
            if current_password is None:
                raise InvalidRequest("Current administrator password is required.")
            await self.verify_current_password(actor, current_password, factor_key)
        if (
            await self.session.scalar(
                select(UserModel.id).where(UserModel.username == username)
            )
            is not None
        ):
            raise InvalidRequest("A user with that username already exists.")
        credential = secrets.token_urlsafe(32) if role == UserRole.service else None
        password = credential if credential is not None else temporary_password
        if password is None:
            raise InvalidRequest("A temporary password is required.")
        actor_id = actor.user.id
        key = actor.key
        await self.session.commit()
        material = await wrap_key_material(password, key)
        current_actor = await fetch_user(self.session, actor_id)
        vault = await fetch_vault(self.session)
        if (
            current_actor is None
            or not current_actor.active
            or current_actor.role != UserRole.admin
            or vault is None
            or not key.matches(vault.key_check)
        ):
            raise Forbidden("Administrator access is required.")
        if (
            await self.session.scalar(
                select(UserModel.id).where(UserModel.username == username)
            )
            is not None
        ):
            raise InvalidRequest("A user with that username already exists.")
        user = UserModel(
            username=username,
            role=role,
            active=True,
            must_change_password=role != UserRole.service,
            service_owner_id=actor_id if role == UserRole.service else None,
            service_token_hash=token_digest(credential) if credential else None,
            service_operations=(
                service_operation_mask(DEFAULT_SERVICE_OPERATIONS)
                if role == UserRole.service
                else 0
            ),
        )
        store_user_material(user, material)
        self.session.add(user)
        await self.session.flush()
        return UserCreateResponse(
            **self.to_user(user).model_dump(), service_token=credential
        )

    @staticmethod
    def require_admin(actor: AuthContext) -> None:
        if not actor.user.active or actor.user.role != UserRole.admin:
            raise Forbidden("Administrator access is required.")

    async def list_users(self, actor: AuthContext) -> list[AuthUser]:
        self.require_admin(actor)
        users = (
            await self.session.scalars(select(UserModel).order_by(UserModel.username))
        ).all()
        return [self.to_user(user) for user in users]

    async def _target(self, actor: AuthContext, user_id: int) -> UserModel:
        self.require_admin(actor)
        user = await fetch_user(self.session, user_id)
        if user is None:
            raise NotFound("User not found.")
        return user

    async def update_user(
        self,
        actor: AuthContext,
        user_id: int,
        *,
        role: UserRole | None,
        active: bool | None,
    ) -> AuthUser:
        user = await self._target(actor, user_id)
        current_role = UserRole(user.role)
        next_role = role or current_role
        if (current_role == UserRole.service) != (next_role == UserRole.service):
            raise Forbidden("Service user type cannot be changed.")
        removes_admin = (
            user.active
            and current_role == UserRole.admin
            and (active is False or next_role != UserRole.admin)
        )
        if removes_admin:
            others = await self.session.scalar(
                select(func.count())
                .select_from(UserModel)
                .where(
                    UserModel.id != user.id,
                    UserModel.active.is_(True),
                    UserModel.role == UserRole.admin,
                )
            )
            if not others:
                raise Forbidden("Cannot remove the last active administrator.")
        if role is not None:
            user.role = role
        if active is not None:
            user.active = active
        if role is not None or active is False:
            after_commit(
                self.session,
                lambda user_id=user.id: self.vault_sessions.revoke_user(user_id),
            )
        await self.session.flush()
        return self.to_user(user)

    async def revoke_user_sessions(self, actor: AuthContext, user_id: int) -> int:
        await self._target(actor, user_id)
        after_commit(self.session, lambda: self.vault_sessions.revoke_user(user_id))
        return sum(
            1
            for session_user_id in self.vault_sessions.user_ids()
            if session_user_id == user_id
        )

    async def require_password_change(
        self, actor: AuthContext, user_id: int
    ) -> AuthUser:
        user = await self._target(actor, user_id)
        if user.role == UserRole.service:
            raise Forbidden("Service users do not use interactive passwords.")
        user.must_change_password = True
        await self.session.flush()
        return self.to_user(user)

    async def update_service_operations(
        self,
        actor: AuthContext,
        user_id: int,
        operations: list[ServiceOperation],
        current_password: str,
        factor_key: bytes | None = None,
    ) -> AuthUser:
        self.require_admin(actor)
        await self.verify_current_password(actor, current_password, factor_key)
        target = await self._target(actor, user_id)
        if target.role != UserRole.service:
            raise Forbidden("Only service users have MCP operation permissions.")
        target.service_operations = service_operation_mask(operations)
        self.session.add(
            AccessAuditModel(
                actor_user_id=actor.user.id,
                action="service_operations_updated",
                resource_type="service",
                resource_id=target.id,
                target_user_id=target.id,
            )
        )
        await self.session.flush()
        return self.to_user(target)

    async def rotate_service_token(
        self,
        actor: AuthContext,
        user_id: int,
        current_password: str,
        factor_key: bytes | None = None,
    ) -> UserCreateResponse:
        self.require_admin(actor)
        await self.verify_current_password(actor, current_password, factor_key)
        target = await self._target(actor, user_id)
        if target.role != UserRole.service:
            raise Forbidden("Only service users have service tokens.")
        token = secrets.token_urlsafe(32)
        actor_id = actor.user.id
        key = actor.key
        await self.session.commit()
        material = await wrap_key_material(token, key)
        current_actor = await fetch_user(self.session, actor_id)
        current = await fetch_user(self.session, user_id)
        vault = await fetch_vault(self.session)
        if (
            current_actor is None
            or not current_actor.active
            or current_actor.role != UserRole.admin
            or current is None
            or current.role != UserRole.service
            or vault is None
            or not key.matches(vault.key_check)
        ):
            raise Forbidden("Administrator access is required.")
        store_user_material(current, material)
        current.service_token_hash = token_digest(token)
        await self.session.flush()
        return UserCreateResponse(
            **self.to_user(current).model_dump(), service_token=token
        )

    async def reset_password(
        self,
        actor: AuthContext,
        user_id: int,
        temporary_password: str,
        current_password: str,
        factor_key: bytes | None = None,
    ) -> AuthUser:
        await self.verify_current_password(actor, current_password, factor_key)
        target = await self._target(actor, user_id)
        if target.role == UserRole.service:
            raise Forbidden("Service users do not use interactive passwords.")
        actor_id = actor.user.id
        key = actor.key
        await self.session.commit()
        material = await wrap_key_material(temporary_password, key)
        current_actor = await fetch_user(self.session, actor_id)
        current = await fetch_user(self.session, user_id)
        vault = await fetch_vault(self.session)
        if (
            current_actor is None
            or not current_actor.active
            or current_actor.role != UserRole.admin
            or current is None
            or current.role == UserRole.service
            or vault is None
            or not key.matches(vault.key_check)
        ):
            raise Forbidden("Administrator access is required.")
        store_user_material(current, material)
        current.must_change_password = True
        await self.session.execute(
            delete(UserRecoveryModel).where(UserRecoveryModel.user_id == current.id)
        )
        removed_factors = await self.session.execute(
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
        if getattr(removed_factors, "rowcount", 0):
            self.session.add(
                AccessAuditModel(
                    actor_user_id=actor.user.id,
                    action="hardware_factor_reset",
                    resource_type="user",
                    resource_id=current.id,
                    target_user_id=current.id,
                )
            )
        if vault.owner_user_id == current.id:
            _store(vault, material)
        self.session.add(
            AccessAuditModel(
                actor_user_id=actor.user.id,
                action="user_password_reset",
                resource_type="user",
                resource_id=current.id,
                target_user_id=current.id,
            )
        )
        await self.session.flush()
        after_commit(self.session, lambda: self.vault_sessions.revoke_user(user_id))
        return self.to_user(current)

    async def recovery_status(self, context: AuthContext) -> RecoveryStatus:
        recovery = await self.session.get(UserRecoveryModel, context.user.id)
        return RecoveryStatus(
            configured=recovery is not None,
            created=recovery.created if recovery is not None else None,
        )

    async def create_recovery_code(
        self,
        context: AuthContext,
        current_password: str,
        factor_key: bytes | None = None,
    ) -> RecoveryCodeResult:
        if context.user.role == UserRole.service:
            raise Forbidden("Service users do not use recovery codes.")
        await self.verify_current_password(context, current_password, factor_key)
        code = recovery_code()
        material = await wrap_key_material(
            normalize_recovery_code(code) or "", context.key
        )
        user = await fetch_user(self.session, context.user.id)
        vault = await fetch_vault(self.session)
        if (
            user is None
            or not user.active
            or vault is None
            or not context.key.matches(
                (await validate_vault_material(self.session, vault)).key_check
            )
        ):
            raise SessionRequired(_SESSION_ENDED)
        recovery = await self.session.get(UserRecoveryModel, user.id)
        if recovery is None:
            recovery = UserRecoveryModel(user_id=user.id)
            self.session.add(recovery)
        store_recovery_material(recovery, material)
        self.session.add(
            AccessAuditModel(
                actor_user_id=user.id,
                action="recovery_code_created",
                resource_type="user",
                resource_id=user.id,
                target_user_id=user.id,
            )
        )
        await self.session.flush()
        return RecoveryCodeResult(
            configured=True, created=recovery.created, recovery_code=code
        )

    async def revoke_recovery_code(
        self,
        context: AuthContext,
        current_password: str,
        factor_key: bytes | None = None,
    ) -> RecoveryStatus:
        await self.verify_current_password(context, current_password, factor_key)
        recovery = await self.session.get(UserRecoveryModel, context.user.id)
        if recovery is not None:
            await self.session.delete(recovery)
            self.session.add(
                AccessAuditModel(
                    actor_user_id=context.user.id,
                    action="recovery_code_revoked",
                    resource_type="user",
                    resource_id=context.user.id,
                    target_user_id=context.user.id,
                )
            )
        return RecoveryStatus(configured=False)

    async def recover_password(
        self, username: str, supplied_code: str, new_password: str
    ) -> RecoveryAuthResponse:
        normalized = normalize_recovery_code(supplied_code)
        user = await self.session.scalar(
            select(UserModel).where(
                UserModel.username == username,
                UserModel.active.is_(True),
                UserModel.role != UserRole.service,
            )
        )
        recovery = (
            await self.session.get(UserRecoveryModel, user.id)
            if user is not None
            else None
        )
        if normalized is None or recovery is None or user is None:
            await self.session.commit()
            await create_key_material(supplied_code)
            return RecoveryAuthResponse(valid=False)
        observed = user_key_material(
            recovery
        )  # Recovery storage uses KeyMaterial fields.
        user_id = user.id
        await self.session.commit()
        key = await open_material(normalized, observed)
        if key is None:
            return RecoveryAuthResponse(valid=False)
        replacement = await wrap_key_material(new_password, key)
        next_code = recovery_code()
        next_material = await wrap_key_material(
            normalize_recovery_code(next_code) or "", key
        )
        current = await fetch_user(self.session, user_id)
        current_recovery = await self.session.get(UserRecoveryModel, user_id)
        vault = await fetch_vault(self.session)
        canonical = (
            await validate_vault_material(self.session, vault)
            if vault is not None
            else None
        )
        if (
            current is None
            or not current.active
            or current.role == UserRole.service
            or current_recovery is None
            or user_key_material(current_recovery) != observed
            or vault is None
            or canonical is None
            or not key.matches(canonical.key_check)
        ):
            return RecoveryAuthResponse(valid=False)
        store_user_material(current, replacement)
        current.must_change_password = False
        removed_factors = await self.session.execute(
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
        if getattr(removed_factors, "rowcount", 0):
            self.session.add(
                AccessAuditModel(
                    actor_user_id=current.id,
                    action="hardware_factor_recovered",
                    resource_type="user",
                    resource_id=current.id,
                    target_user_id=current.id,
                )
            )
        if vault.owner_user_id == current.id:
            _store(vault, replacement)
        store_recovery_material(current_recovery, next_material)
        self.session.add(
            AccessAuditModel(
                actor_user_id=current.id,
                action="recovery_code_used",
                resource_type="user",
                resource_id=current.id,
                target_user_id=current.id,
            )
        )
        await self._refresh_timeout()
        response = self._open_session(current, key)
        token = response.session_token
        assert token is not None
        after_commit(
            self.session,
            lambda: self.vault_sessions.revoke_user_except(user_id, token),
        )
        return RecoveryAuthResponse(**response.model_dump(), recovery_code=next_code)

    async def delete_user(self, actor: AuthContext, user_id: int) -> None:
        user = await self._target(actor, user_id)
        if user.id == actor.user.id:
            raise Forbidden("Administrators cannot delete their own account.")
        vault = await fetch_vault(self.session)
        if vault is not None and vault.owner_user_id == user.id:
            raise Forbidden("The primary vault owner cannot be deleted.")
        if (
            await self.session.scalar(
                select(EntryModel.id).where(EntryModel.owner_id == user.id).limit(1)
            )
            is not None
        ):
            raise Forbidden("User owns vault entries and cannot be deleted.")
        if (
            await self.session.scalar(
                select(FolderModel.id).where(FolderModel.owner_id == user.id).limit(1)
            )
            is not None
        ):
            raise Forbidden("User owns vault folders and cannot be deleted.")
        if (
            await self.session.scalar(
                select(UserModel.id)
                .where(UserModel.service_owner_id == user.id)
                .limit(1)
            )
            is not None
        ):
            raise Forbidden("User owns service accounts and cannot be deleted.")
        await self.session.execute(
            delete(EntryAccessModel).where(EntryAccessModel.user_id == user.id)
        )
        await self.session.delete(user)
        after_commit(self.session, lambda: self.vault_sessions.revoke_user(user_id))

    async def change_password(
        self,
        context: AuthContext,
        current_password: str,
        new_password: str,
        *,
        open_session: bool = True,
        factor_key: bytes | None = None,
    ) -> AuthResponse:
        if context.user.role == UserRole.service:
            raise Forbidden("Service users do not use interactive passwords.")
        factor_enabled = await hardware_factor_enabled(self.session, context.user.id)
        if factor_enabled and factor_key is None:
            raise Forbidden("Fresh hardware-factor confirmation is required.")
        observed = user_key_material(context.user, factor_enabled)
        user_id = context.user.id
        key = context.key
        await self.session.commit()
        opened = await open_material(current_password, observed, factor_key)
        if opened is None or not opened.matches(key.check):
            raise Forbidden("Current password is incorrect.")
        if new_password == current_password:
            raise InvalidRequest(
                "New password must be different from the current password."
            )
        replacement = await wrap_key_material(new_password, key, factor_key=factor_key)
        user = await fetch_user(self.session, user_id)
        vault = await fetch_vault(self.session)
        canonical = (
            await validate_vault_material(self.session, vault)
            if vault is not None
            else None
        )
        if (
            user is None
            or not user.active
            or user_key_material(user, factor_enabled) != observed
            or vault is None
            or canonical is None
            or not key.matches(canonical.key_check)
        ):
            raise SessionRequired(_SESSION_ENDED)
        store_user_material(user, replacement)
        user.must_change_password = False
        await self.session.execute(
            delete(UserDeviceUnlockModel).where(
                UserDeviceUnlockModel.user_id == user.id
            )
        )
        await self.session.execute(
            delete(UserDeviceUnlockPolicyModel).where(
                UserDeviceUnlockPolicyModel.user_id == user.id
            )
        )
        if vault.owner_user_id == user.id:
            _store(vault, replacement)
        await self._refresh_timeout()
        if not open_session:
            after_commit(self.session, lambda: self.vault_sessions.revoke_user(user_id))
            return AuthResponse(valid=True)
        response = self._open_session(user, key, factor_enabled)
        token = response.session_token
        assert token is not None
        after_commit(
            self.session,
            lambda: self.vault_sessions.revoke_user_except(user_id, token),
        )
        return response

    async def verify_current_password(
        self,
        context: AuthContext,
        current_password: str,
        factor_key: bytes | None = None,
    ) -> None:
        factor_enabled = await hardware_factor_enabled(self.session, context.user.id)
        if factor_enabled and factor_key is None:
            raise Forbidden("Fresh hardware-factor confirmation is required.")
        observed = user_key_material(context.user, factor_enabled)
        user_id = context.user.id
        key = context.key
        await self.session.commit()
        opened = await open_material(current_password, observed, factor_key)
        if opened is None or not opened.matches(key.check):
            raise Forbidden("Current password is incorrect.")
        user = await fetch_user(self.session, user_id)
        vault = await fetch_vault(self.session)
        canonical = (
            await validate_vault_material(self.session, vault)
            if vault is not None
            else None
        )
        if (
            user is None
            or not user.active
            or user_key_material(user, factor_enabled) != observed
            or vault is None
            or canonical is None
            or not key.matches(canonical.key_check)
        ):
            raise SessionRequired(_SESSION_ENDED)

    async def resolve_service_token(self, token: str) -> AuthContext:
        user = await self.session.scalar(
            select(UserModel).where(
                UserModel.service_token_hash == token_digest(token),
                UserModel.role == UserRole.service,
                UserModel.active.is_(True),
            )
        )
        if user is None:
            raise SessionRequired("Invalid service token.")
        material = user_key_material(user)
        user_id = user.id
        vault = await fetch_vault(self.session)
        if vault is None:
            raise SessionRequired("Invalid service token.")
        key_material(vault)
        await self.session.commit()
        key = await open_material(token, material)
        current = await fetch_user(self.session, user_id)
        vault = await fetch_vault(self.session)
        canonical = (
            await validate_vault_material(self.session, vault)
            if vault is not None
            else None
        )
        if (
            key is None
            or current is None
            or not current.active
            or current.role != UserRole.service
            or user_key_material(current) != material
            or vault is None
            or canonical is None
            or not key.matches(canonical.key_check)
        ):
            raise SessionRequired("Invalid service token.")
        return AuthContext(user=current, key=key)
