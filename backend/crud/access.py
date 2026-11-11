from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import exists, or_, select

from crud.attachment import AttachmentCRUD
from crud.auth import AuthContext
from crud.folder import FolderCRUD, grant_active
from crud.password import PasswordCRUD
from crud.records import find_entry, open_entry, open_folder, open_group, seal_entry
from errors import Forbidden, InvalidRequest, NotFound
from helpers import VaultKey
from models import (
    AccessAuditModel,
    EntryAccessModel,
    EntryModel,
    FolderGroupAccessModel,
    FolderModel,
    FolderUserAccessModel,
    GroupMemberModel,
    GroupModel,
    UserModel,
    utc_now,
)
from schemas import (
    ActiveTrashRef,
    AttachmentResponse,
    AuditEvent,
    BulkResult,
    BulkTrashResult,
    EntryAccess,
    EntryPermission,
    EntryRef,
    FolderAccessSource,
    MoveUndoRef,
    OnConflict,
    Password,
    PasswordCreate,
    PasswordDelete,
    PasswordImportResult,
    PasswordResponse,
    PasswordUpdate,
    ShareGrant,
    SharePermission,
    ShareTarget,
    TrashedEntryRef,
    TrashUndoRef,
)


class EntryACL:
    def __init__(self, session, context: AuthContext) -> None:
        self.session = session
        self.context = context

    async def permission(self, entry_id: int) -> EntryPermission:
        row = (
            await self.session.execute(
                select(EntryModel.owner_id, EntryModel.folder_id).where(
                    EntryModel.id == entry_id
                )
            )
        ).one_or_none()
        if row is None:
            raise NotFound("Password not found.")
        owner_id, folder_id = row
        user_id = self.context.user.id
        if owner_id == user_id:
            return EntryPermission.owner

        now = utc_now()
        permissions: list[str] = []
        direct = await self.session.scalar(
            select(EntryAccessModel.permission).where(
                EntryAccessModel.entry_id == entry_id,
                EntryAccessModel.user_id == user_id,
                or_(
                    EntryAccessModel.expires_at.is_(None),
                    EntryAccessModel.expires_at > now,
                ),
            )
        )
        if direct is not None:
            permissions.append(direct)

        if folder_id is not None:
            folder_owner = await self.session.scalar(
                select(FolderModel.owner_id).where(FolderModel.id == folder_id)
            )
            if folder_owner == user_id:
                return EntryPermission.owner
            folder_direct = await self.session.scalar(
                select(FolderUserAccessModel.permission).where(
                    FolderUserAccessModel.folder_id == folder_id,
                    FolderUserAccessModel.user_id == user_id,
                    or_(
                        FolderUserAccessModel.expires_at.is_(None),
                        FolderUserAccessModel.expires_at > now,
                    ),
                )
            )
            if folder_direct is not None:
                permissions.append(folder_direct)
            permissions.extend(
                await self.session.scalars(
                    select(FolderGroupAccessModel.permission)
                    .join(
                        GroupMemberModel,
                        GroupMemberModel.group_id == FolderGroupAccessModel.group_id,
                    )
                    .where(
                        FolderGroupAccessModel.folder_id == folder_id,
                        GroupMemberModel.user_id == user_id,
                        or_(
                            FolderGroupAccessModel.expires_at.is_(None),
                            FolderGroupAccessModel.expires_at > now,
                        ),
                    )
                )
            )

        if SharePermission.write in permissions:
            return EntryPermission.write
        if SharePermission.read in permissions:
            return EntryPermission.read
        raise NotFound("Password not found.")

    async def sources(self, entry_id: int) -> list[FolderAccessSource]:
        entry = await self.session.get(EntryModel, entry_id)
        if entry is None:
            raise NotFound("Password not found.")
        user_id = self.context.user.id
        if entry.owner_id == user_id:
            return [
                FolderAccessSource(
                    source="owner",
                    source_id=user_id,
                    permission=SharePermission.write,
                )
            ]
        sources: list[FolderAccessSource] = []
        direct = await self.session.get(EntryAccessModel, (entry_id, user_id))
        if direct is not None:
            sources.append(
                FolderAccessSource(
                    source="entry",
                    source_id=entry_id,
                    permission=direct.permission,
                    expires_at=direct.expires_at,
                    expired=not grant_active(direct.expires_at),
                )
            )
        if entry.folder_id is None:
            return sources
        folder = await self.session.get(FolderModel, entry.folder_id)
        if folder is None:
            return sources
        folder_name = open_folder(self.context.key, folder).name
        if folder.owner_id == user_id:
            sources.append(
                FolderAccessSource(
                    source="folder_owner",
                    source_id=folder.id,
                    name=folder_name,
                    permission=SharePermission.write,
                )
            )
        folder_direct = await self.session.get(
            FolderUserAccessModel, (folder.id, user_id)
        )
        if folder_direct is not None:
            sources.append(
                FolderAccessSource(
                    source="folder",
                    source_id=folder.id,
                    name=folder_name,
                    permission=folder_direct.permission,
                    expires_at=folder_direct.expires_at,
                    expired=not grant_active(folder_direct.expires_at),
                )
            )
        group_rows = (
            await self.session.execute(
                select(FolderGroupAccessModel, GroupModel)
                .join(
                    GroupMemberModel,
                    GroupMemberModel.group_id == FolderGroupAccessModel.group_id,
                )
                .join(GroupModel, GroupModel.id == FolderGroupAccessModel.group_id)
                .where(
                    FolderGroupAccessModel.folder_id == folder.id,
                    GroupMemberModel.user_id == user_id,
                )
            )
        ).all()
        sources.extend(
            FolderAccessSource(
                source="group",
                source_id=group.id,
                name=open_group(self.context.key, group).name,
                permission=grant.permission,
                expires_at=grant.expires_at,
                expired=not grant_active(grant.expires_at),
            )
            for grant, group in group_rows
        )
        return sources

    async def require(self, entry_id: int, needed: EntryPermission) -> EntryPermission:
        permission = await self.permission(entry_id)
        if needed == EntryPermission.owner and permission != EntryPermission.owner:
            raise Forbidden("Only the entry owner can perform this action.")
        if needed == EntryPermission.write and permission == EntryPermission.read:
            raise Forbidden("Write access is required.")
        return permission

    async def entry_by_name(
        self,
        name: str,
        key: VaultKey,
        needed: EntryPermission,
        *,
        deleted: bool = False,
        entry_id: int | None = None,
    ) -> EntryModel:
        model, _ = await find_entry(
            self.session, key, name, deleted=deleted, entry_id=entry_id
        )
        await self.require(model.id, needed)
        return model

    async def visible_ids(self, *, deleted: bool) -> list[int]:
        user_id = self.context.user.id
        now = utc_now()
        direct = exists(
            select(EntryAccessModel.entry_id).where(
                EntryAccessModel.entry_id == EntryModel.id,
                EntryAccessModel.user_id == user_id,
                or_(
                    EntryAccessModel.expires_at.is_(None),
                    EntryAccessModel.expires_at > now,
                ),
            )
        )
        folder_owned = exists(
            select(FolderModel.id).where(
                FolderModel.id == EntryModel.folder_id,
                FolderModel.owner_id == user_id,
            )
        )
        folder_direct = exists(
            select(FolderUserAccessModel.folder_id).where(
                FolderUserAccessModel.folder_id == EntryModel.folder_id,
                FolderUserAccessModel.user_id == user_id,
                or_(
                    FolderUserAccessModel.expires_at.is_(None),
                    FolderUserAccessModel.expires_at > now,
                ),
            )
        )
        folder_group = exists(
            select(FolderGroupAccessModel.folder_id)
            .join(
                GroupMemberModel,
                GroupMemberModel.group_id == FolderGroupAccessModel.group_id,
            )
            .where(
                FolderGroupAccessModel.folder_id == EntryModel.folder_id,
                GroupMemberModel.user_id == user_id,
                or_(
                    FolderGroupAccessModel.expires_at.is_(None),
                    FolderGroupAccessModel.expires_at > now,
                ),
            )
        )
        statement = (
            select(EntryModel.id)
            .where(
                EntryModel.deleted.is_not(None)
                if deleted
                else EntryModel.deleted.is_(None),
                or_(
                    EntryModel.owner_id == user_id,
                    direct,
                    folder_owned,
                    folder_direct,
                    folder_group,
                ),
            )
            .order_by(EntryModel.id)
        )
        return list(await self.session.scalars(statement))

    async def access_map(self, *, deleted: bool = False) -> list[EntryAccess]:
        ids = await self.visible_ids(deleted=deleted)
        if not ids:
            return []
        rows = (
            await self.session.execute(
                select(EntryModel.id, EntryModel.owner_id, UserModel.username)
                .join(UserModel, UserModel.id == EntryModel.owner_id)
                .where(EntryModel.id.in_(ids))
                .order_by(EntryModel.id)
            )
        ).all()
        return [
            EntryAccess(
                entry_id=entry_id,
                owner_id=owner_id,
                owner_username=owner_username,
                access=await self.permission(entry_id),
                sources=await self.sources(entry_id),
            )
            for entry_id, owner_id, owner_username in rows
        ]

    async def list_shares(self, entry_id: int) -> list[ShareGrant]:
        await self.require(entry_id, EntryPermission.owner)
        rows = (
            await self.session.execute(
                select(
                    UserModel.id,
                    UserModel.username,
                    UserModel.role,
                    EntryAccessModel.permission,
                    EntryAccessModel.expires_at,
                )
                .join(EntryAccessModel, EntryAccessModel.user_id == UserModel.id)
                .where(EntryAccessModel.entry_id == entry_id)
                .order_by(UserModel.username)
            )
        ).all()
        return [
            ShareGrant(
                user_id=user_id,
                username=username,
                role=role,
                permission=permission,
                expires_at=expires_at,
            )
            for user_id, username, role, permission, expires_at in rows
        ]

    async def set_share(
        self,
        entry_id: int,
        user_id: int,
        permission: SharePermission,
        expires_at: datetime | None = None,
    ) -> ShareGrant:
        await self.require(entry_id, EntryPermission.owner)
        entry = await self.session.get_one(EntryModel, entry_id)
        target = await self.session.get(UserModel, user_id)
        if target is None or not target.active:
            raise NotFound("Share target not found.")
        if target.id == entry.owner_id:
            raise InvalidRequest("The owner already has full access.")
        grant = await self.session.get(EntryAccessModel, (entry_id, user_id))
        previous_permission = grant.permission if grant is not None else None
        previous_expires_at = grant.expires_at if grant is not None else None
        action = "entry_grant_updated" if grant is not None else "entry_grant_created"
        if grant is None:
            grant = EntryAccessModel(
                entry_id=entry_id,
                user_id=user_id,
                granted_by=self.context.user.id,
                permission=permission,
                expires_at=expires_at,
            )
            self.session.add(grant)
        else:
            grant.permission = permission
            grant.expires_at = expires_at
            grant.granted_by = self.context.user.id
        self.session.add(
            AccessAuditModel(
                actor_user_id=self.context.user.id,
                action=action,
                resource_type="entry",
                resource_id=entry_id,
                target_user_id=user_id,
                permission=permission,
                expires_at=expires_at,
                previous_permission=previous_permission,
                previous_expires_at=previous_expires_at,
            )
        )
        await self.session.flush()
        return ShareGrant(
            user_id=target.id,
            username=target.username,
            role=target.role,
            permission=permission,
            expires_at=expires_at,
        )

    async def revoke_share(self, entry_id: int, user_id: int) -> None:
        await self.require(entry_id, EntryPermission.owner)
        grant = await self.session.get(EntryAccessModel, (entry_id, user_id))
        if grant is None:
            raise NotFound("Share not found.")
        self.session.add(
            AccessAuditModel(
                actor_user_id=self.context.user.id,
                action="entry_grant_revoked",
                resource_type="entry",
                resource_id=entry_id,
                target_user_id=user_id,
                previous_permission=grant.permission,
                previous_expires_at=grant.expires_at,
            )
        )
        await self.session.delete(grant)

    async def audit(self, entry_id: int) -> list[AuditEvent]:
        await self.require(entry_id, EntryPermission.owner)
        rows = (
            await self.session.scalars(
                select(AccessAuditModel)
                .where(
                    AccessAuditModel.resource_type == "entry",
                    AccessAuditModel.resource_id == entry_id,
                )
                .order_by(AccessAuditModel.id.desc())
                .limit(200)
            )
        ).all()
        events: list[AuditEvent] = []
        for row in rows:
            actor = (
                await self.session.get(UserModel, row.actor_user_id)
                if row.actor_user_id
                else None
            )
            target = (
                await self.session.get(UserModel, row.target_user_id)
                if row.target_user_id
                else None
            )
            events.append(
                AuditEvent(
                    id=row.id,
                    created=row.created,
                    actor_user_id=row.actor_user_id,
                    actor_username=actor.username if actor else None,
                    action=row.action,
                    resource_type=row.resource_type,
                    resource_id=row.resource_id,
                    target_user_id=row.target_user_id,
                    target_username=target.username if target else None,
                    permission=row.permission,
                    expires_at=row.expires_at,
                    previous_permission=row.previous_permission,
                    previous_expires_at=row.previous_expires_at,
                )
            )
        return events

    async def relinquish(self, entry_id: int) -> EntryPermission | None:
        permission = await self.permission(entry_id)
        if permission == EntryPermission.owner:
            raise Forbidden("The owner cannot relinquish their own entry.")
        grant = await self.session.get(
            EntryAccessModel, (entry_id, self.context.user.id)
        )
        if grant is None:
            raise InvalidRequest(
                "This access is inherited from a folder or group and cannot be "
                "relinquished from the entry."
            )
        self.session.add(
            AccessAuditModel(
                actor_user_id=self.context.user.id,
                action="entry_grant_relinquished",
                resource_type="entry",
                resource_id=entry_id,
                target_user_id=self.context.user.id,
                previous_permission=grant.permission,
                previous_expires_at=grant.expires_at,
            )
        )
        await self.session.delete(grant)
        await self.session.flush()
        try:
            return await self.permission(entry_id)
        except NotFound:
            return None

    async def share_targets(self) -> list[ShareTarget]:
        users = (
            await self.session.scalars(
                select(UserModel)
                .where(
                    UserModel.active.is_(True),
                    UserModel.id != self.context.user.id,
                )
                .order_by(UserModel.username)
            )
        ).all()
        return [
            ShareTarget(id=user.id, username=user.username, role=user.role)
            for user in users
        ]


class AuthorizedPasswordCRUD(PasswordCRUD):
    def __init__(self, session, context: AuthContext) -> None:
        super().__init__(session, context.owner_id)
        self.context = context
        self.acl = EntryACL(session, context)

    async def load_active(self) -> dict[bytes, EntryModel]:
        models = await self.session.scalars(
            select(EntryModel).where(
                EntryModel.deleted.is_(None),
                EntryModel.owner_id == self.context.owner_id,
            )
        )
        return {model.name_index: model for model in models}

    async def get_passwords(self, key: VaultKey) -> list[PasswordResponse]:
        listed = await self._listed(
            key, deleted=False, entry_ids=await self.acl.visible_ids(deleted=False)
        )
        return await self._with_access(listed, deleted=False)

    async def get_trash(self, key: VaultKey) -> list[PasswordResponse]:
        listed = await self._listed(
            key, deleted=True, entry_ids=await self.acl.visible_ids(deleted=True)
        )
        return await self._with_access(listed, deleted=True)

    async def _with_access(
        self, listed: list[PasswordResponse], *, deleted: bool
    ) -> list[PasswordResponse]:
        access = {
            item.entry_id: item for item in await self.acl.access_map(deleted=deleted)
        }
        return [
            response.model_copy(
                update={
                    "owner_id": access[response.id].owner_id,
                    "owner_username": access[response.id].owner_username,
                    "access": access[response.id].access,
                    "access_sources": access[response.id].sources,
                }
            )
            for response in listed
        ]

    async def get_password(self, password_name: str, key: VaultKey) -> PasswordResponse:
        model = await self.acl.entry_by_name(password_name, key, EntryPermission.read)
        response = await super().get_password(password_name, key)
        owner = await self.session.get_one(UserModel, model.owner_id)
        return response.model_copy(
            update={
                "owner_id": model.owner_id,
                "owner_username": owner.username,
                "access": await self.acl.permission(model.id),
                "access_sources": await self.acl.sources(model.id),
            }
        )

    async def create_password(
        self, password: Password, key: VaultKey
    ) -> PasswordCreate:
        folder = None
        if password.folder_id is not None:
            folder = await FolderCRUD(self.session, self.context)._folder(
                password.folder_id
            )
            permission = await FolderCRUD(self.session, self.context).permission_for(
                folder
            )
            if permission not in (EntryPermission.owner, EntryPermission.write):
                raise Forbidden("Write access to the folder is required.")
        result = await super().create_password(password, key)
        model, _ = await find_entry(self.session, key, password.password_name)
        # Entries in a shared folder belong to that folder's owner. This keeps
        # folder ownership and entry-owner-only operations aligned when a writer
        # adds a new item for the team.
        model.owner_id = (
            folder.owner_id if folder is not None else self.context.owner_id
        )
        if model.folder_id is not None:
            self.session.add(
                AccessAuditModel(
                    actor_user_id=self.context.user.id,
                    action="entry_added",
                    resource_type="folder",
                    resource_id=model.folder_id,
                )
            )
        if self.context.user.role == "service" and model.folder_id is None:
            self.session.add(
                EntryAccessModel(
                    entry_id=model.id,
                    user_id=self.context.user.id,
                    granted_by=self.context.owner_id,
                    permission=SharePermission.write,
                )
            )
        await self.session.flush()
        return result

    async def update_password(
        self, password_name: str, new_password: Password, key: VaultKey
    ) -> PasswordUpdate:
        model = await self.acl.entry_by_name(password_name, key, EntryPermission.write)
        current = open_entry(key, model)
        if (
            new_password.folder_id is None
            and model.folder_id is not None
            and new_password.folder == current.folder
        ):
            new_password = new_password.model_copy(
                update={"folder_id": model.folder_id}
            )
        previous_folder_id = model.folder_id
        if new_password.folder_id != previous_folder_id:
            await self.acl.require(model.id, EntryPermission.owner)
            if new_password.folder_id is not None:
                folder_crud = FolderCRUD(self.session, self.context)
                folder = await folder_crud._folder(new_password.folder_id)
                permission = await folder_crud.permission_for(folder)
                if permission not in (
                    EntryPermission.owner,
                    EntryPermission.write,
                ):
                    raise Forbidden("Write access to the folder is required.")
                if folder.owner_id != model.owner_id:
                    raise InvalidRequest(
                        "An entry can only be moved into a folder owned by its owner."
                    )
            if previous_folder_id is not None:
                self.session.add(
                    AccessAuditModel(
                        actor_user_id=self.context.user.id,
                        action="entry_removed",
                        resource_type="folder",
                        resource_id=previous_folder_id,
                    )
                )
            if new_password.folder_id is not None:
                self.session.add(
                    AccessAuditModel(
                        actor_user_id=self.context.user.id,
                        action="entry_added",
                        resource_type="folder",
                        resource_id=new_password.folder_id,
                    )
                )
        return await super().update_password(password_name, new_password, key)

    async def reuse_password_history(
        self, password_name: str, history_index: int, changed_at: str, key: VaultKey
    ) -> PasswordUpdate:
        await self.acl.entry_by_name(password_name, key, EntryPermission.write)
        return await super().reuse_password_history(
            password_name, history_index, changed_at, key
        )

    async def set_favorite(
        self, password_name: str, favorite: bool, key: VaultKey
    ) -> PasswordUpdate:
        await self.acl.entry_by_name(password_name, key, EntryPermission.write)
        return await super().set_favorite(password_name, favorite, key)

    async def delete_password(
        self, password_name: str, key: VaultKey
    ) -> PasswordDelete:
        await self.acl.entry_by_name(password_name, key, EntryPermission.write)
        return await super().delete_password(password_name, key)

    async def restore_password(
        self, password_name: str, key: VaultKey, *, entry_id: int | None = None
    ) -> PasswordUpdate:
        await self.acl.entry_by_name(
            password_name,
            key,
            EntryPermission.write,
            deleted=True,
            entry_id=entry_id,
        )
        return await super().restore_password(password_name, key, entry_id=entry_id)

    async def purge_password(
        self, password_name: str, key: VaultKey, *, entry_id: int | None = None
    ) -> PasswordDelete:
        await self.acl.entry_by_name(
            password_name,
            key,
            EntryPermission.owner,
            deleted=True,
            entry_id=entry_id,
        )
        return await super().purge_password(password_name, key, entry_id=entry_id)

    async def trash_passwords(
        self, targets: Sequence[ActiveTrashRef], key: VaultKey
    ) -> BulkTrashResult:
        for target in targets:
            await self.acl.entry_by_name(
                target.password_name,
                key,
                EntryPermission.write,
                entry_id=target.entry_id,
            )
        return await super().trash_passwords(targets, key)

    async def undo_trash_passwords(
        self, targets: Sequence[TrashUndoRef], key: VaultKey
    ) -> BulkResult:
        for target in targets:
            await self.acl.entry_by_name(
                target.password_name,
                key,
                EntryPermission.write,
                deleted=True,
                entry_id=target.entry_id,
            )
        return await super().undo_trash_passwords(targets, key)

    async def restore_passwords(
        self, targets: Sequence[TrashedEntryRef], key: VaultKey
    ) -> BulkResult:
        for target in targets:
            await self.acl.entry_by_name(
                target.password_name,
                key,
                EntryPermission.write,
                deleted=True,
                entry_id=target.entry_id,
            )
        return await super().restore_passwords(targets, key)

    async def purge_passwords(
        self, targets: Sequence[TrashedEntryRef], key: VaultKey
    ) -> BulkResult:
        for target in targets:
            await self.acl.entry_by_name(
                target.password_name,
                key,
                EntryPermission.owner,
                deleted=True,
                entry_id=target.entry_id,
            )
        return await super().purge_passwords(targets, key)

    async def move_passwords(
        self, targets: Sequence[EntryRef], folder_id: int | None, key: VaultKey
    ) -> BulkResult:
        return await self._move_passwords(
            [(target.entry_id, folder_id, None, False) for target in targets], key
        )

    async def undo_move_passwords(
        self, targets: Sequence[MoveUndoRef], key: VaultKey
    ) -> BulkResult:
        return await self._move_passwords(
            [
                (target.entry_id, target.folder_id, target.moved_to_folder_id, True)
                for target in targets
            ],
            key,
        )

    async def _move_passwords(
        self,
        targets: Sequence[tuple[int, int | None, int | None, bool]],
        key: VaultKey,
    ) -> BulkResult:
        """Validate every ACL and folder link before changing any entry."""
        folders = FolderCRUD(self.session, self.context)
        prepared: list[tuple[EntryModel, FolderModel | None, str | None]] = []
        for entry_id, folder_id, expected_folder_id, check_current_folder in targets:
            entry = await self.session.get(EntryModel, entry_id)
            if entry is None or entry.deleted is not None:
                raise NotFound("Password not found.")
            if check_current_folder and entry.folder_id != expected_folder_id:
                raise InvalidRequest("The entries changed since they were moved.")
            await self.acl.require(entry.id, EntryPermission.write)
            folder = None
            folder_name = None
            if folder_id is not None:
                folder = await folders._folder(folder_id)
                permission = await folders.permission_for(folder)
                if permission not in (EntryPermission.owner, EntryPermission.write):
                    raise Forbidden("Write access to the folder is required.")
                if folder.owner_id != entry.owner_id:
                    raise InvalidRequest(
                        "An entry can only be moved into a folder owned by its owner."
                    )
                folder_name = open_folder(key, folder).name
            document = open_entry(key, entry)
            prepared.append((entry, folder, folder_name))

        moved = 0
        for entry, folder, folder_name in prepared:
            folder_id = folder.id if folder is not None else None
            if entry.folder_id == folder_id:
                continue
            document = open_entry(key, entry).model_copy(update={"folder": folder_name})
            entry.folder_id = folder_id
            entry.backed_up = False
            seal_entry(key, entry, document)
            moved += 1
        await self.session.flush()
        return BulkResult(
            count=moved,
            detail=f"{moved} {'entry' if moved == 1 else 'entries'} moved.",
        )

    async def import_passwords_csv(
        self, file_bytes: bytes, key: VaultKey, on_conflict: OnConflict
    ) -> PasswordImportResult:
        return await super().import_passwords_csv(file_bytes, key, on_conflict)


class AuthorizedAttachmentCRUD(AttachmentCRUD):
    def __init__(self, session, context: AuthContext) -> None:
        super().__init__(session)
        self.acl = EntryACL(session, context)

    async def list_attachments(
        self, password_name: str, key: VaultKey
    ) -> list[AttachmentResponse]:
        await self.acl.entry_by_name(password_name, key, EntryPermission.read)
        return await super().list_attachments(password_name, key)

    async def add_attachment(
        self,
        password_name: str,
        filename: str,
        content_type: str | None,
        data: bytes,
        key: VaultKey,
    ) -> AttachmentResponse:
        await self.acl.entry_by_name(password_name, key, EntryPermission.write)
        return await super().add_attachment(
            password_name, filename, content_type, data, key
        )

    async def get_attachment_data(
        self, password_name: str, attachment_id: int, key: VaultKey
    ) -> tuple[str, str | None, bytes]:
        await self.acl.entry_by_name(password_name, key, EntryPermission.read)
        return await super().get_attachment_data(password_name, attachment_id, key)

    async def delete_attachment(
        self, password_name: str, attachment_id: int, key: VaultKey
    ) -> None:
        await self.acl.entry_by_name(password_name, key, EntryPermission.write)
        await super().delete_attachment(password_name, attachment_id, key)
