from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import func, or_, select

from crud.records import (
    open_entry,
    open_folder,
    open_group,
    seal_entry,
    seal_folder,
    seal_group,
)
from errors import Forbidden, InvalidRequest, NotFound
from helpers import VaultKey
from models import (
    AccessAuditModel,
    EntryModel,
    FolderGroupAccessModel,
    FolderModel,
    FolderUserAccessModel,
    GroupMemberModel,
    GroupModel,
    UserModel,
    VaultModel,
    utc_now,
)
from schemas import (
    AuditEvent,
    EntryPermission,
    FolderAccessSource,
    FolderGrant,
    FolderResponse,
    GroupMember,
    GroupResponse,
    SharePermission,
    UserFolderAccess,
)

if TYPE_CHECKING:
    from crud.auth import AuthContext


def grant_active(expires_at: datetime | None) -> bool:
    if expires_at is None:
        return True
    if expires_at.tzinfo is not None:
        expires_at = expires_at.astimezone(UTC).replace(tzinfo=None)
    return expires_at > utc_now()


def _strongest(permissions: Sequence[str | SharePermission]) -> SharePermission | None:
    if SharePermission.write in permissions:
        return SharePermission.write
    if SharePermission.read in permissions:
        return SharePermission.read
    return None


async def migrate_folder_links(session, key: VaultKey) -> None:
    """Create stable folders for legacy encrypted folder strings after unlock.

    The schema migration only adds storage. This key-dependent step is one
    transaction and marks the singleton vault row only after every entry has
    been checked, so a failure cannot leave a completed-looking partial map.
    """
    vault = await session.get(VaultModel, 1)
    if vault is None or vault.folder_links_ready:
        return
    folders: dict[tuple[int, bytes], FolderModel] = {}
    existing = (await session.scalars(select(FolderModel))).all()
    for folder in existing:
        folders[(folder.owner_id, folder.name_index)] = folder

    entries = (await session.scalars(select(EntryModel).order_by(EntryModel.id))).all()
    for entry in entries:
        if entry.owner_id is None:
            raise InvalidRequest(
                "An entry has no owner, so folders cannot be migrated."
            )
        document = open_entry(key, entry)
        name = document.folder
        if not name:
            if entry.folder_id is not None:
                raise InvalidRequest("An entry without a folder has a folder link.")
            continue
        index = key.folder_name_index(entry.owner_id, name)
        folder = folders.get((entry.owner_id, index))
        if folder is None:
            folder = FolderModel(
                owner_id=entry.owner_id,
                name_index=index,
                document=b"",
            )
            seal_folder(key, folder, name)
            session.add(folder)
            await session.flush()
            folders[(entry.owner_id, index)] = folder
        elif open_folder(key, folder).name != name:
            raise InvalidRequest("Two folder names have the same integrity index.")
        if entry.folder_id not in (None, folder.id):
            raise InvalidRequest("An entry has a conflicting folder link.")
        entry.folder_id = folder.id
    vault.folder_links_ready = True
    await session.flush()


class FolderCRUD:
    def __init__(self, session, context: AuthContext) -> None:
        self.session = session
        self.context = context

    async def _folder(self, folder_id: int) -> FolderModel:
        folder = await self.session.get(FolderModel, folder_id)
        if folder is None:
            raise NotFound("Folder not found.")
        return folder

    async def _require_manage(self, folder_id: int) -> FolderModel:
        folder = await self._folder(folder_id)
        if (
            folder.owner_id != self.context.user.id
            and self.context.user.role != "admin"
        ):
            raise Forbidden(
                "Only the folder owner or an administrator can manage access."
            )
        return folder

    async def permission_for(
        self, folder: FolderModel, user_id: int | None = None
    ) -> EntryPermission | None:
        user_id = self.context.user.id if user_id is None else user_id
        if folder.owner_id == user_id:
            return EntryPermission.owner
        now = utc_now()
        permissions: list[str] = []
        direct = await self.session.scalar(
            select(FolderUserAccessModel.permission).where(
                FolderUserAccessModel.folder_id == folder.id,
                FolderUserAccessModel.user_id == user_id,
                or_(
                    FolderUserAccessModel.expires_at.is_(None),
                    FolderUserAccessModel.expires_at > now,
                ),
            )
        )
        if direct is not None:
            permissions.append(direct)
        permissions.extend(
            await self.session.scalars(
                select(FolderGroupAccessModel.permission)
                .join(
                    GroupMemberModel,
                    GroupMemberModel.group_id == FolderGroupAccessModel.group_id,
                )
                .where(
                    FolderGroupAccessModel.folder_id == folder.id,
                    GroupMemberModel.user_id == user_id,
                    or_(
                        FolderGroupAccessModel.expires_at.is_(None),
                        FolderGroupAccessModel.expires_at > now,
                    ),
                )
            )
        )
        permission = _strongest(permissions)
        return EntryPermission(permission) if permission is not None else None

    async def _response(self, folder: FolderModel, key: VaultKey) -> FolderResponse:
        owner = await self.session.get(UserModel, folder.owner_id)
        if owner is None:
            raise InvalidRequest("The folder owner record is missing.")
        permission = await self.permission_for(folder)
        return FolderResponse(
            id=folder.id,
            name=open_folder(key, folder).name,
            owner_id=owner.id,
            owner_username=owner.username,
            access=permission,
            can_manage=(
                owner.id == self.context.user.id or self.context.user.role == "admin"
            ),
        )

    async def list_folders(self, key: VaultKey) -> list[FolderResponse]:
        folders = (
            await self.session.scalars(select(FolderModel).order_by(FolderModel.id))
        ).all()
        if self.context.user.role != "admin":
            visible = []
            for folder in folders:
                if await self.permission_for(folder) is not None:
                    visible.append(folder)
            folders = visible
        responses = [await self._response(folder, key) for folder in folders]
        return sorted(responses, key=lambda item: (item.name.casefold(), item.id))

    async def create(self, name: str, key: VaultKey) -> FolderResponse:
        owner_id = self.context.owner_id
        name_index = key.folder_name_index(owner_id, name)
        duplicate = await self.session.scalar(
            select(FolderModel.id).where(
                FolderModel.owner_id == owner_id,
                FolderModel.name_index == name_index,
            )
        )
        if duplicate is not None:
            raise InvalidRequest("A folder with this name already exists.")
        folder = FolderModel(owner_id=owner_id, name_index=name_index, document=b"")
        seal_folder(key, folder, name)
        self.session.add(folder)
        await self.session.flush()
        self._audit("folder_created", folder.id)
        return await self._response(folder, key)

    async def rename(self, folder_id: int, name: str, key: VaultKey) -> FolderResponse:
        folder = await self._folder(folder_id)
        if folder.owner_id != self.context.user.id:
            raise Forbidden("Only the folder owner can rename it.")
        duplicate = await self.session.scalar(
            select(FolderModel.id).where(
                FolderModel.owner_id == folder.owner_id,
                FolderModel.name_index == key.folder_name_index(folder.owner_id, name),
                FolderModel.id != folder.id,
            )
        )
        if duplicate is not None:
            raise InvalidRequest("A folder with this name already exists.")
        entries = (
            await self.session.scalars(
                select(EntryModel).where(EntryModel.folder_id == folder.id)
            )
        ).all()
        seal_folder(key, folder, name)
        for entry in entries:
            document = open_entry(key, entry).model_copy(update={"folder": name})
            seal_entry(key, entry, document)
        self._audit("folder_renamed", folder.id)
        await self.session.flush()
        return await self._response(folder, key)

    async def remove(self, folder_id: int) -> None:
        folder = await self._folder(folder_id)
        if folder.owner_id != self.context.user.id:
            raise Forbidden("Only the folder owner can delete it.")
        entries = await self.session.scalar(
            select(func.count())
            .select_from(EntryModel)
            .where(EntryModel.folder_id == folder_id)
        )
        if entries:
            raise InvalidRequest(
                "Move all entries out of the folder before deleting it."
            )
        self._audit("folder_deleted", folder.id)
        await self.session.delete(folder)

    async def list_grants(self, folder_id: int) -> list[FolderGrant]:
        await self._require_manage(folder_id)
        user_rows = (
            await self.session.execute(
                select(
                    FolderUserAccessModel,
                    UserModel.username,
                )
                .join(UserModel, UserModel.id == FolderUserAccessModel.user_id)
                .where(FolderUserAccessModel.folder_id == folder_id)
            )
        ).all()
        group_rows = (
            await self.session.execute(
                select(FolderGroupAccessModel, GroupModel)
                .join(GroupModel, GroupModel.id == FolderGroupAccessModel.group_id)
                .where(FolderGroupAccessModel.folder_id == folder_id)
            )
        ).all()
        grants = [
            FolderGrant(
                target_type="user",
                target_id=grant.user_id,
                target_name=username,
                permission=grant.permission,
                expires_at=grant.expires_at,
                expired=not grant_active(grant.expires_at),
            )
            for grant, username in user_rows
        ]
        grants.extend(
            FolderGrant(
                target_type="group",
                target_id=grant.group_id,
                target_name=open_group(self.context.key, group).name,
                permission=grant.permission,
                expires_at=grant.expires_at,
                expired=not grant_active(grant.expires_at),
            )
            for grant, group in group_rows
        )
        return sorted(
            grants, key=lambda item: (item.target_type, item.target_name.casefold())
        )

    async def set_user_grant(
        self,
        folder_id: int,
        user_id: int,
        permission: SharePermission,
        expires_at: datetime | None,
    ) -> FolderGrant:
        folder = await self._require_manage(folder_id)
        user = await self.session.get(UserModel, user_id)
        if user is None or not user.active:
            raise NotFound("Share target not found.")
        if user.id == folder.owner_id:
            raise InvalidRequest("The owner already has full access.")
        grant = await self.session.get(FolderUserAccessModel, (folder_id, user_id))
        previous_permission = grant.permission if grant is not None else None
        previous_expires_at = grant.expires_at if grant is not None else None
        action = (
            "folder_user_grant_updated"
            if grant is not None
            else "folder_user_grant_created"
        )
        if grant is None:
            grant = FolderUserAccessModel(folder_id=folder_id, user_id=user_id)
            self.session.add(grant)
        grant.permission = permission
        grant.expires_at = expires_at
        grant.granted_by = self.context.user.id
        self._audit(
            action,
            folder_id,
            target_user_id=user_id,
            permission=permission,
            expires_at=expires_at,
            previous_permission=previous_permission,
            previous_expires_at=previous_expires_at,
        )
        await self.session.flush()
        return FolderGrant(
            target_type="user",
            target_id=user.id,
            target_name=user.username,
            permission=permission,
            expires_at=expires_at,
        )

    async def revoke_user_grant(self, folder_id: int, user_id: int) -> None:
        await self._require_manage(folder_id)
        grant = await self.session.get(FolderUserAccessModel, (folder_id, user_id))
        if grant is None:
            raise NotFound("Share not found.")
        self._audit(
            "folder_user_grant_revoked",
            folder_id,
            target_user_id=user_id,
            previous_permission=grant.permission,
            previous_expires_at=grant.expires_at,
        )
        await self.session.delete(grant)

    async def set_group_grant(
        self,
        folder_id: int,
        group_id: int,
        permission: SharePermission,
        expires_at: datetime | None,
    ) -> FolderGrant:
        await self._require_manage(folder_id)
        group = await self.session.get(GroupModel, group_id)
        if group is None:
            raise NotFound("Group not found.")
        grant = await self.session.get(FolderGroupAccessModel, (folder_id, group_id))
        previous_permission = grant.permission if grant is not None else None
        previous_expires_at = grant.expires_at if grant is not None else None
        action = (
            "folder_group_grant_updated"
            if grant is not None
            else "folder_group_grant_created"
        )
        if grant is None:
            grant = FolderGroupAccessModel(folder_id=folder_id, group_id=group_id)
            self.session.add(grant)
        grant.permission = permission
        grant.expires_at = expires_at
        grant.granted_by = self.context.user.id
        self._audit(
            action,
            folder_id,
            target_group_id=group_id,
            permission=permission,
            expires_at=expires_at,
            previous_permission=previous_permission,
            previous_expires_at=previous_expires_at,
        )
        await self.session.flush()
        return FolderGrant(
            target_type="group",
            target_id=group.id,
            target_name=open_group(self.context.key, group).name,
            permission=permission,
            expires_at=expires_at,
        )

    async def revoke_group_grant(self, folder_id: int, group_id: int) -> None:
        await self._require_manage(folder_id)
        grant = await self.session.get(FolderGroupAccessModel, (folder_id, group_id))
        if grant is None:
            raise NotFound("Share not found.")
        self._audit(
            "folder_group_grant_revoked",
            folder_id,
            target_group_id=group_id,
            previous_permission=grant.permission,
            previous_expires_at=grant.expires_at,
        )
        await self.session.delete(grant)

    async def user_access(self, user_id: int, key: VaultKey) -> list[UserFolderAccess]:
        if self.context.user.role != "admin":
            raise Forbidden("Administrator access is required.")
        user = await self.session.get(UserModel, user_id)
        if user is None:
            raise NotFound("User not found.")
        folders = (
            await self.session.scalars(select(FolderModel).order_by(FolderModel.id))
        ).all()
        output: list[UserFolderAccess] = []
        for folder in folders:
            folder_response = await self._response(folder, key)
            direct = await self.session.get(FolderUserAccessModel, (folder.id, user_id))
            sources: list[FolderAccessSource] = []
            if folder.owner_id == user_id:
                sources.append(
                    FolderAccessSource(
                        source="owner",
                        source_id=user_id,
                        name=user.username,
                        permission=SharePermission.write,
                    )
                )
            if direct is not None:
                sources.append(
                    FolderAccessSource(
                        source="direct",
                        source_id=user_id,
                        name=user.username,
                        permission=direct.permission,
                        expires_at=direct.expires_at,
                        expired=not grant_active(direct.expires_at),
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
                    name=open_group(key, group).name,
                    permission=grant.permission,
                    expires_at=grant.expires_at,
                    expired=not grant_active(grant.expires_at),
                )
                for grant, group in group_rows
            )
            active_permissions = [
                source.permission
                for source in sources
                if grant_active(source.expires_at)
            ]
            effective = (
                SharePermission.write
                if folder.owner_id == user_id
                else _strongest(active_permissions)
            )
            output.append(
                UserFolderAccess(
                    folder=folder_response,
                    direct_permission=direct.permission if direct is not None else None,
                    direct_expires_at=direct.expires_at if direct is not None else None,
                    effective_permission=effective,
                    sources=sources,
                )
            )
        return output

    async def audit(self, folder_id: int) -> list[AuditEvent]:
        await self._require_manage(folder_id)
        rows = (
            await self.session.scalars(
                select(AccessAuditModel)
                .where(
                    AccessAuditModel.resource_type == "folder",
                    AccessAuditModel.resource_id == folder_id,
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
            target_user = (
                await self.session.get(UserModel, row.target_user_id)
                if row.target_user_id
                else None
            )
            target_group = (
                await self.session.get(GroupModel, row.target_group_id)
                if row.target_group_id
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
                    target_username=target_user.username if target_user else None,
                    target_group_id=row.target_group_id,
                    target_group_name=open_group(self.context.key, target_group).name
                    if target_group
                    else None,
                    permission=row.permission,
                    expires_at=row.expires_at,
                    previous_permission=row.previous_permission,
                    previous_expires_at=row.previous_expires_at,
                )
            )
        return events

    def _audit(
        self,
        action: str,
        resource_id: int,
        *,
        target_user_id: int | None = None,
        target_group_id: int | None = None,
        permission: str | None = None,
        expires_at: datetime | None = None,
        previous_permission: str | None = None,
        previous_expires_at: datetime | None = None,
    ) -> None:
        self.session.add(
            AccessAuditModel(
                actor_user_id=self.context.user.id,
                action=action,
                resource_type="folder",
                resource_id=resource_id,
                target_user_id=target_user_id,
                target_group_id=target_group_id,
                permission=permission,
                expires_at=expires_at,
                previous_permission=previous_permission,
                previous_expires_at=previous_expires_at,
            )
        )


class GroupCRUD:
    def __init__(self, session, context: AuthContext) -> None:
        self.session = session
        self.context = context

    def _require_admin(self) -> None:
        if self.context.user.role != "admin":
            raise Forbidden("Administrator access is required.")

    async def _group(self, group_id: int) -> GroupModel:
        group = await self.session.get(GroupModel, group_id)
        if group is None:
            raise NotFound("Group not found.")
        return group

    async def _response(self, group: GroupModel, key: VaultKey) -> GroupResponse:
        count = await self.session.scalar(
            select(func.count())
            .select_from(GroupMemberModel)
            .where(GroupMemberModel.group_id == group.id)
        )
        return GroupResponse(
            id=group.id,
            name=open_group(key, group).name,
            member_count=count or 0,
        )

    async def list_groups(self, key: VaultKey) -> list[GroupResponse]:
        groups = (
            await self.session.scalars(select(GroupModel).order_by(GroupModel.id))
        ).all()
        responses = [await self._response(group, key) for group in groups]
        return sorted(responses, key=lambda item: (item.name.casefold(), item.id))

    async def create(self, name: str, key: VaultKey) -> GroupResponse:
        self._require_admin()
        if (
            await self.session.scalar(
                select(GroupModel.id).where(
                    GroupModel.name_index == key.group_name_index(name)
                )
            )
            is not None
        ):
            raise InvalidRequest("A group with this name already exists.")
        group = GroupModel(name_index=key.group_name_index(name), document=b"")
        seal_group(key, group, name)
        self.session.add(group)
        await self.session.flush()
        self._audit("group_created", group.id)
        return await self._response(group, key)

    async def rename(self, group_id: int, name: str, key: VaultKey) -> GroupResponse:
        self._require_admin()
        group = await self._group(group_id)
        duplicate = await self.session.scalar(
            select(GroupModel.id).where(
                GroupModel.name_index == key.group_name_index(name),
                GroupModel.id != group.id,
            )
        )
        if duplicate is not None:
            raise InvalidRequest("A group with this name already exists.")
        seal_group(key, group, name)
        self._audit("group_renamed", group.id)
        await self.session.flush()
        return await self._response(group, key)

    async def remove(self, group_id: int) -> None:
        self._require_admin()
        group = await self._group(group_id)
        grants = await self.session.scalar(
            select(func.count())
            .select_from(FolderGroupAccessModel)
            .where(FolderGroupAccessModel.group_id == group_id)
        )
        if grants:
            raise InvalidRequest(
                "Revoke this group's folder access before deleting the group."
            )
        self._audit("group_deleted", group.id)
        await self.session.delete(group)

    async def members(self, group_id: int) -> list[GroupMember]:
        self._require_admin()
        await self._group(group_id)
        rows = (
            await self.session.execute(
                select(UserModel)
                .join(GroupMemberModel, GroupMemberModel.user_id == UserModel.id)
                .where(GroupMemberModel.group_id == group_id)
                .order_by(UserModel.username)
            )
        ).scalars()
        return [
            GroupMember(user_id=user.id, username=user.username, role=user.role)
            for user in rows
        ]

    async def add_member(self, group_id: int, user_id: int) -> GroupMember:
        self._require_admin()
        await self._group(group_id)
        user = await self.session.get(UserModel, user_id)
        if user is None or not user.active:
            raise NotFound("User not found.")
        if await self.session.get(GroupMemberModel, (group_id, user_id)) is None:
            self.session.add(
                GroupMemberModel(
                    group_id=group_id,
                    user_id=user_id,
                    added_by=self.context.user.id,
                )
            )
            self._audit("group_member_added", group_id, target_user_id=user_id)
            await self.session.flush()
        return GroupMember(user_id=user.id, username=user.username, role=user.role)

    async def remove_member(self, group_id: int, user_id: int) -> None:
        self._require_admin()
        await self._group(group_id)
        membership = await self.session.get(GroupMemberModel, (group_id, user_id))
        if membership is None:
            raise NotFound("Group membership not found.")
        self._audit("group_member_removed", group_id, target_user_id=user_id)
        await self.session.delete(membership)

    async def audit(self, group_id: int) -> list[AuditEvent]:
        self._require_admin()
        await self._group(group_id)
        rows = (
            await self.session.scalars(
                select(AccessAuditModel)
                .where(
                    AccessAuditModel.resource_type == "group",
                    AccessAuditModel.resource_id == group_id,
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
                )
            )
        return events

    def _audit(
        self, action: str, resource_id: int, *, target_user_id: int | None = None
    ) -> None:
        self.session.add(
            AccessAuditModel(
                actor_user_id=self.context.user.id,
                action=action,
                resource_type="group",
                resource_id=resource_id,
                target_user_id=target_user_id,
            )
        )
