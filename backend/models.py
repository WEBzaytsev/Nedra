from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    TIMESTAMP,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    false,
    func,
    text,
    true,
)
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from helpers import new_uid


def utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class BaseModel(DeclarativeBase):
    pass


class RecordTimestamp(TypeDecorator[datetime]):
    """Keep corrupt SQLite values available to the record integrity checks.

    SQLite permits arbitrary values in a TIMESTAMP column. The dialect's
    ordinary decoder raises while fetching the whole result set, preventing
    even healthy rows from being listed or damaged rows from being removed.
    Preserve invalid values for the strict readers instead of guessing a time.
    The stored SQL type and the normal datetime writer remain unchanged.
    """

    impl = TIMESTAMP
    cache_ok = True

    def result_processor(self, dialect: Dialect, coltype: object):
        process = super().result_processor(dialect, coltype)

        def read(value: Any) -> Any:
            try:
                return process(value) if process is not None else value
            except (ValueError, TypeError):
                return value

        return read


class VaultModel(BaseModel):
    __tablename__ = "vault"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_vault_singleton"),
        CheckConstraint("length(kdf_salt) = 16", name="ck_vault_salt"),
        CheckConstraint("length(password_check) = 32", name="ck_vault_password_check"),
        CheckConstraint("length(key_check) = 32", name="ck_vault_key_check"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )
    updated: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        default=utc_now,
        onupdate=utc_now,
        server_default=func.current_timestamp(),
    )

    format_version: Mapped[int] = mapped_column(Integer)
    folder_links_ready: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    owner_user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    kdf: Mapped[str] = mapped_column(String)
    kdf_memory_kib: Mapped[int] = mapped_column(Integer)
    kdf_iterations: Mapped[int] = mapped_column(Integer)
    kdf_lanes: Mapped[int] = mapped_column(Integer)
    kdf_salt: Mapped[bytes] = mapped_column(LargeBinary)
    password_check: Mapped[bytes] = mapped_column(LargeBinary)
    wrapped_key: Mapped[bytes] = mapped_column(LargeBinary)
    key_check: Mapped[bytes] = mapped_column(LargeBinary)


class UserModel(BaseModel):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('admin', 'member', 'service')", name="ck_users_role"),
        CheckConstraint("length(kdf_salt) = 16", name="ck_users_salt"),
        CheckConstraint("length(password_check) = 32", name="ck_users_password_check"),
        CheckConstraint("length(key_check) = 32", name="ck_users_key_check"),
        CheckConstraint(
            "service_operations BETWEEN 0 AND 63", name="ck_users_service_operations"
        ),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )
    updated: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        default=utc_now,
        onupdate=utc_now,
        server_default=func.current_timestamp(),
    )
    username: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[str] = mapped_column(String(16))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    service_owner_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    service_token_hash: Mapped[bytes | None] = mapped_column(
        LargeBinary, unique=True, nullable=True
    )
    service_operations: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0")
    )
    kdf: Mapped[str] = mapped_column(String)
    kdf_memory_kib: Mapped[int] = mapped_column(Integer)
    kdf_iterations: Mapped[int] = mapped_column(Integer)
    kdf_lanes: Mapped[int] = mapped_column(Integer)
    kdf_salt: Mapped[bytes] = mapped_column(LargeBinary)
    password_check: Mapped[bytes] = mapped_column(LargeBinary)
    wrapped_key: Mapped[bytes] = mapped_column(LargeBinary)
    key_check: Mapped[bytes] = mapped_column(LargeBinary)


class UserRecoveryModel(BaseModel):
    __tablename__ = "user_recovery"
    __table_args__ = (
        CheckConstraint("length(kdf_salt) = 16", name="ck_user_recovery_salt"),
        CheckConstraint(
            "length(password_check) = 32", name="ck_user_recovery_password_check"
        ),
        CheckConstraint("length(key_check) = 32", name="ck_user_recovery_key_check"),
    )

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )
    kdf: Mapped[str] = mapped_column(String)
    kdf_memory_kib: Mapped[int] = mapped_column(Integer)
    kdf_iterations: Mapped[int] = mapped_column(Integer)
    kdf_lanes: Mapped[int] = mapped_column(Integer)
    kdf_salt: Mapped[bytes] = mapped_column(LargeBinary)
    password_check: Mapped[bytes] = mapped_column(LargeBinary)
    wrapped_key: Mapped[bytes] = mapped_column(LargeBinary)
    key_check: Mapped[bytes] = mapped_column(LargeBinary)


class EntryModel(BaseModel):
    __tablename__ = "entries"
    __table_args__ = (
        Index(
            "uq_entries_name_active",
            "name_index",
            unique=True,
            sqlite_where=text("deleted IS NULL"),
        ),
        CheckConstraint("length(uid) = 16", name="ck_entries_uid"),
        CheckConstraint("length(name_index) = 32", name="ck_entries_name_index"),
        {"sqlite_autoincrement": True},
    )

    def __init__(self, **fields: object) -> None:
        fields.setdefault("uid", new_uid())
        super().__init__(**fields)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    created: Mapped[datetime] = mapped_column(
        RecordTimestamp, default=utc_now, server_default=func.current_timestamp()
    )
    updated: Mapped[datetime] = mapped_column(
        RecordTimestamp,
        default=utc_now,
        onupdate=utc_now,
        server_default=func.current_timestamp(),
    )
    deleted: Mapped[datetime | None] = mapped_column(RecordTimestamp, default=None)

    owner_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    folder_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("folders.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )

    name_index: Mapped[bytes] = mapped_column(LargeBinary)
    document: Mapped[bytes] = mapped_column(LargeBinary)
    backed_up: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )


class EntryAccessModel(BaseModel):
    __tablename__ = "entry_access"
    __table_args__ = (
        CheckConstraint(
            "permission IN ('read', 'write')", name="ck_entry_access_permission"
        ),
    )

    entry_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("entries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    permission: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    granted_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )


class FolderModel(BaseModel):
    __tablename__ = "folders"
    __table_args__ = (
        UniqueConstraint("owner_id", "name_index", name="uq_folders_owner_name"),
        CheckConstraint("length(uid) = 16", name="ck_folders_uid"),
        CheckConstraint("length(name_index) = 32", name="ck_folders_name_index"),
        {"sqlite_autoincrement": True},
    )

    def __init__(self, **fields: object) -> None:
        fields.setdefault("uid", new_uid())
        super().__init__(**fields)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    owner_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    name_index: Mapped[bytes] = mapped_column(LargeBinary)
    document: Mapped[bytes] = mapped_column(LargeBinary)
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )
    updated: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        default=utc_now,
        onupdate=utc_now,
        server_default=func.current_timestamp(),
    )


class GroupModel(BaseModel):
    __tablename__ = "groups"
    __table_args__ = (
        CheckConstraint("length(uid) = 16", name="ck_groups_uid"),
        CheckConstraint("length(name_index) = 32", name="ck_groups_name_index"),
        {"sqlite_autoincrement": True},
    )

    def __init__(self, **fields: object) -> None:
        fields.setdefault("uid", new_uid())
        super().__init__(**fields)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    name_index: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    document: Mapped[bytes] = mapped_column(LargeBinary)
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )
    updated: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        default=utc_now,
        onupdate=utc_now,
        server_default=func.current_timestamp(),
    )


class GroupMemberModel(BaseModel):
    __tablename__ = "group_members"

    group_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("groups.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    added_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )


class FolderUserAccessModel(BaseModel):
    __tablename__ = "folder_user_access"
    __table_args__ = (
        CheckConstraint(
            "permission IN ('read', 'write')",
            name="ck_folder_user_access_permission",
        ),
    )

    folder_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("folders.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    permission: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    granted_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )


class FolderGroupAccessModel(BaseModel):
    __tablename__ = "folder_group_access"
    __table_args__ = (
        CheckConstraint(
            "permission IN ('read', 'write')",
            name="ck_folder_group_access_permission",
        ),
    )

    folder_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("folders.id", ondelete="CASCADE"),
        primary_key=True,
    )
    group_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("groups.id", ondelete="CASCADE"),
        primary_key=True,
    )
    permission: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    granted_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )


class AccessAuditModel(BaseModel):
    __tablename__ = "access_audit"
    __table_args__ = ({"sqlite_autoincrement": True},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp(), index=True
    )
    actor_user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(64))
    resource_type: Mapped[str] = mapped_column(String(32))
    resource_id: Mapped[int] = mapped_column(Integer, index=True)
    target_user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    target_group_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("groups.id", ondelete="SET NULL"), nullable=True
    )
    permission: Mapped[str | None] = mapped_column(String(16), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    previous_permission: Mapped[str | None] = mapped_column(String(16), nullable=True)
    previous_expires_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP, nullable=True
    )


class AttachmentModel(BaseModel):
    __tablename__ = "attachments"
    __table_args__ = (
        CheckConstraint("length(uid) = 16", name="ck_attachments_uid"),
        CheckConstraint("size_bytes > 0", name="ck_attachments_size"),
        {"sqlite_autoincrement": True},
    )

    def __init__(self, **fields: object) -> None:
        fields.setdefault("uid", new_uid())
        super().__init__(**fields)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uid: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    created: Mapped[datetime] = mapped_column(
        RecordTimestamp, default=utc_now, server_default=func.current_timestamp()
    )
    entry_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("entries.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    size_bytes: Mapped[int] = mapped_column(Integer)
    meta: Mapped[bytes] = mapped_column(LargeBinary)
    content: Mapped[bytes] = mapped_column(LargeBinary)


class SettingsModel(BaseModel):
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created: Mapped[datetime] = mapped_column(
        TIMESTAMP, default=utc_now, server_default=func.current_timestamp()
    )
    updated: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        default=utc_now,
        onupdate=utc_now,
        server_default=func.current_timestamp(),
    )

    inactivity_ms: Mapped[int] = mapped_column(Integer)
    warn_before_ms: Mapped[int] = mapped_column(Integer)
    hidden_ms: Mapped[int] = mapped_column(Integer)
    debounce_ms: Mapped[int] = mapped_column(Integer)
    clipboard_clear_ms: Mapped[int] = mapped_column(Integer)
    update_check_enabled: Mapped[bool] = mapped_column(Boolean)
