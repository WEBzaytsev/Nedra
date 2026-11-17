import base64
import hashlib
import hmac
import json
import struct
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, fields
from datetime import datetime
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection

ENCRYPTED_COLUMNS = {
    "vault": ("wrapped_key",),
    "users": ("wrapped_key",),
    "entries": ("document",),
    "attachments": ("meta", "content"),
}
KINDS = ("login", "note")
DOCUMENT_KEYS = {
    "name",
    "kind",
    "username",
    "value",
    "url",
    "totp_secret",
    "description",
    "tags",
    "custom_fields",
    "folder",
    "favorite",
    "history",
}


def hkdf(key: bytes, label: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=label.encode()
    ).derive(key)


def associated_data(*parts: bytes) -> bytes:
    data = b"\x02ciphermoth/v2"
    for part in parts:
        data += struct.pack(">I", len(part)) + part
    return data


@dataclass(frozen=True)
class Problem:
    table: str
    row_id: object
    column: str
    reason: str

    def __str__(self) -> str:
        return f"{self.table}[{self.row_id}].{self.column}: {self.reason}"


class VaultIntegrityError(AssertionError):
    def __init__(self, problems: list[Problem]) -> None:
        self.problems = problems
        super().__init__(
            f"{len(problems)} integrity problem(s):\n"
            + "\n".join(f"  {p}" for p in problems)
        )


@dataclass(frozen=True)
class Attachment:
    id: int
    filename: str
    content_type: str | None
    size_bytes: int
    sha256: str
    created: datetime | None

    @property
    def identity(self) -> tuple:
        return (self.filename, self.content_type, self.size_bytes, self.sha256)


@dataclass(frozen=True)
class Entry:
    id: int
    name: str
    kind: str
    username: str | None
    description: str | None
    value: str
    url: str | None
    totp_secret: str | None
    tags: tuple[str, ...]
    custom_fields: tuple[tuple[str, str, bool], ...]
    folder: str | None
    history: tuple[tuple[str, str], ...]
    favorite: bool
    backed_up: bool
    created: datetime | None
    updated: datetime | None
    deleted: datetime | None
    attachments: tuple[Attachment, ...]

    @property
    def trashed(self) -> bool:
        return self.deleted is not None


@dataclass(frozen=True)
class VaultContents:
    revision: int | None
    vault_rows: int
    key_check: str
    entries: tuple[Entry, ...]
    settings: tuple[Mapping[str, object], ...]
    problems: tuple[Problem, ...] = field(default=())

    @property
    def active(self) -> dict[str, Entry]:
        return {e.name: e for e in self.entries if not e.trashed}

    @property
    def trash(self) -> list[Entry]:
        return [e for e in self.entries if e.trashed]


async def table_columns(conn: AsyncConnection, table: str) -> set[str] | None:
    def read(sync_conn: Any) -> set[str] | None:
        inspector = inspect(sync_conn)
        if not inspector.has_table(table):
            return None
        return {column["name"] for column in inspector.get_columns(table)}

    return await conn.run_sync(read)


def _plain(value: object) -> object:
    return bytes(value) if isinstance(value, memoryview) else value


async def raw_rows(conn: AsyncConnection, table: str) -> dict[int, dict[str, Any]]:
    """Every row of ``table`` keyed by id, with bytes exactly as stored."""
    if await table_columns(conn, table) is None:
        return {}
    result = await conn.execute(text(f"SELECT * FROM {table} ORDER BY id"))
    return {
        row["id"]: {k: _plain(v) for k, v in row.items()} for row in result.mappings()
    }


async def raw_vault(conn: AsyncConnection) -> dict[str, dict[int, dict[str, Any]]]:
    return {
        table: await raw_rows(conn, table)
        for table in ("vault", "users", "entries", "attachments")
    }


def raw_key_bytes(key: str | bytes) -> bytes:
    return base64.urlsafe_b64decode(key) if isinstance(key, str) else bytes(key)


class _Reader:
    """An independent format 2 reader built on the primitives, following
    docs/VAULT_FORMAT.md, so the tests do not check helpers.py with itself."""

    def __init__(self, raw_key: bytes) -> None:
        self.records = AESGCM(hkdf(raw_key, "ciphermoth/v2/record-encryption"))
        self.index_key = hkdf(raw_key, "ciphermoth/v2/name-index")
        self.check = hkdf(raw_key, "ciphermoth/v2/key-check")
        self.problems: list[Problem] = []

    def flag(self, table: str, row_id: object, column: str, reason: str) -> None:
        self.problems.append(Problem(table, row_id, column, reason))

    def open(
        self, table: str, row_id: object, column: str, sealed: object, *parts: bytes
    ) -> bytes | None:
        if not isinstance(sealed, bytes) or len(sealed) < 29 or sealed[:1] != b"\x02":
            self.flag(table, row_id, column, "missing or not a sealed value")
            return None
        try:
            return self.records.decrypt(
                sealed[1:13], sealed[13:], associated_data(*parts)
            )
        except InvalidTag:
            self.flag(table, row_id, column, "does not authenticate")
            return None

    def document(
        self, table: str, row_id: object, column: str, plaintext: bytes | None
    ) -> dict[str, Any]:
        if plaintext is None:
            return {}
        try:
            data = json.loads(plaintext.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.flag(table, row_id, column, "plaintext is not UTF-8 JSON")
            return {}
        if not isinstance(data, dict):
            self.flag(table, row_id, column, "JSON is not an object")
            return {}
        if len(plaintext) % 64:
            self.flag(table, row_id, column, "not padded to 64 bytes")
        return data

    def name_index(self, name: str) -> bytes:
        return hmac.new(self.index_key, name.encode(), hashlib.sha256).digest()


def _check_vault_row(
    reader: _Reader, rows: list[dict[str, Any]], master_password: str | None
) -> str:
    if not rows:
        reader.flag("vault", None, "*", "no vault row")
        return "absent"
    if len(rows) > 1:
        reader.flag("vault", None, "*", f"{len(rows)} rows")
    row = rows[0]
    if row["format_version"] != 2 or row["kdf"] != "argon2id":
        reader.flag("vault", row["id"], "format_version", "not format 2 argon2id")
    if master_password is not None:
        derived = Argon2id(
            salt=row["kdf_salt"],
            length=32,
            iterations=row["kdf_iterations"],
            lanes=row["kdf_lanes"],
            memory_cost=row["kdf_memory_kib"],
        ).derive(master_password.encode())
        commitment = hkdf(derived, "ciphermoth/v2/password-commitment")
        if not hmac.compare_digest(commitment, row["password_check"]):
            reader.flag("vault", row["id"], "password_check", "password rejected")
        else:
            associated = (
                b"ciphermoth/v2/wrapped-vault-key"
                + struct.pack(
                    ">HIII",
                    2,
                    row["kdf_memory_kib"],
                    row["kdf_iterations"],
                    row["kdf_lanes"],
                )
                + row["kdf_salt"]
            )
            wrapped = row["wrapped_key"]
            try:
                raw = AESGCM(hkdf(derived, "ciphermoth/v2/key-wrapping")).decrypt(
                    wrapped[1:13], wrapped[13:], associated
                )
            except InvalidTag:
                reader.flag("vault", row["id"], "wrapped_key", "does not unwrap")
            else:
                if hkdf(raw, "ciphermoth/v2/key-check") != reader.check:
                    reader.flag("vault", row["id"], "wrapped_key", "another key")
    if hmac.compare_digest(reader.check, row["key_check"]):
        return "valid"
    reader.flag("vault", row["id"], "key_check", "does not match the key")
    return "invalid"


def _attachments(
    reader: _Reader,
    rows: dict[int, dict[str, Any]],
    entry_uids: dict[int, bytes],
) -> dict[int, list[Attachment]]:
    table = "attachments"
    by_entry: dict[int, list[Attachment]] = {}
    for row_id, row in rows.items():
        entry_uid = entry_uids.get(row["entry_id"])
        if entry_uid is None:
            reader.flag(table, row_id, "entry_id", "no such entry")
            entry_uid = b""
        content = reader.open(
            table,
            row_id,
            "content",
            row["content"],
            b"attachment-content",
            row["uid"],
            entry_uid,
        )
        if content is not None and len(content) != row["size_bytes"]:
            reader.flag(table, row_id, "size_bytes", "does not match the content")
        metadata = reader.document(
            table,
            row_id,
            "meta",
            reader.open(
                table,
                row_id,
                "meta",
                row["meta"],
                b"attachment-metadata",
                row["uid"],
                entry_uid,
            ),
        )
        if metadata and set(metadata) != {"filename", "content_type"}:
            reader.flag(table, row_id, "meta", f"keys {sorted(metadata)}")
        by_entry.setdefault(row["entry_id"], []).append(
            Attachment(
                id=row_id,
                filename=metadata.get("filename", ""),
                content_type=metadata.get("content_type"),
                size_bytes=row["size_bytes"],
                sha256=hashlib.sha256(content or b"").hexdigest(),
                created=row.get("created"),
            )
        )
    return by_entry


def _history(
    reader: _Reader, row_id: object, items: object
) -> tuple[tuple[str, str], ...]:
    out: list[tuple[str, str]] = []
    for item in items if isinstance(items, list) else []:
        value = item.get("value") if isinstance(item, dict) else None
        changed = item.get("changed_at") if isinstance(item, dict) else None
        if not isinstance(value, str) or not isinstance(changed, str):
            reader.flag("entries", row_id, "history", "malformed item")
            continue
        try:
            datetime.fromisoformat(changed)
        except ValueError:
            reader.flag("entries", row_id, "history", "bad timestamp")
        out.append((value, changed))
    return tuple(out)


def _custom_fields(
    reader: _Reader, row_id: object, items: object
) -> tuple[tuple[str, str, bool], ...]:
    out: list[tuple[str, str, bool]] = []
    for item in items if isinstance(items, list) else []:
        fields = item if isinstance(item, dict) else {}
        label, value, hidden = (fields.get(k) for k in ("label", "value", "hidden"))
        if (
            set(fields) != {"label", "value", "hidden"}
            or not isinstance(label, str)
            or not isinstance(value, str)
            or not isinstance(hidden, bool)
        ):
            reader.flag("entries", row_id, "custom_fields", "malformed field")
            continue
        out.append((label, value, hidden))
    return tuple(out)


def _entries(
    reader: _Reader,
    rows: dict[int, dict[str, Any]],
    attachments: dict[int, list[Attachment]],
) -> list[Entry]:
    table = "entries"
    entries = []
    active_names: set[str] = set()
    for row_id, row in rows.items():
        doc = reader.document(
            table,
            row_id,
            "document",
            reader.open(
                table, row_id, "document", row["document"], b"entry", row["uid"]
            ),
        )
        if doc and set(doc) != DOCUMENT_KEYS:
            reader.flag(table, row_id, "document", f"keys {sorted(doc)}")
        name = doc.get("name", "")
        kind = doc.get("kind", "login")
        if kind not in KINDS:
            reader.flag(table, row_id, "kind", f"unknown kind {kind!r}")
        if doc and reader.name_index(str(name)) != row["name_index"]:
            reader.flag(table, row_id, "name_index", "does not match the name")
        if row.get("deleted") is None:
            if name in active_names:
                reader.flag(table, row_id, "name", "duplicate active name")
            active_names.add(name)
        tags = doc.get("tags", [])
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            reader.flag(table, row_id, "tags", "a tag is not a string")
            tags = []
        created, updated = row.get("created"), row.get("updated")
        if created and updated and updated < created:
            reader.flag(table, row_id, "updated", "earlier than created")
        entries.append(
            Entry(
                id=row_id,
                name=name,
                kind=kind,
                username=doc.get("username"),
                description=doc.get("description"),
                value=doc.get("value", ""),
                url=doc.get("url"),
                totp_secret=doc.get("totp_secret"),
                tags=tuple(tags),
                custom_fields=_custom_fields(reader, row_id, doc.get("custom_fields")),
                folder=doc.get("folder"),
                history=_history(reader, row_id, doc.get("history")),
                favorite=doc.get("favorite") is True,
                backed_up=bool(row.get("backed_up")),
                created=created,
                updated=updated,
                deleted=row.get("deleted"),
                attachments=tuple(attachments.get(row_id, [])),
            )
        )
    return entries


async def read_vault(
    conn: AsyncConnection,
    key: str | bytes,
    *,
    master_password: str | None = None,
    strict: bool = True,
) -> VaultContents:
    """
    Decrypt every entry, active and trashed, and every attachment with an
    independent format 2 reader, and check the structural invariants of a
    vault: authenticated ciphertext bound to its row, exact document keys,
    name indexes that match the names, unique active names, attachment sizes.
    With ``strict`` any problem raises VaultIntegrityError.
    """
    reader = _Reader(raw_key_bytes(key))
    raw = await raw_vault(conn)
    key_check = _check_vault_row(reader, list(raw["vault"].values()), master_password)

    revision = await conn.scalar(text("PRAGMA user_version"))

    attachments = _attachments(
        reader,
        raw["attachments"],
        {row_id: row["uid"] for row_id, row in raw["entries"].items()},
    )
    entries = _entries(reader, raw["entries"], attachments)

    settings = tuple(
        {k: v for k, v in row.items() if k not in ("id", "created", "updated")}
        for row in (await raw_rows(conn, "settings")).values()
    )
    if len(settings) > 1:
        reader.flag("settings", None, "*", f"{len(settings)} rows")

    if strict and reader.problems:
        raise VaultIntegrityError(reader.problems)
    return VaultContents(
        revision=revision,
        vault_rows=len(raw["vault"]),
        key_check=key_check,
        entries=tuple(entries),
        settings=settings,
        problems=tuple(reader.problems),
    )


PLAINTEXT_FIELDS = (
    "kind",
    "username",
    "description",
    "value",
    "url",
    "totp_secret",
    "tags",
    "custom_fields",
    "folder",
    "history",
    "favorite",
)


def diff_vaults(
    before: VaultContents,
    after: VaultContents,
    *,
    compare: Iterable[str] = PLAINTEXT_FIELDS,
    attachments: bool = True,
    trash: bool = True,
) -> list[str]:
    """
    Every difference between two vaults' decrypted contents as readable lines.
    Entries are matched by (trashed, name, deleted time), never by row id, so
    the comparison also works after a restore into a fresh database.
    """
    names = list(compare)
    unknown = set(names) - {f.name for f in fields(Entry)}
    if unknown:
        raise ValueError(f"unknown entry fields: {sorted(unknown)}")

    def index(vault: VaultContents) -> dict[tuple, Entry]:
        return {
            (e.trashed, e.name, e.deleted): e
            for e in vault.entries
            if trash or not e.trashed
        }

    left, right = index(before), index(after)
    out = [f"missing after: {key}" for key in left.keys() - right.keys()]
    out += [f"new after: {key}" for key in right.keys() - left.keys()]
    for key in left.keys() & right.keys():
        a, b = left[key], right[key]
        for name in names:
            if getattr(a, name) != getattr(b, name):
                out.append(
                    f"{key} {name}: {getattr(a, name)!r} != {getattr(b, name)!r}"
                )
        if attachments:
            mine = sorted(x.identity for x in a.attachments)
            theirs = sorted(x.identity for x in b.attachments)
            if mine != theirs:
                out.append(f"{key} attachments: {mine!r} != {theirs!r}")
    return sorted(out)


def assert_same_vault(
    before: VaultContents, after: VaultContents, **options: Any
) -> None:
    differences = diff_vaults(before, after, **options)
    assert not differences, "vault contents differ:\n" + "\n".join(differences)


def diff_ciphertext(
    before: Mapping[str, Mapping[int, Mapping[str, Any]]],
    after: Mapping[str, Mapping[int, Mapping[str, Any]]],
    columns: Mapping[str, Iterable[str]] = ENCRYPTED_COLUMNS,
) -> list[str]:
    """Byte-level differences in the encrypted columns of rows from raw_vault."""
    out = []
    for table, names in columns.items():
        a, b = before.get(table, {}), after.get(table, {})
        if a.keys() != b.keys():
            out.append(f"{table}: row ids {sorted(a)} != {sorted(b)}")
        for row_id in sorted(a.keys() & b.keys()):
            for name in names:
                if a[row_id].get(name) != b[row_id].get(name):
                    out.append(f"{table}[{row_id}].{name} changed")
    return out
