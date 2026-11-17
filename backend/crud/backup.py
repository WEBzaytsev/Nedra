import asyncio
import hashlib
import json
import tempfile
from collections.abc import Callable
from datetime import UTC, datetime
from typing import IO, Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backup_format import (
    MAX_ATTACHMENT_FRAME_BYTES,
    MAX_BACKUP_BYTES,
    MAX_ENTRY_FRAME_BYTES,
    MAX_FRAMES,
    MAX_MANIFEST_BYTES,
    BackupReader,
    BackupWriter,
)
from crud.attachment import (
    MAX_ATTACHMENTS_PER_ENTRY,
)
from crud.engine import after_rollback
from crud.master_password import MasterPasswordCRUD
from crud.password import (
    SOURCE_KEYS,
    Ignored,
    Imported,
    PasswordCRUD,
    document_from,
)
from crud.records import (
    AttachmentMetadata,
    EntryDocument,
    HistoryItem,
    history_timestamp,
    open_attachment_content,
    open_attachment_metadata,
    open_entry,
    open_folder,
    seal_attachment,
    seal_entry,
)
from crud.settings import SettingsCRUD
from errors import Forbidden, InvalidRequest, VaultDamaged
from helpers import (
    DEFAULT_KDF,
    BackupFormatError,
    BackupHeader,
    BackupKey,
    DecryptionFailed,
    VaultKey,
    backup_key_for,
    new_backup_key,
)
from models import (
    AttachmentModel,
    EntryModel,
    FolderModel,
)
from schemas import (
    OnConflict,
    PasswordImportResult,
    RestoredPassword,
    SettingsUpdate,
)
from settings import get_api_settings
from validators import require_unicode_text
from vault_sessions import VaultSessions

MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024
_SPOOL_BYTES = 16 * 1024 * 1024

_WRONG_PASSWORD = (
    "Incorrect backup password. Use the account password that created the backup."
)
_DAMAGED = "The backup file is damaged or incomplete. Nothing was imported."


async def _work[T](function: Callable[..., T], *args: object) -> T:
    """Offload bounded CPU/file work; cancellation waits for its file access to
    finish before the caller closes the ciphertext spool or releases its row.
    The worker never owns a database connection or transaction.
    """
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass
            except Exception:
                break
        if not task.cancelled():
            task.exception()
        raise


def _utc(value: datetime) -> datetime:
    """Naive UTC, as the vault stores times. A time whose offset pushes it out
    of the representable range is refused as invalid input."""
    if value.tzinfo is None:
        return value
    try:
        return value.astimezone(UTC).replace(tzinfo=None)
    except OverflowError:
        raise ValueError("is out of range once converted to UTC") from None


def _stamp(value: datetime) -> str:
    return value.replace(tzinfo=UTC).isoformat()


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)


class BackupAttachment(_Strict):
    filename: str
    content_type: str | None
    size: int = Field(ge=1, le=MAX_ATTACHMENT_FRAME_BYTES)
    sha256: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    created: datetime

    @field_validator("created")
    @classmethod
    def _in_utc(cls, value: datetime) -> datetime:
        return _utc(value)


class BackupHistoryItem(_Strict):
    value: str
    changed_at: str

    @field_validator("changed_at")
    @classmethod
    def _timestamp(cls, value: str) -> str:
        return history_timestamp(value)


class BackupField(_Strict):
    label: str
    value: str
    hidden: bool


class BackupFolder(_Strict):
    uid: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]
    name: str

    @field_validator("name")
    @classmethod
    def _unicode_name(cls, value: str) -> str:
        require_unicode_text(value)
        return value


class BackupEntry(_Strict):
    name: str
    kind: Literal["login", "note"]
    username: str | None
    value: str
    url: str | None
    totp_secret: str | None
    description: str | None
    tags: list[str]
    custom_fields: list[BackupField]
    folder: str | None
    folder_uid: Annotated[str | None, StringConstraints(pattern=r"^[0-9a-f]{32}$")] = (
        None
    )
    favorite: bool
    history: list[BackupHistoryItem]
    created: datetime
    updated: datetime
    deleted: datetime | None

    @field_validator("created", "updated", "deleted")
    @classmethod
    def _in_utc(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _utc(value)

    attachments: list[BackupAttachment] = Field(max_length=MAX_ATTACHMENTS_PER_ENTRY)

    @field_validator("tags")
    @classmethod
    def _unicode_tags(cls, value: list[str]) -> list[str]:
        require_unicode_text(value)
        return value


class BackupSettings(_Strict):
    inactivity_ms: int
    warn_before_ms: int
    hidden_ms: int
    debounce_ms: int
    clipboard_clear_ms: int
    update_check_enabled: bool


class BackupManifest(_Strict):
    format: Literal["nedra-backup"]
    version: Literal[3]
    exported_at: datetime

    @field_validator("exported_at")
    @classmethod
    def _in_utc(cls, value: datetime) -> datetime:
        return _utc(value)

    app_version: str
    settings: BackupSettings
    entries_count: int = Field(ge=0, le=MAX_FRAMES - 1)
    folders: list[BackupFolder] = Field(default_factory=list)


class BackupCRUD(PasswordCRUD):
    def __init__(
        self,
        session: AsyncSession,
        vault_sessions: VaultSessions,
        *,
        owner_id: int | None = None,
        entry_ids: list[int] | None = None,
        restore_settings: bool = True,
    ) -> None:
        super().__init__(session, owner_id)
        self.vault_sessions = vault_sessions
        self.master_password = MasterPasswordCRUD(session)
        self.entry_ids = entry_ids
        self.restore_settings = restore_settings

    async def _recheck_session(self, token: str | None) -> None:
        if token is None:
            return
        from crud.auth import AuthCRUD

        await AuthCRUD(self.session, self.vault_sessions).context(token, refresh=False)

    async def load_active(self) -> dict[bytes, EntryModel]:
        statement = select(EntryModel).where(EntryModel.deleted.is_(None))
        if self.owner_id is not None:
            statement = statement.where(EntryModel.owner_id == self.owner_id)
        models = await self.session.scalars(statement)
        return {model.name_index: model for model in models}

    async def _settings(self) -> BackupSettings:
        current = await SettingsCRUD(self.session, self.vault_sessions).get_settings()
        return BackupSettings(**current.model_dump())

    async def _attachments_of(
        self, key: VaultKey, entry: EntryModel
    ) -> list[tuple[int, BackupAttachment]]:
        ids = (
            await self.session.scalars(
                select(AttachmentModel.id)
                .where(AttachmentModel.entry_id == entry.id)
                .order_by(AttachmentModel.id)
            )
        ).all()
        described = []
        for attachment_id in ids:
            content, metadata, created = await self._attachment(
                key, entry, attachment_id
            )
            described.append(
                (
                    attachment_id,
                    BackupAttachment(
                        filename=metadata.filename,
                        content_type=metadata.content_type,
                        size=len(content),
                        sha256=await _work(
                            lambda data: hashlib.sha256(data).hexdigest(), content
                        ),
                        created=created,
                    ),
                )
            )
        return described

    async def _attachment(
        self, key: VaultKey, entry: EntryModel, attachment_id: int
    ) -> tuple[bytes, AttachmentMetadata, datetime]:
        attachment = await self.session.get_one(AttachmentModel, attachment_id)
        metadata, content = await _work(
            lambda: (
                open_attachment_metadata(key, attachment, entry.uid),
                open_attachment_content(key, attachment, entry.uid),
            )
        )
        created = attachment.created
        self.session.expunge(attachment)
        return content, metadata, created

    async def create_backup(
        self,
        master_password: str,
        key: VaultKey,
        *,
        verify_current: bool = True,
    ) -> IO[bytes]:
        """
        A complete backup of the vault (backup format 3) in a temporary file
        that holds only ciphertext. Both KDFs (checking the master password and
        deriving the backup key from a new salt) run before the read snapshot.
        Generation never writes to the vault or claims the client saved a file.
        """
        opened = (
            await self.master_password.check_master_password(master_password)
            if verify_current
            else None
        )
        salt, backup_key = await new_backup_key(master_password)
        if opened is not None:
            await self.master_password.confirm_same_key(opened, key)

        orphan = await self.session.scalar(
            select(AttachmentModel.id)
            .outerjoin(EntryModel, EntryModel.id == AttachmentModel.entry_id)
            .where(EntryModel.id.is_(None))
            .limit(1)
        )
        if orphan is not None:
            raise VaultDamaged(f"Attachment #{orphan} has no entry.")

        entry_ids = (
            list(
                await self.session.scalars(
                    select(EntryModel.id).order_by(EntryModel.id)
                )
            )
            if self.entry_ids is None
            else sorted(self.entry_ids)
        )
        folder_statement = select(FolderModel).order_by(FolderModel.id)
        if self.entry_ids is not None:
            linked_folder_ids = select(EntryModel.folder_id).where(
                EntryModel.id.in_(entry_ids),
                EntryModel.folder_id.is_not(None),
            )
            if self.owner_id is None:
                folder_statement = folder_statement.where(
                    FolderModel.id.in_(linked_folder_ids)
                )
            else:
                folder_statement = folder_statement.where(
                    or_(
                        FolderModel.owner_id == self.owner_id,
                        FolderModel.id.in_(linked_folder_ids),
                    )
                )
        folders = (await self.session.scalars(folder_statement)).all()
        backup_folders = [
            BackupFolder(uid=folder.uid.hex(), name=open_folder(key, folder).name)
            for folder in folders
        ]
        folder_uid_by_id = {folder.id: folder.uid.hex() for folder in folders}
        attachment_count_stmt = select(func.count()).select_from(AttachmentModel)
        if self.entry_ids is not None:
            attachment_count_stmt = attachment_count_stmt.where(
                AttachmentModel.entry_id.in_(entry_ids)
            )
        attachment_count = await self.session.scalar(attachment_count_stmt)
        frames_count = 1 + len(entry_ids) + int(attachment_count or 0)
        if frames_count > MAX_FRAMES:
            raise InvalidRequest("The vault has too many records for one backup.")
        manifest = {
            "format": "nedra-backup",
            "version": 3,
            "exported_at": _stamp(datetime.now(UTC).replace(tzinfo=None)),
            "app_version": get_api_settings().version,
            "settings": (await self._settings()).model_dump(),
            "entries_count": len(entry_ids),
            "folders": [folder.model_dump() for folder in backup_folders],
        }

        def encode() -> bytes:
            encoded = json.dumps(
                manifest, ensure_ascii=False, separators=(",", ":")
            ).encode()
            if len(encoded) > MAX_MANIFEST_BYTES:
                raise InvalidRequest("The backup settings frame is too large.")
            BackupManifest.model_validate_json(encoded, strict=True)
            return encoded

        encoded = await _work(encode)
        header = BackupHeader(
            params=DEFAULT_KDF,
            salt=salt,
            frames=frames_count,
            commitment=backup_key.commitment,
        )
        target = tempfile.SpooledTemporaryFile(max_size=_SPOOL_BYTES)
        after_rollback(self.session, target.close)
        try:
            writer = BackupWriter(target, backup_key, header)
            await _work(writer.write, encoded)
            for entry_id in entry_ids:
                entry = await self.session.get_one(EntryModel, entry_id)
                document = await _work(open_entry, key, entry)
                attachments = await self._attachments_of(key, entry)
                entry_manifest = {
                    **document.model_dump(),
                    "folder_uid": folder_uid_by_id.get(entry.folder_id),
                    "created": _stamp(entry.created),
                    "updated": _stamp(entry.updated),
                    "deleted": _stamp(entry.deleted) if entry.deleted else None,
                    "attachments": [
                        {
                            **described.model_dump(),
                            "created": _stamp(described.created),
                        }
                        for _, described in attachments
                    ],
                }
                encoded_entry = await _work(
                    lambda value: json.dumps(
                        value, ensure_ascii=False, separators=(",", ":")
                    ).encode(),
                    entry_manifest,
                )
                if len(encoded_entry) > MAX_ENTRY_FRAME_BYTES:
                    raise InvalidRequest(
                        f"Entry #{entry.id} exceeds the per-entry backup limit."
                    )
                await _work(writer.write, encoded_entry)
                for attachment_id, _ in attachments:
                    content, _, _ = await self._attachment(key, entry, attachment_id)
                    await _work(writer.write, content)
            writer.finish()
            if target.tell() > MAX_BACKUP_BYTES:
                raise InvalidRequest(
                    "The vault exceeds the 1 GiB complete-backup limit. "
                    "Nothing was written."
                )
            target.seek(0)
        except BaseException:
            target.close()
            raise

        return target

    async def import_backup(
        self,
        upload: IO[bytes],
        password: str,
        key: VaultKey,
        on_conflict: OnConflict,
        *,
        session_token: str | None = None,
    ) -> PasswordImportResult:
        """
        Restore a complete authenticated backup (format 3). Everything is checked
        before the import's single write transaction commits, so a wrong password, a
        damaged, truncated or inconsistent file changes nothing.
        """
        try:
            reader = BackupReader(upload)
        except BackupFormatError as error:
            raise InvalidRequest(str(error)) from None
        await self.session.commit()

        backup_key = await backup_key_for(password, reader.header)
        if not backup_key.matches(reader.header):
            raise Forbidden(_WRONG_PASSWORD)
        await self._recheck_session(session_token)
        try:
            manifest = await _work(
                lambda: BackupManifest.model_validate_json(
                    reader.read(backup_key, MAX_MANIFEST_BYTES), strict=True
                )
            )
        except (BackupFormatError, DecryptionFailed):
            raise InvalidRequest(_DAMAGED) from None
        except ValidationError as error:
            raise InvalidRequest(self._manifest_problem(error)) from None
        if reader.remaining < manifest.entries_count:
            raise InvalidRequest(_DAMAGED)
        try:
            await _work(SettingsUpdate.model_validate, manifest.settings.model_dump())
        except ValidationError:
            raise InvalidRequest(
                "Nothing was imported. The backup's settings are invalid."
            ) from None

        await self.master_password.verify_vault_key(key)
        try:
            return await self._restore(reader, backup_key, manifest, key, on_conflict)
        except (BackupFormatError, DecryptionFailed):
            raise InvalidRequest(_DAMAGED) from None

    @staticmethod
    def _manifest_problem(error: ValidationError) -> str:
        problem = error.errors()[0]
        location = problem["loc"]
        where = "the backup"
        if len(location) >= 2 and location[0] == "entries":
            where = f"entry {int(location[1]) + 1}"
        field = ".".join(str(part) for part in location[2:]) or "content"
        return f"Nothing was imported. {where} ({field}): {problem['msg']}."

    def _check_entry(
        self, entry: BackupEntry, index: int
    ) -> tuple[Imported, list[HistoryItem]]:
        restored, ignored = self.validate_import(
            [(f"entry {index}", self._restorable(entry))],
            label_for=lambda field: SOURCE_KEYS.get(field, field),
            schema=RestoredPassword,
        )
        if ignored:
            raise InvalidRequest(
                f"Nothing was imported. {ignored[0].where}: {ignored[0].reason}."
            )
        if sum(a.size for a in entry.attachments) > MAX_TOTAL_ATTACHMENT_BYTES:
            raise InvalidRequest(
                f"Nothing was imported. entry {index}: its attachments exceed "
                f"the 50 MB import limit."
            )
        _, password = restored[0]
        return password, [
            HistoryItem(value=item.value, changed_at=item.changed_at)
            for item in entry.history
        ]

    @staticmethod
    def _restorable(entry: BackupEntry) -> dict[str, object] | Ignored:
        if not entry.name:
            return Ignored(None, "no name")
        if not entry.value:
            return Ignored(entry.name, "no password or note text")
        return {
            "password_name": entry.name,
            "password_value": entry.value,
            "kind": entry.kind,
            "username": entry.username,
            "url": entry.url,
            "totp_secret": entry.totp_secret,
            "description": entry.description,
            "tags": entry.tags,
            "custom_fields": [field.model_dump() for field in entry.custom_fields],
            "folder": entry.folder,
            "favorite": entry.favorite,
        }

    async def _restore(
        self,
        reader: BackupReader,
        backup_key: BackupKey,
        manifest: BackupManifest,
        key: VaultKey,
        on_conflict: OnConflict,
    ) -> PasswordImportResult:
        folder_targets: dict[str, tuple[int, str]] = {}
        for described in manifest.folders:
            if described.uid in folder_targets:
                raise InvalidRequest("The backup contains a duplicate folder identity.")
            folder = await self._folder_named(described.name, key)
            assert folder is not None
            folder_targets[described.uid] = (folder.id, described.name)
        vault_was_empty = not await self.session.scalar(
            select(func.count()).select_from(EntryModel)
        )
        active_stmt = select(EntryModel.id, EntryModel.name_index).where(
            EntryModel.deleted.is_(None)
        )
        trashed_stmt = select(
            EntryModel.id, EntryModel.name_index, EntryModel.deleted
        ).where(EntryModel.deleted.is_not(None))
        active = {
            bytes(name_index): int(entry_id)
            for entry_id, name_index in (await self.session.execute(active_stmt)).all()
        }
        trashed = {
            (bytes(name_index), deleted): int(entry_id)
            for entry_id, name_index, deleted in (
                await self.session.execute(trashed_stmt)
            ).all()
            if deleted is not None
        }
        counts = {"imported": 0, "skipped": 0, "overwritten": 0, "trashed": 0}
        attachments = 0
        moved_at = datetime.now(UTC).replace(tzinfo=None)
        seen_active: dict[str, int] = {}
        for index in range(1, manifest.entries_count + 1):
            try:
                entry = await _work(
                    lambda: BackupEntry.model_validate_json(
                        reader.read(backup_key, MAX_ENTRY_FRAME_BYTES), strict=True
                    )
                )
            except (BackupFormatError, DecryptionFailed):
                raise
            except ValidationError as error:
                raise InvalidRequest(self._manifest_problem(error)) from None
            folder_id: int | None = None
            if entry.folder_uid is not None:
                target_folder = folder_targets.get(entry.folder_uid)
                if target_folder is None or target_folder[1] != entry.folder:
                    raise InvalidRequest(
                        "Nothing was imported. An entry has an invalid folder link."
                    )
                folder_id = target_folder[0]
            elif entry.folder is not None:
                raise InvalidRequest(
                    "Nothing was imported. An entry is missing its folder identity."
                )
            password, history = await _work(self._check_entry, entry, index)
            if entry.deleted is None:
                if entry.name in seen_active:
                    raise InvalidRequest(
                        f"Nothing was imported. entry {index} has the same name as "
                        f"entry {seen_active[entry.name]}; a vault cannot hold both."
                    )
                seen_active[entry.name] = index
            document = document_from(password, history)
            target = await self._restore_target(
                document,
                entry,
                active,
                trashed,
                key,
                on_conflict,
                moved_at,
                counts,
                folder_id=folder_id,
            )
            for described in entry.attachments:
                content = await _work(
                    reader.read, backup_key, MAX_ATTACHMENT_FRAME_BYTES
                )
                if (
                    len(content) != described.size
                    or hashlib.sha256(content).hexdigest() != described.sha256
                ):
                    raise InvalidRequest(_DAMAGED)
                if target is None:
                    continue
                attachment = AttachmentModel(
                    entry_id=target.id, created=described.created
                )
                await _work(
                    seal_attachment,
                    key,
                    attachment,
                    target.uid,
                    AttachmentMetadata(
                        filename=described.filename,
                        content_type=described.content_type,
                    ),
                    content,
                )
                self.session.add(attachment)
                await self.session.flush()
                self.session.expunge(attachment)
                attachments += 1
        reader.finish()

        settings_restored = vault_was_empty and self.restore_settings
        if settings_restored:
            await SettingsCRUD(self.session, self.vault_sessions).update_settings(
                SettingsUpdate(**manifest.settings.model_dump())
            )
        summary = self.result(
            {name: counts[name] for name in ("imported", "skipped", "overwritten")},
            [],
            [],
        )
        return summary.model_copy(
            update={
                "total": manifest.entries_count,
                "trashed": counts["trashed"],
                "attachments": attachments,
                "settings_restored": settings_restored,
            }
        )

    async def _restore_target(
        self,
        document: EntryDocument,
        entry: BackupEntry,
        active: dict[bytes, int],
        trashed: dict[tuple[bytes, datetime], int],
        key: VaultKey,
        on_conflict: OnConflict,
        moved_at: datetime,
        counts: dict[str, int],
        *,
        folder_id: int | None = None,
    ) -> EntryModel | None:
        index = key.name_index(document.name)
        deleted = entry.deleted
        if deleted is not None:
            trashed_id = trashed.get((index, deleted))
            if trashed_id is not None:
                trashed_entry = await self.session.get_one(EntryModel, trashed_id)
                open_entry(key, trashed_entry)
                if self.owner_id is None or trashed_entry.owner_id == self.owner_id:
                    counts["skipped"] += 1
                    return None
            counts["trashed"] += 1
        else:
            existing_id = active.get(index)
            if existing_id is not None:
                existing = await self.session.get_one(EntryModel, existing_id)
                open_entry(key, existing)
                if on_conflict == OnConflict.skip:
                    counts["skipped"] += 1
                    return None
                if self.owner_id is not None and existing.owner_id != self.owner_id:
                    raise Forbidden(
                        "An entry with this name belongs to another account and "
                        "cannot be overwritten. Import with conflict handling set "
                        "to skip, or rename the entry first."
                    )
                existing.deleted = moved_at
                await self.session.flush()
                counts["overwritten"] += 1
            else:
                counts["imported"] += 1
        model = EntryModel(
            owner_id=self.owner_id,
            folder_id=folder_id,
            created=entry.created,
            updated=entry.updated,
            deleted=deleted,
            backed_up=True,
        )
        seal_entry(key, model, document)
        self.session.add(model)
        await self.session.flush()
        if deleted is None:
            active[index] = model.id
        else:
            trashed[index, deleted] = model.id
        return model
