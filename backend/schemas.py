from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from validators import (
    addressable_name,
    normalize_totp_secret,
    normalize_totp_secret_leniently,
    reject_nul,
    require_unicode_text,
    validate_master_password_strength,
)

_MAX_TAGS = 20
_MAX_TAG_LENGTH = 40
_MAX_CUSTOM_FIELDS = 30
_MAX_FIELD_LABEL = 100
_MAX_FIELD_VALUE = 4096
_MAX_FOLDER_LENGTH = 200
_MAX_DESCRIPTION_LENGTH = 10_000

Username = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=2,
        max_length=64,
        pattern=r"^[a-z0-9][a-z0-9._@-]*$",
    ),
    BeforeValidator(lambda value: value.lower() if isinstance(value, str) else value),
]


class SimpleDetailSchema(BaseModel):
    detail: str


class MetaResponse(BaseModel):
    version: str
    features: list[str] = Field(default_factory=list)


class UserRole(StrEnum):
    admin = "admin"
    member = "member"
    service = "service"


class SharePermission(StrEnum):
    read = "read"
    write = "write"


class EntryPermission(StrEnum):
    owner = "owner"
    read = "read"
    write = "write"


class AccessRelinquishResponse(SimpleDetailSchema):
    direct_access_relinquished: bool
    effective_access: EntryPermission | None = None


class AuthUser(BaseModel):
    id: int
    username: str
    role: UserRole
    active: bool
    must_change_password: bool


class AuthStatus(BaseModel):
    initialized: bool


class AuthPayload(BaseModel):
    username: Username
    password: str = Field(min_length=1, max_length=1024)

    @field_validator("password")
    @classmethod
    def _unicode_password(cls, value: str) -> str:
        require_unicode_text(value)
        return value


class AuthBootstrapPayload(AuthPayload):
    @field_validator("password")
    @classmethod
    def _strong(cls, value: str) -> str:
        return validate_master_password_strength(value)


class AuthResponse(BaseModel):
    valid: bool
    user: AuthUser | None = None
    session_token: str | None = None
    idle_timeout_ms: int | None = None


class EntryDraftKey(BaseModel):
    user_id: int
    key: str = Field(repr=False)


class UserCreatePayload(BaseModel):
    username: Username
    role: UserRole = UserRole.member
    temporary_password: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def _human_password_required(self) -> "UserCreatePayload":
        if self.role != UserRole.service:
            if self.temporary_password is None:
                raise ValueError("A temporary password is required for a human user.")
            validate_master_password_strength(self.temporary_password)
        elif self.temporary_password is not None:
            raise ValueError("Service users do not use interactive passwords.")
        return self


class UserCreateResponse(AuthUser):
    service_token: str | None = None


class UserUpdatePayload(BaseModel):
    role: UserRole | None = None
    active: bool | None = None


class UserPasswordResetPayload(BaseModel):
    temporary_password: str = Field(min_length=1, max_length=1024)

    @field_validator("temporary_password")
    @classmethod
    def _strong(cls, value: str) -> str:
        return validate_master_password_strength(value)


class PasswordChangePayload(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)

    @field_validator("new_password")
    @classmethod
    def _strong(cls, value: str) -> str:
        return validate_master_password_strength(value)


class ShareTarget(BaseModel):
    id: int
    username: str
    role: UserRole


class ShareUpdatePayload(BaseModel):
    permission: SharePermission
    expires_at: datetime | None = None

    @field_validator("expires_at")
    @classmethod
    def _future_utc(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("expires_at must include a timezone")
        utc = value.astimezone(UTC)
        if utc <= datetime.now(UTC):
            raise ValueError("expires_at must be in the future")
        return utc.replace(tzinfo=None)


class ShareGrant(BaseModel):
    user_id: int
    username: str
    role: UserRole
    permission: SharePermission
    expires_at: datetime | None = None


class FolderCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=_MAX_FOLDER_LENGTH)

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("name")
    @classmethod
    def _valid_name(cls, value: str) -> str:
        require_unicode_text(value)
        cleaned = reject_nul(value)
        assert cleaned is not None
        return cleaned


class FolderUpdatePayload(FolderCreatePayload):
    pass


class FolderAccessSource(BaseModel):
    source: Literal["owner", "direct", "entry", "folder_owner", "folder", "group"]
    source_id: int
    name: str | None = None
    permission: SharePermission
    expires_at: datetime | None = None
    expired: bool = False


class FolderResponse(BaseModel):
    id: int
    name: str
    owner_id: int
    owner_username: str
    access: EntryPermission | None = None
    can_manage: bool


class FolderGrant(BaseModel):
    target_type: Literal["user", "group"]
    target_id: int
    target_name: str
    permission: SharePermission
    expires_at: datetime | None = None
    expired: bool = False


class UserFolderAccess(BaseModel):
    folder: FolderResponse
    direct_permission: SharePermission | None = None
    direct_expires_at: datetime | None = None
    effective_permission: SharePermission | None = None
    sources: list[FolderAccessSource] = Field(default_factory=list)


class GroupCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=100)

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("name")
    @classmethod
    def _valid_name(cls, value: str) -> str:
        require_unicode_text(value)
        cleaned = reject_nul(value)
        assert cleaned is not None
        return cleaned


class GroupUpdatePayload(GroupCreatePayload):
    pass


class GroupResponse(BaseModel):
    id: int
    name: str
    member_count: int


class GroupMember(BaseModel):
    user_id: int
    username: str
    role: UserRole


class AuditEvent(BaseModel):
    id: int
    created: datetime
    actor_user_id: int | None = None
    actor_username: str | None = None
    action: str
    resource_type: str
    resource_id: int
    target_user_id: int | None = None
    target_username: str | None = None
    target_group_id: int | None = None
    target_group_name: str | None = None
    permission: SharePermission | None = None
    expires_at: datetime | None = None
    previous_permission: SharePermission | None = None
    previous_expires_at: datetime | None = None


class EntryAccess(BaseModel):
    entry_id: int
    owner_id: int
    owner_username: str
    access: EntryPermission
    sources: list[FolderAccessSource] = Field(default_factory=list)


class MasterPassword(BaseModel):
    master_password: str = Field(min_length=1, max_length=1024)

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)


class MasterPasswordCreatePayload(MasterPassword):
    @field_validator("master_password")
    @classmethod
    def _strong(cls, value: str) -> str:
        return validate_master_password_strength(value)


class VaultUnlock(BaseModel):
    valid: bool
    session_token: str | None = None
    idle_timeout_ms: int | None = None


class MasterPasswordCreate(BaseModel):
    created: bool
    detail: str
    session_token: str
    idle_timeout_ms: int


class VaultSessionStatus(BaseModel):
    idle_timeout_ms: int
    expires_in_ms: int


class VaultLock(BaseModel):
    locked: bool


class MasterPasswordUpdate(BaseModel):
    updated: bool
    detail: str


class MasterPasswordUpdatePayload(BaseModel):
    master_password: str = Field(min_length=1, max_length=1024)
    new_master_password: str = Field(min_length=1, max_length=1024)

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)

    @field_validator("new_master_password")
    @classmethod
    def _strong(cls, value: str) -> str:
        return validate_master_password_strength(value)


class MasterPasswordStatus(BaseModel):
    initialized: bool


class CustomField(BaseModel):
    label: str = Field(default="", max_length=_MAX_FIELD_LABEL)
    value: str = Field(default="", max_length=_MAX_FIELD_VALUE)
    hidden: bool = False

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)


class Password(BaseModel):
    password_name: str = Field(min_length=1, max_length=255)
    kind: str = Field(default="login")
    username: str | None = Field(default=None, max_length=255)
    password_value: Annotated[
        str, StringConstraints(strip_whitespace=False, min_length=1)
    ]
    url: str | None = Field(default=None, max_length=2048)
    totp_secret: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=_MAX_DESCRIPTION_LENGTH)
    tags: list[str] = Field(default_factory=list, max_length=_MAX_TAGS)
    custom_fields: list[CustomField] = Field(
        default_factory=list, max_length=_MAX_CUSTOM_FIELDS
    )
    folder: str | None = Field(default=None, max_length=_MAX_FOLDER_LENGTH)
    folder_id: int | None = Field(default=None, gt=0)
    favorite: bool = False

    model_config = ConfigDict(str_strip_whitespace=True)

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)

    @field_validator("password_name", "username", "description")
    @classmethod
    def _storable_as_text(cls, value: str | None) -> str | None:
        return reject_nul(value)

    @field_validator("password_name")
    @classmethod
    def _addressable(cls, value: str | None) -> str | None:
        return addressable_name(value)

    @field_validator("totp_secret")
    @classmethod
    def _normalize_totp(cls, value: str | None) -> str | None:
        return normalize_totp_secret(value)

    @field_validator("folder")
    @classmethod
    def _clean_folder(cls, value: str | None) -> str | None:
        return value or None

    @field_validator("kind")
    @classmethod
    def _clean_kind(cls, value: str) -> str:
        return value if value in ("login", "note") else "login"

    @field_validator("tags")
    @classmethod
    def _clean_tags(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for tag in value:
            tag = tag.strip()[:_MAX_TAG_LENGTH].strip()
            if tag and tag not in cleaned:
                cleaned.append(tag)
        return cleaned

    @field_validator("custom_fields")
    @classmethod
    def _clean_custom_fields(cls, value: list[CustomField]) -> list[CustomField]:
        return [field for field in value if field.label]


class PasswordHistoryEntry(BaseModel):
    value: str
    changed_at: datetime


class StoredCustomField(BaseModel):
    label: str
    value: str = ""
    hidden: bool = False

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)


class RestoredPassword(BaseModel):
    """
    An entry from a CipherMoth backup, restored exactly as the vault held it.

    A backup must restore whatever the vault it came from could hold, and
    vaults written by imports before v1.4.7 can hold values over the input
    limits, untrimmed names, invalid 2FA secrets and names such as '.' that new
    entries may not use, so only what the database cannot store is refused.
    Reads tolerate the rest, and editing the entry applies the normal rules.
    """

    password_name: str = Field(min_length=1)
    kind: str = "login"
    username: str | None = None
    password_value: str = Field(min_length=1)
    url: str | None = None
    totp_secret: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    custom_fields: list[StoredCustomField] = Field(default_factory=list)
    folder: str | None = None
    favorite: bool = False

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)

    @field_validator("password_name", "username", "description")
    @classmethod
    def _storable_as_text(cls, value: str | None) -> str | None:
        return reject_nul(value)

    @field_validator("totp_secret")
    @classmethod
    def _normalize_totp(cls, value: str | None) -> str | None:
        return normalize_totp_secret_leniently(value)

    @field_validator("folder")
    @classmethod
    def _clean_folder(cls, value: str | None) -> str | None:
        return value or None

    @field_validator("kind")
    @classmethod
    def _clean_kind(cls, value: str) -> str:
        return value if value in ("login", "note") else "login"


class PasswordResponse(BaseModel):
    id: int
    owner_id: int | None = None
    owner_username: str | None = None
    access: EntryPermission | None = None
    access_sources: list[FolderAccessSource] = Field(default_factory=list)
    password_name: str
    kind: str = "login"
    username: str | None = None
    password_value: str
    url: str | None = None
    totp_secret: str | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    custom_fields: list[StoredCustomField] = Field(default_factory=list)
    folder: str | None = None
    folder_id: int | None = None
    favorite: bool = False
    backed_up: bool
    created: datetime
    updated: datetime
    deleted: datetime | None = None
    password_history: list[PasswordHistoryEntry] = Field(default_factory=list)
    attachment_count: int = 0


class AttachmentResponse(BaseModel):
    id: int
    filename: str
    content_type: str | None = None
    size_bytes: int
    created: datetime


class FavoriteUpdatePayload(BaseModel):
    favorite: bool


class PasswordCreate(BaseModel):
    created: bool
    detail: str


class PasswordUpdate(BaseModel):
    updated: bool
    detail: str


class PasswordDelete(BaseModel):
    deleted: bool
    detail: str


class PasswordRef(BaseModel):
    password_name: str = Field(min_length=1)

    @field_validator("*")
    @classmethod
    def _unicode(cls, value: object) -> object:
        return require_unicode_text(value)

    @field_validator("password_name")
    @classmethod
    def _storable_as_text(cls, value: str | None) -> str | None:
        return reject_nul(value)


class PasswordUpdatePayload(BaseModel):
    password: PasswordRef
    new_password: Password


class PasswordHistoryReusePayload(PasswordRef):
    history_index: int = Field(ge=0)
    changed_at: str = Field(min_length=1)

    @field_validator("changed_at")
    @classmethod
    def _valid_marker(cls, value: str) -> str:
        try:
            datetime.fromisoformat(value)
        except ValueError:
            raise ValueError("changed_at must be an ISO 8601 timestamp.") from None
        return value


MAX_BULK_ENTRIES = 10_000


class TrashedEntryRef(PasswordRef):
    entry_id: int = Field(gt=0)


class TrashUndoRef(TrashedEntryRef):
    deleted_at: datetime


class ActiveTrashRef(PasswordRef):
    entry_id: int | None = Field(default=None, gt=0)


class BulkTrashPayload(BaseModel):
    entries: list[ActiveTrashRef] = Field(min_length=1, max_length=MAX_BULK_ENTRIES)

    @model_validator(mode="after")
    def _distinct(self) -> "BulkTrashPayload":
        ids = [entry.entry_id for entry in self.entries if entry.entry_id is not None]
        if len(set(ids)) != len(ids) or len(
            {entry.password_name for entry in self.entries}
        ) != len(self.entries):
            raise ValueError("Each entry may be listed only once.")
        return self


class BulkTrashedPayload(BaseModel):
    entries: list[TrashedEntryRef] = Field(min_length=1, max_length=MAX_BULK_ENTRIES)

    @model_validator(mode="after")
    def _distinct(self) -> "BulkTrashedPayload":
        if len({entry.entry_id for entry in self.entries}) != len(self.entries):
            raise ValueError("Each entry may be listed only once.")
        return self


class BulkTrashUndoPayload(BaseModel):
    entries: list[TrashUndoRef] = Field(min_length=1, max_length=MAX_BULK_ENTRIES)

    @model_validator(mode="after")
    def _distinct(self) -> "BulkTrashUndoPayload":
        if len({entry.entry_id for entry in self.entries}) != len(self.entries):
            raise ValueError("Each entry may be listed only once.")
        return self


class EntryRef(BaseModel):
    entry_id: int = Field(gt=0)


class BulkMovePayload(BaseModel):
    entries: list[EntryRef] = Field(min_length=1, max_length=MAX_BULK_ENTRIES)
    folder_id: int | None

    @model_validator(mode="after")
    def _distinct(self) -> "BulkMovePayload":
        if len({entry.entry_id for entry in self.entries}) != len(self.entries):
            raise ValueError("Each entry may be listed only once.")
        return self


class MoveUndoRef(EntryRef):
    folder_id: int | None
    moved_to_folder_id: int | None


class BulkMoveUndoPayload(BaseModel):
    entries: list[MoveUndoRef] = Field(min_length=1, max_length=MAX_BULK_ENTRIES)

    @model_validator(mode="after")
    def _distinct(self) -> "BulkMoveUndoPayload":
        if len({entry.entry_id for entry in self.entries}) != len(self.entries):
            raise ValueError("Each entry may be listed only once.")
        return self


class BulkResult(BaseModel):
    count: int
    detail: str


class BulkTrashResult(BulkResult):
    entries: list[TrashUndoRef]


class SettingsResponse(BaseModel):
    inactivity_ms: int
    warn_before_ms: int
    hidden_ms: int
    debounce_ms: int
    clipboard_clear_ms: int
    update_check_enabled: bool


class SettingsUpdate(BaseModel):
    inactivity_ms: int = Field(ge=30_000, le=3_600_000)
    warn_before_ms: int = Field(ge=5_000, le=600_000)
    hidden_ms: int = Field(ge=10_000, le=3_600_000)
    debounce_ms: int = Field(ge=100, le=10_000)
    clipboard_clear_ms: int = Field(ge=5_000, le=600_000)
    update_check_enabled: bool

    @model_validator(mode="after")
    def _warning_comes_before_the_lock(self) -> "SettingsUpdate":
        if self.warn_before_ms >= self.inactivity_ms:
            raise ValueError("warn_before_ms must be shorter than inactivity_ms.")
        return self


class OnConflict(StrEnum):
    skip = "skip"
    overwrite = "overwrite"


class ImportRowReport(BaseModel):
    where: str
    name: str | None = None
    reason: str


class PasswordImportResult(BaseModel):
    imported: int
    skipped: int
    overwritten: int
    total: int
    ignored: int = 0
    ignored_rows: list[ImportRowReport] = Field(default_factory=list)
    renamed: int = 0
    renamed_rows: list[ImportRowReport] = Field(default_factory=list)
    trashed: int = 0
    attachments: int = 0
    grants_restored: int = 0
    settings_restored: bool = False


class HealthResponse(BaseModel):
    status: str
    version: str
    schema_state: str = Field(serialization_alias="schema")


class DamagedRows(BaseModel):
    entries: list[int]
    attachments: list[int]
