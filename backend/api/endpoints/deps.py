from collections.abc import AsyncGenerator
from typing import Annotated
from urllib.parse import unquote

from fastapi import Depends, Header, Path, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api.path_guard import entry_name
from crud.access import AuthorizedAttachmentCRUD, AuthorizedPasswordCRUD, EntryACL
from crud.auth import AuthContext, AuthCRUD
from crud.backup import BackupCRUD
from crud.damage import DamageCRUD
from crud.device_unlock import DeviceUnlockCRUD
from crud.engine import Database
from crud.extension import ExtensionCRUD
from crud.master_password import MasterPasswordCRUD
from crud.security_factor import SecurityFactorCRUD
from crud.settings import SettingsCRUD
from crud.vault_access import SessionToken, VaultAccess
from errors import Forbidden, InvalidRequest, SessionRequired
from helpers import VaultKey
from vault_sessions import Scope, VaultSessions

SESSION_HEADER = "x-nedra-session"


async def get_database(request: Request) -> Database:
    return request.app.state.database


async def get_vault_sessions(request: Request) -> VaultSessions:
    return request.app.state.vault_sessions


VaultSessionsDep = Annotated[VaultSessions, Depends(get_vault_sessions)]


_READ_ONLY_METHODS = frozenset({"GET", "HEAD"})
_READ_ONLY_ROUTES = frozenset(
    {
        "master-password:unlock",
        "master-password:session-activity",
        "passwords:backup",
        "extension:unlock",
        "extension:handoff-start",
        "extension:handoff-approve",
        "extension:handoff-redeem",
        "extension:handoff-cancel",
        "extension:disconnect",
        "extension:matches",
        "extension:search",
        "extension:credential",
        "extension:totp",
        "extension:session-activity",
    }
)


async def get_session(
    request: Request, database: Annotated[Database, Depends(get_database)]
) -> AsyncGenerator[AsyncSession]:
    route = getattr(request.scope.get("route"), "name", None)
    write = request.method not in _READ_ONLY_METHODS and route not in _READ_ONLY_ROUTES
    async with database.transaction(write=write) as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session, scope="function")]


async def get_master_password_crud(session: SessionDep) -> MasterPasswordCRUD:
    return MasterPasswordCRUD(session)


async def get_auth_crud(
    session: SessionDep,
    vault_sessions: VaultSessionsDep,
    database: Annotated[Database, Depends(get_database)],
) -> AuthCRUD:
    return AuthCRUD(session, vault_sessions, database)


async def get_settings_crud(
    session: SessionDep, vault_sessions: VaultSessionsDep
) -> SettingsCRUD:
    return SettingsCRUD(session, vault_sessions)


async def get_security_factor_crud(
    request: Request, session: SessionDep, vault_sessions: VaultSessionsDep
) -> SecurityFactorCRUD:
    return SecurityFactorCRUD(
        session, request.app.state.security_challenges, vault_sessions
    )


async def get_device_unlock_crud(
    request: Request, session: SessionDep, vault_sessions: VaultSessionsDep
) -> DeviceUnlockCRUD:
    return DeviceUnlockCRUD(
        session, request.app.state.security_challenges, vault_sessions
    )


AuthCRUDDep = Annotated[AuthCRUD, Depends(get_auth_crud)]
SecurityFactorCRUDDep = Annotated[SecurityFactorCRUD, Depends(get_security_factor_crud)]
DeviceUnlockCRUDDep = Annotated[DeviceUnlockCRUD, Depends(get_device_unlock_crud)]


async def get_vault_access(
    session: SessionDep, vault_sessions: VaultSessionsDep
) -> VaultAccess:
    return VaultAccess(session, vault_sessions)


MasterPasswordCRUDDep = Annotated[MasterPasswordCRUD, Depends(get_master_password_crud)]
SettingsCRUDDep = Annotated[SettingsCRUD, Depends(get_settings_crud)]

VaultAccessDep = Annotated[VaultAccess, Depends(get_vault_access)]
SessionTokenHeader = Annotated[str | None, Header(alias=SESSION_HEADER)]


async def get_credential(
    vault_sessions: VaultSessionsDep, token: SessionTokenHeader = None
) -> SessionToken:
    if token is None:
        raise SessionRequired("The vault is locked. Unlock it first.")
    vault_sessions.resolve(token, refresh=False)
    return SessionToken(token)


CredentialDep = Annotated[SessionToken, Depends(get_credential)]


async def get_auth_context(crud: AuthCRUDDep, credential: CredentialDep) -> AuthContext:
    return await crud.context(credential.token)


async def get_password_change_context(
    crud: AuthCRUDDep, credential: CredentialDep
) -> AuthContext:
    return await crud.context(credential.token, allow_password_change=True)


async def get_auth_context_quietly(
    crud: AuthCRUDDep, credential: CredentialDep
) -> AuthContext:
    return await crud.context(credential.token, refresh=False)


async def get_extension_credential(
    vault_sessions: VaultSessionsDep, token: SessionTokenHeader = None
) -> SessionToken:
    if token is None:
        raise SessionRequired("The vault is locked. Unlock it first.")
    vault_sessions.resolve(token, refresh=False, scope=Scope.EXTENSION)
    return SessionToken(token)


async def get_extension_context(
    crud: AuthCRUDDep,
    credential: Annotated[SessionToken, Depends(get_extension_credential)],
) -> AuthContext:
    return await crud.context(credential.token, scope=Scope.EXTENSION)


AuthContextDep = Annotated[AuthContext, Depends(get_auth_context)]
PasswordChangeContextDep = Annotated[AuthContext, Depends(get_password_change_context)]
ExtensionCredentialDep = Annotated[SessionToken, Depends(get_extension_credential)]
ExtensionContextDep = Annotated[AuthContext, Depends(get_extension_context)]


async def get_damage_crud(
    session: SessionDep,
    context: Annotated[AuthContext, Depends(get_auth_context)],
) -> DamageCRUD:
    if context.user.role == "admin":
        return DamageCRUD(session)
    acl = EntryACL(session, context)
    entry_ids = [
        *await acl.visible_ids(deleted=False),
        *await acl.visible_ids(deleted=True),
    ]
    return DamageCRUD(session, entry_ids=entry_ids, owner_id=context.owner_id)


DamageCRUDDep = Annotated[DamageCRUD, Depends(get_damage_crud)]


async def get_backup_crud(
    session: SessionDep,
    vault_sessions: VaultSessionsDep,
    context: Annotated[AuthContext, Depends(get_auth_context)],
) -> BackupCRUD:
    acl = EntryACL(session, context)
    entry_ids = [
        *await acl.visible_ids(deleted=False),
        *await acl.visible_ids(deleted=True),
    ]
    return BackupCRUD(
        session,
        vault_sessions,
        owner_id=context.owner_id,
        entry_ids=entry_ids,
        restore_settings=context.user.role == "admin",
    )


BackupCRUDDep = Annotated[BackupCRUD, Depends(get_backup_crud)]


async def require_admin(context: AuthContextDep) -> AuthContext:
    if context.user.role != "admin":
        raise Forbidden("Administrator access is required.")
    return context


AdminContextDep = Annotated[AuthContext, Depends(require_admin)]


async def get_password_crud(
    session: SessionDep, context: AuthContextDep
) -> AuthorizedPasswordCRUD:
    return AuthorizedPasswordCRUD(session, context)


async def get_attachment_crud(
    session: SessionDep, context: AuthContextDep
) -> AuthorizedAttachmentCRUD:
    return AuthorizedAttachmentCRUD(session, context)


PasswordCRUDDep = Annotated[AuthorizedPasswordCRUD, Depends(get_password_crud)]
AttachmentCRUDDep = Annotated[AuthorizedAttachmentCRUD, Depends(get_attachment_crud)]


async def get_extension_crud(
    session: SessionDep, context: ExtensionContextDep
) -> ExtensionCRUD:
    return ExtensionCRUD(session, context)


ExtensionCRUDDep = Annotated[ExtensionCRUD, Depends(get_extension_crud)]


async def get_vault_key(context: AuthContextDep) -> VaultKey:
    return context.key


async def get_vault_key_quietly(
    context: Annotated[AuthContext, Depends(get_auth_context_quietly)],
) -> VaultKey:
    return context.key


VaultKeyDep = Annotated[VaultKey, Depends(get_vault_key)]


async def get_session_key(
    credential: CredentialDep, vault_sessions: VaultSessionsDep
) -> VaultKey:
    return vault_sessions.resolve(credential.token)


SessionKeyDep = Annotated[VaultKey, Depends(get_session_key)]
_PATH_CHANGED = (
    "The entry name in the request path was changed before it reached "
    "Nedra, so nothing was done. A reverse proxy in front of the API is "
    "probably decoding %2F; configure it to pass the request path unchanged."
)


async def get_entry_name(
    password_name: Annotated[str, Path()],
    x_nedra_entry: Annotated[str | None, Header(alias="x-nedra-entry")] = None,
) -> str:
    name = entry_name(password_name)
    if x_nedra_entry is not None and unquote(x_nedra_entry) != name:
        raise InvalidRequest(_PATH_CHANGED)
    return name


EntryName = Annotated[str, Depends(get_entry_name)]


async def require_master_password(
    crud: MasterPasswordCRUDDep, credential: CredentialDep
) -> None:
    if not await crud.is_initialized():
        raise Forbidden("No master password set.")
