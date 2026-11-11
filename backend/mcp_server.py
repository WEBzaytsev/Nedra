from collections.abc import Awaitable, Callable
from typing import TypedDict, TypeVar, cast

from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from crud.access import AuthorizedPasswordCRUD, EntryACL
from crud.auth import AuthContext, AuthCRUD, token_digest
from crud.engine import Database
from crud.records import open_entry
from errors import Forbidden, SessionRequired
from models import AccessAuditModel, EntryModel, UserModel
from schemas import (
    CustomField,
    EntryPermission,
    Password,
    PasswordResponse,
    ServiceOperation,
    service_operations_from_mask,
)
from vault_sessions import VaultSessions

MCP_SCOPE = "vault"
Result = TypeVar("Result")


class EntryChanges(TypedDict, total=False):
    password_name: str
    kind: str
    username: str | None
    password_value: str
    url: str | None
    totp_secret: str | None
    description: str | None
    tags: list[str]
    custom_fields: list[CustomField]
    folder: str | None
    favorite: bool


class ServiceTokenVerifier:
    def __init__(self, database: Database) -> None:
        self.database = database

    async def verify_token(self, token: str) -> AccessToken | None:
        async with self.database.transaction(write=False) as session:
            user = await session.scalar(
                select(UserModel).where(
                    UserModel.service_token_hash == token_digest(token),
                    UserModel.role == "service",
                    UserModel.active.is_(True),
                )
            )
        if user is None:
            return None
        return AccessToken(
            token=token,
            client_id=f"ciphermoth-service-{user.id}",
            subject=str(user.id),
            scopes=[MCP_SCOPE],
            claims={},
        )


def _current_token() -> str:
    access_token = get_access_token()
    if access_token is None:
        raise SessionRequired("Authentication is required.")
    return access_token.token


def _index(
    entry: PasswordResponse, owner: str, access: EntryPermission
) -> dict[str, object]:
    return {
        "id": entry.id,
        "name": entry.password_name,
        "kind": entry.kind,
        "username": entry.username,
        "url": entry.url,
        "description": entry.description,
        "tags": entry.tags,
        "folder": entry.folder,
        "folder_id": entry.folder_id,
        "favorite": entry.favorite,
        "owner": owner,
        "access": access.value,
        "access_sources": [
            source.model_dump(mode="json") for source in entry.access_sources
        ],
    }


def _detail(
    entry: PasswordResponse, owner: str, access: EntryPermission
) -> dict[str, object]:
    return {
        **entry.model_dump(mode="json"),
        "owner_username": owner,
        "access": access.value,
    }


async def _by_id(
    crud: AuthorizedPasswordCRUD, entry_id: int, needed: EntryPermission
) -> tuple[PasswordResponse, str, EntryPermission]:
    access = await crud.acl.require(entry_id, needed)
    model = await crud.session.get(EntryModel, entry_id)
    if model is None:
        raise SessionRequired("Entry is no longer available.")
    document = open_entry(crud.context.key, model)
    count = (await crud._attachment_counts([entry_id])).get(entry_id, 0)
    owner = await crud.session.scalar(
        select(UserModel.username).where(UserModel.id == model.owner_id)
    )
    if owner is None:
        raise SessionRequired("Entry owner is missing.")
    response = crud.to_response(model, document, count).model_copy(
        update={"access_sources": await crud.acl.sources(entry_id)}
    )
    return response, owner, access


def build_mcp_server(
    database: Database, vault_sessions: VaultSessions
) -> MCPServer[None]:
    server = MCPServer(
        "ciphermoth",
        description="Access explicitly shared CipherMoth vault entries.",
    )

    async def service_call(
        operation: ServiceOperation,
        tool: str,
        callback: Callable[[AsyncSession, AuthContext], Awaitable[Result]],
    ) -> Result:
        denied = False
        result: Result | None = None
        async with database.transaction() as session:
            context = await AuthCRUD(session, vault_sessions).resolve_service_token(
                _current_token()
            )
            if operation not in service_operations_from_mask(
                context.user.service_operations
            ):
                denied = True
                session.add(
                    AccessAuditModel(
                        actor_user_id=context.user.id,
                        action=f"mcp_{tool}_denied",
                        resource_type="service",
                        resource_id=context.user.id,
                        target_user_id=context.user.service_owner_id,
                        permission=operation,
                    )
                )
            else:
                result = await callback(session, context)
                session.add(
                    AccessAuditModel(
                        actor_user_id=context.user.id,
                        action=f"mcp_{tool}",
                        resource_type="service",
                        resource_id=context.user.id,
                        target_user_id=context.user.service_owner_id,
                        permission=operation,
                    )
                )
        if denied:
            raise Forbidden(f"MCP operation '{operation}' is not enabled.")
        return cast(Result, result)

    @server.tool()
    async def list_entries() -> list[dict[str, object]]:
        """List metadata for entries explicitly shared with this service identity."""

        async def call(session, context):
            crud = AuthorizedPasswordCRUD(session, context)
            entries = await crud.get_passwords(context.key)
            access = {item.entry_id: item for item in await crud.acl.access_map()}
            return [
                _index(entry, access[entry.id].owner_username, access[entry.id].access)
                for entry in entries
            ]

        return await service_call(ServiceOperation.list, "list_entries", call)

    @server.tool()
    async def get_entry(entry_id: int) -> dict[str, object]:
        """Read one entry explicitly shared with this service identity."""

        async def call(session, context):
            entry, owner, access = await _by_id(
                AuthorizedPasswordCRUD(session, context), entry_id, EntryPermission.read
            )
            return _detail(entry, owner, access)

        return await service_call(ServiceOperation.get, "get_entry", call)

    @server.tool()
    async def create_entry(entry: Password) -> dict[str, object]:
        """Create an entry owned by this service identity's human owner."""

        async def call(session, context):
            crud = AuthorizedPasswordCRUD(session, context)
            await crud.create_password(entry, context.key)
            model = await session.scalar(
                select(EntryModel).where(
                    EntryModel.name_index
                    == context.key.name_index(entry.password_name),
                    EntryModel.deleted.is_(None),
                )
            )
            assert model is not None
            created, owner, access = await _by_id(crud, model.id, EntryPermission.write)
            return _detail(created, owner, access)

        return await service_call(ServiceOperation.create, "create_entry", call)

    @server.tool()
    async def update_entry(entry_id: int, changes: EntryChanges) -> dict[str, object]:
        """Update fields on one entry when this service identity has write access."""

        async def call(session, context):
            if not changes:
                raise ValueError("At least one field must be changed.")
            crud = AuthorizedPasswordCRUD(session, context)
            current, _, _ = await _by_id(crud, entry_id, EntryPermission.write)
            values = {field: getattr(current, field) for field in Password.model_fields}
            values.update(changes)
            updated = Password.model_validate(values)
            await crud.update_password(current.password_name, updated, context.key)
            result, owner, access = await _by_id(crud, entry_id, EntryPermission.write)
            return _detail(result, owner, access)

        return await service_call(ServiceOperation.update, "update_entry", call)

    @server.tool()
    async def delete_entry(entry_id: int) -> dict[str, object]:
        """Move one writable entry to Trash."""

        async def call(session, context):
            crud = AuthorizedPasswordCRUD(session, context)
            current, _, _ = await _by_id(crud, entry_id, EntryPermission.write)
            await crud.delete_password(current.password_name, context.key)
            return {"entry_id": entry_id, "moved_to_trash": True}

        return await service_call(ServiceOperation.delete, "delete_entry", call)

    @server.tool()
    async def relinquish_entry(entry_id: int) -> dict[str, object]:
        """Remove this service identity's access without deleting the entry."""

        async def call(session, context):
            remaining = await EntryACL(session, context).relinquish(entry_id)
            return {
                "entry_id": entry_id,
                "direct_access_relinquished": True,
                "effective_access": remaining.value if remaining else None,
            }

        return await service_call(ServiceOperation.relinquish, "relinquish_entry", call)

    return server
