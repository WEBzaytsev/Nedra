import asyncio
import hashlib
import io
import json
import os
import resource
import struct
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from hypothesis import given
from hypothesis import strategies as st

import helpers
from backup_format import MAX_FRAMES, BackupReader, BackupWriter
from tests.integrity import assert_same_vault
from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    WRONG_MASTER_PASSWORD,
    Headers,
    auth,
    backup_entry,
    backup_file,
    create_vault,
    db_execute,
    db_snapshot,
    engine,
    entry,
    raw_vault_key,
    read_current_vault,
    reset_vault,
)

VECTORS = Path(__file__).resolve().parents[2] / "testdata" / "vectors"
FROZEN = (VECTORS / "backup-v2.cmbackup").read_bytes()
FROZEN_KEY = helpers.BackupKey(
    bytes.fromhex(json.loads((VECTORS / "backup-v2.json").read_text())["derived_hex"])
)
FROZEN_PASSWORD = json.loads((VECTORS / "backup-v2.json").read_text())["password"]
MIB = 1024 * 1024
PLAINTEXT = (
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


def _read_all(data: bytes, key: helpers.BackupKey = FROZEN_KEY) -> list[bytes]:
    reader = BackupReader(io.BytesIO(data))
    if not key.matches(reader.header):
        raise helpers.DecryptionFailed
    frames = [reader.read(key, 64 * MIB) for _ in range(reader.header.frames)]
    reader.finish()
    return frames


def _refused(data: bytes) -> bool:
    try:
        _read_all(data)
    except (helpers.BackupFormatError, helpers.DecryptionFailed):
        return True
    return False


def test_the_frozen_backup_reads_completely() -> None:
    manifest, active, content, trashed = _read_all(FROZEN)
    assert json.loads(manifest)["version"] == 2
    assert json.loads(manifest)["entries_count"] == 2
    assert json.loads(active)["name"] == "GitHub"
    assert json.loads(trashed)["name"] == "GitHub"
    assert len(content) == 1026


async def test_structured_entry_metadata_stays_within_its_backup_overhead_budget(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    payload = entry("dense-tags")
    payload["tags"] = ["x" * 38 + f"{index:02d}" for index in range(20)]
    payload["custom_fields"] = [
        {"label": f"field-{index}", "value": "v" * 4096, "hidden": True}
        for index in range(30)
    ]
    created = await client.post("/passwords/create", json=payload, headers=headers)
    assert created.status_code == 200, created.text

    response = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    assert response.status_code == 200, response.text
    reader = BackupReader(io.BytesIO(response.content))
    key = await helpers.backup_key_for(MASTER_PASSWORD, reader.header)
    reader.read(key, 64 * MIB)
    entry_frame = reader.read(key, 64 * MIB)
    (stored_size,) = (await db_execute("SELECT length(document) FROM entries"))[0]

    restored = json.loads(entry_frame)
    assert len(restored["tags"]) == 20
    assert len(restored["custom_fields"]) == 30
    assert len(entry_frame) <= stored_size + 32 * 1024


def test_every_single_bit_flip_anywhere_in_a_backup_is_refused() -> None:
    for position in range(len(FROZEN)):
        flipped = bytearray(FROZEN)
        flipped[position] ^= 0x01
        assert _refused(bytes(flipped)), position


def test_every_truncation_and_any_extension_is_refused() -> None:
    for length in range(len(FROZEN)):
        assert _refused(FROZEN[:length]), length
    for extra in (b"\x00", b"CMBACKUP", FROZEN[-20:]):
        assert _refused(FROZEN + extra)


def _frames(data: bytes) -> tuple[bytes, list[bytes]]:
    header, rest = data[:75], data[75:]
    frames = []
    while rest:
        (length,) = struct.unpack(">I", rest[:4])
        frames.append(rest[: 16 + length])
        rest = rest[16 + length :]
    return header, frames


def test_reordered_repeated_dropped_and_foreign_frames_are_refused() -> None:
    header, frames = _frames(FROZEN)
    assert len(frames) == 4
    assert not _refused(header + b"".join(frames))
    for altered in (
        [frames[1], frames[0], *frames[2:]],
        [frames[0], frames[1], frames[1], *frames[2:]],
        frames[:-1],
        [frames[0], frames[2], frames[1], frames[3]],
    ):
        assert _refused(header + b"".join(altered))
    two_frames = struct.pack(">I", 1)
    one_frame_header = header[:-36] + two_frames + header[-32:]
    assert _refused(one_frame_header + b"".join(frames))

    other_salt = os.urandom(16)
    other = io.BytesIO()
    writer = BackupWriter(
        other,
        FROZEN_KEY,
        helpers.BackupHeader(helpers.DEFAULT_KDF, other_salt, 2, FROZEN_KEY.commitment),
    )
    writer.write(b"{}")
    writer.write(b"another backup")
    writer.finish()
    _, foreign_frames = _frames(other.getvalue())
    for altered in (
        [foreign_frames[0], *frames[1:]],
        [*frames[:-1], foreign_frames[-1]],
    ):
        assert _refused(header + b"".join(altered))


def test_a_frame_length_beyond_the_limit_is_refused_before_reading_it() -> None:
    header, frames = _frames(FROZEN)
    manifest = frames[0]
    huge = header + struct.pack(">I", 0xFFFFFFFF) + manifest[4:]

    class NeverReadsMuch(io.BytesIO):
        def read(self, size: int | None = -1) -> bytes:
            assert size is not None and 0 <= size <= 1 * MIB, size
            return super().read(size)

    reader = BackupReader(NeverReadsMuch(huge))
    with pytest.raises(helpers.BackupFormatError):
        reader.read(FROZEN_KEY, 1 * MIB)


@pytest.mark.parametrize(
    ("field", "offset", "value"),
    [
        ("magic", 0, b"CMBACKUQ"),
        ("version", 8, struct.pack(">H", 3)),
        ("kdf", 10, b"\x02"),
        ("memory", 11, struct.pack(">I", 4 * 1024 * 1024)),
        ("iterations", 15, struct.pack(">I", 1000)),
        ("lanes", 19, struct.pack(">I", 64)),
        ("frames", 39, struct.pack(">I", MAX_FRAMES + 1)),
        ("no frames", 39, struct.pack(">I", 0)),
    ],
)
async def test_header_problems_are_refused_before_deriving_a_key(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    offset: int,
    value: bytes,
) -> None:
    headers = auth(await create_vault(client))
    data = FROZEN[:offset] + value + FROZEN[offset + len(value) :]
    before = await db_snapshot()

    def never(*args: object) -> bytes:
        raise AssertionError("a key was derived for a refused backup")

    monkeypatch.setattr(helpers, "Argon2id", never)
    resp = await _import(client, headers, data, FROZEN_PASSWORD)
    assert resp.status_code == 400, (field, resp.text)
    assert await db_snapshot() == before


async def _import(
    client: httpx.AsyncClient,
    headers: Headers,
    data: bytes,
    password: str = MASTER_PASSWORD,
    on_conflict: str = "skip",
) -> httpx.Response:
    return await client.post(
        "/passwords/import",
        data={"master_password": password, "on_conflict": on_conflict},
        files={"file": ("b.cmbackup", data, "application/octet-stream")},
        headers=headers,
    )


async def test_wrong_password_tampering_and_truncation_through_the_api(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("kept"), headers=headers)
    before = await db_snapshot()
    header, frames = _frames(FROZEN)
    manifest = frames[0]
    content = frames[2]
    tampered_content = bytearray(content)
    tampered_content[-3] ^= 0x80
    cases = {
        "wrong password": (FROZEN, WRONG_MASTER_PASSWORD, 403),
        "nfd password": (
            FROZEN,
            FROZEN_PASSWORD.replace("ö", "ö"),
            403,
        ),
        "flipped manifest": (
            header
            + manifest[:30]
            + bytes([manifest[30] ^ 1])
            + manifest[31:]
            + b"".join(frames[1:]),
            FROZEN_PASSWORD,
            400,
        ),
        "flipped attachment": (
            header
            + b"".join([frames[0], frames[1], bytes(tampered_content), frames[3]]),
            FROZEN_PASSWORD,
            400,
        ),
        "truncated attachment": (FROZEN[:-1], FROZEN_PASSWORD, 400),
        "missing attachment": (
            header + b"".join([frames[0], frames[1], frames[3]]),
            FROZEN_PASSWORD,
            400,
        ),
        "trailing bytes": (FROZEN + b"\x00", FROZEN_PASSWORD, 400),
        "header only": (header, FROZEN_PASSWORD, 400),
        "empty": (b"", FROZEN_PASSWORD, 400),
        "csv": (b"name,password\nx,y\n", FROZEN_PASSWORD, 400),
    }
    for label, (data, password, status) in cases.items():
        resp = await _import(client, headers, data, password)
        assert resp.status_code == status, (label, resp.text)
        assert FROZEN_PASSWORD not in resp.text
        assert await db_snapshot() == before, label


def _attachment(content: bytes, **fields: object) -> dict:
    return {
        "filename": "f.bin",
        "content_type": None,
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "created": "2026-01-01T00:00:00+00:00",
        **fields,
    }


MALFORMED: dict[str, tuple[list[dict], list[bytes], dict]] = {
    "unknown entry key": ([backup_entry("a", surprise=1)], [], {}),
    "missing entry key": (
        [{k: v for k, v in backup_entry("a").items() if k != "folder"}],
        [],
        {},
    ),
    "wrong type": ([backup_entry("a", favorite="yes")], [], {}),
    "tag not text": ([backup_entry("a", tags=[1])], [], {}),
    "unknown kind": ([backup_entry("a", kind="card")], [], {}),
    "empty name": ([backup_entry("")], [], {}),
    "empty value": ([backup_entry("a", "")], [], {}),
    "nul in name": ([backup_entry("a\x00b")], [], {}),
    "lone surrogate": ([backup_entry("a\ud800")], [], {}),
    "bad timestamp": ([backup_entry("a", created="yesterday")], [], {}),
    "bad history time": (
        [backup_entry("a", history=[{"value": "x", "changed_at": "soon"}])],
        [],
        {},
    ),
    "week-date history time": (
        [
            backup_entry(
                "a", history=[{"value": "x", "changed_at": "2026-W01-1T00:00:00"}]
            )
        ],
        [],
        {},
    ),
    "compact history time": (
        [backup_entry("a", history=[{"value": "x", "changed_at": "20260105T000000"}])],
        [],
        {},
    ),
    "time beyond year 9999 in UTC": (
        [backup_entry("a", created="9999-12-31T23:00:00-05:00")],
        [],
        {},
    ),
    "time before year 1 in UTC": (
        [backup_entry("a", deleted="0001-01-01T00:30:00+01:00")],
        [],
        {},
    ),
    "two active with one name": (
        [backup_entry("twin"), backup_entry("twin", "other")],
        [],
        {},
    ),
    "attachment without frame": (
        [backup_entry("a", attachments=[_attachment(b"abc")])],
        [],
        {},
    ),
    "frame without attachment": ([backup_entry("a")], [b"abc"], {}),
    "wrong size": (
        [backup_entry("a", attachments=[_attachment(b"abc", size=4)])],
        [b"abc"],
        {},
    ),
    "wrong digest": (
        [backup_entry("a", attachments=[_attachment(b"abc", sha256="00" * 32)])],
        [b"abc"],
        {},
    ),
    "attachment over 10 MB": (
        [backup_entry("a", attachments=[_attachment(b"x", size=11 * MIB)])],
        [b"x"],
        {},
    ),
    "21 attachments": (
        [backup_entry("a", attachments=[_attachment(b"x")] * 21)],
        [b"x"] * 21,
        {},
    ),
    "over 50 MB on one entry": (
        [backup_entry("a", attachments=[_attachment(b"x", size=10 * MIB)] * 6)],
        [b"x"] * 6,
        {},
    ),
    "invalid settings": (
        [backup_entry("a")],
        [],
        {"settings": {"inactivity_ms": 1}},
    ),
    "unknown version": ([backup_entry("a")], [], {"version": 4}),
    "unknown top-level key": ([backup_entry("a")], [], {"extra": True}),
}


@pytest.mark.parametrize("case", sorted(MALFORMED))
async def test_malformed_manifests_are_refused_without_writing(
    client: httpx.AsyncClient, case: str
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("kept"), headers=headers)
    entries, contents, overrides = MALFORMED[case]
    manifest = {
        "format": "ciphermoth-backup",
        "version": 2,
        "exported_at": "2026-10-15T00:00:00+00:00",
        "app_version": "test",
        "settings": {
            "inactivity_ms": 120000,
            "warn_before_ms": 60000,
            "hidden_ms": 60000,
            "debounce_ms": 1000,
            "clipboard_clear_ms": 30000,
            "update_check_enabled": True,
        },
        "entries_count": len(entries),
    }
    for name, value in overrides.items():
        manifest[name] = (
            {**manifest[name], **value} if isinstance(value, dict) else value
        )
    data = backup_file(entries, manifest=manifest, contents=contents)
    before = await db_snapshot()

    resp = await _import(client, headers, data)

    assert resp.status_code == 400, resp.text
    assert "a\x00b" not in resp.text
    assert await db_snapshot() == before


async def test_a_complete_backup_restores_everything_byte_for_byte(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    binary = bytes(range(256)) * 20 + os.urandom(1000)
    login = entry(
        "Bank ü/ü",
        "first",
        username="me@example.com",
        url="https://bank.test",
        totp_secret="JBSWY3DPEHPK3PXP",
        description="line\nline",
        tags=["money", "ü"],
        custom_fields=[{"label": "PIN", "value": "0000", "hidden": True}],
        folder="Finance",
        favorite=True,
    )
    for item in (
        {**login},
        entry("note", "  spaced\n\n", kind="note"),
        entry("gone", "gone-v", folder="Old"),
    ):
        assert (
            await client.post("/passwords/create", json=item, headers=headers)
        ).is_success
    for value in ("second", "third"):
        resp = await client.patch(
            "/passwords/update",
            json={
                "password": {"password_name": login["password_name"]},
                "new_password": {**login, "password_value": value},
            },
            headers=headers,
        )
        assert resp.status_code == 200
    for name, content in (("Bank ü%2Fü", binary), ("gone", b"\x00")):
        resp = await client.post(
            f"/passwords/{name}/attachments",
            files={"file": ("Preț.bin", content, "application/x-test")},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
    assert (await client.delete("/passwords/gone", headers=headers)).is_success
    settings = {
        "inactivity_ms": 300_000,
        "warn_before_ms": 30_000,
        "hidden_ms": 120_000,
        "debounce_ms": 500,
        "clipboard_clear_ms": 15_000,
        "update_check_enabled": False,
    }
    await client.patch("/settings", json=settings, headers=headers)
    original = await read_current_vault()
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    assert backup.status_code == 200
    assert backup.headers["content-type"] == "application/octet-stream"
    assert ".cmbackup" in backup.headers["content-disposition"]
    assert not any(e.backed_up for e in (await read_current_vault()).entries)

    await reset_vault()
    headers = auth(await create_vault(client, NEW_MASTER_PASSWORD))
    resp = await _import(client, headers, backup.content)
    assert resp.status_code == 200, resp.text
    assert resp.json() | {"ignored_rows": [], "renamed_rows": []} == {
        "imported": 2,
        "skipped": 0,
        "overwritten": 0,
        "total": 3,
        "ignored": 0,
        "ignored_rows": [],
        "renamed": 0,
        "renamed_rows": [],
        "trashed": 1,
        "attachments": 2,
        "grants_restored": 0,
        "settings_restored": True,
    }
    restored = await read_current_vault(NEW_MASTER_PASSWORD)
    assert_same_vault(original, restored, compare=[*PLAINTEXT, "created", "updated"])
    assert (await client.get("/settings", headers=headers)).json() == settings
    [att] = (
        await client.get("/passwords/Bank ü%2Fü/attachments", headers=headers)
    ).json()
    download = await client.get(
        f"/passwords/Bank ü%2Fü/attachments/{att['id']}", headers=headers
    )
    assert download.content == binary


async def test_restoring_into_a_used_vault_merges_without_losing_anything(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post(
        "/passwords/create", json=entry("shared", "mine"), headers=headers
    )
    await client.post(
        "/passwords/shared/attachments",
        files={"file": ("mine.bin", b"mine", "x/y")},
        headers=headers,
    )
    await client.patch(
        "/settings",
        json={
            "inactivity_ms": 600_000,
            "warn_before_ms": 30_000,
            "hidden_ms": 60_000,
            "debounce_ms": 1_000,
            "clipboard_clear_ms": 30_000,
            "update_check_enabled": True,
        },
        headers=headers,
    )
    data = backup_file(
        [
            backup_entry("shared", "theirs"),
            backup_entry("new", "new-v"),
            backup_entry("old", "old-v", deleted="2026-03-03T03:03:03.000003+00:00"),
        ],
        settings={
            "inactivity_ms": 60_000,
            "warn_before_ms": 10_000,
            "hidden_ms": 60_000,
            "debounce_ms": 1_000,
            "clipboard_clear_ms": 30_000,
            "update_check_enabled": False,
        },
    )

    resp = await _import(client, headers, data)
    assert resp.json()["imported"] == 1
    assert resp.json()["skipped"] == 1
    assert resp.json()["trashed"] == 1
    assert resp.json()["settings_restored"] is False
    assert (await client.get("/passwords/shared", headers=headers)).json()[
        "password_value"
    ] == "mine"

    resp = await _import(client, headers, data, on_conflict="overwrite")
    assert resp.json()["overwritten"] == 2
    assert resp.json()["skipped"] == 1
    assert resp.json()["trashed"] == 0
    assert (await client.get("/passwords/shared", headers=headers)).json()[
        "password_value"
    ] == "theirs"
    trash = (await client.get("/passwords/trash", headers=headers)).json()
    by_value = {t["password_value"]: t for t in trash}
    assert set(by_value) == {"mine", "new-v", "old-v"}
    assert by_value["mine"]["attachment_count"] == 1
    assert (await client.get("/settings", headers=headers)).json()[
        "inactivity_ms"
    ] == 600_000


async def test_a_backup_from_another_vault_and_password_restores_with_that_password(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("from-a"), headers=headers)
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    resp = await client.patch(
        "/master_password/update",
        json={
            "master_password": MASTER_PASSWORD,
            "new_master_password": NEW_MASTER_PASSWORD,
        },
        headers=headers,
    )
    assert resp.status_code == 200
    from tests.support import unlock

    headers = auth(await unlock(client, NEW_MASTER_PASSWORD))
    await client.delete("/passwords/from-a", headers=headers)
    await client.delete("/passwords/from-a/purge", headers=headers)
    resp = await _import(client, headers, backup.content, NEW_MASTER_PASSWORD)
    assert resp.status_code == 403
    resp = await _import(client, headers, backup.content, MASTER_PASSWORD)
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 1


async def test_backup_requires_the_current_master_password(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    before = await db_snapshot()
    resp = await client.post(
        "/passwords/backup",
        json={"master_password": WRONG_MASTER_PASSWORD},
        headers=headers,
    )
    assert resp.status_code == 403
    assert await db_snapshot() == before


async def test_large_backups_spool_only_ciphertext_to_disk(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = auth(await create_vault(client))
    marker = b"Zq7SpoolCanary" * 1000
    for index in range(4):
        name = f"big-{index}"
        await client.post("/passwords/create", json=entry(name), headers=headers)
        resp = await client.post(
            f"/passwords/{name}/attachments",
            files={
                "file": (
                    f"{name}.bin",
                    marker + os.urandom(5 * MIB - len(marker)),
                    "x/y",
                )
            },
            headers=headers,
        )
        assert resp.status_code == 200
    spilled: list = []
    real = tempfile.TemporaryFile

    def recording(*args, **kwargs):
        handle = real(*args, **kwargs)
        spilled.append(handle)
        return handle

    monkeypatch.setattr(tempfile, "TemporaryFile", recording)
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    assert backup.status_code == 200
    assert len(backup.content) > 20 * MIB
    assert marker[:50] not in backup.content

    await db_execute("DELETE FROM entries")
    resp = await _import(client, headers, backup.content)
    assert resp.status_code == 200, resp.text
    assert resp.json()["attachments"] == 4
    assert spilled
    for handle in spilled:
        if handle.closed:
            continue
        handle.seek(0)
        assert marker[:50] not in handle.read()


async def test_backup_round_trips_attachments_above_desktop_ipc_frame_size(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    names = [f"large-files-{index}" for index in range(6)]
    contents = [os.urandom(5 * MIB) for _ in range(6)]
    for index, (name, content) in enumerate(zip(names, contents, strict=True)):
        await client.post("/passwords/create", json=entry(name), headers=headers)
        response = await client.post(
            f"/passwords/{name}/attachments",
            files={"file": (f"{index}.bin", content, "application/octet-stream")},
            headers=headers,
        )
        assert response.status_code == 200, response.text

    backup = await client.post(
        "/passwords/backup",
        json={"master_password": MASTER_PASSWORD},
        headers=headers,
    )
    assert backup.status_code == 200, backup.text
    assert len(backup.content) > 24 * MIB

    await db_execute("DELETE FROM entries")
    restored = await _import(client, headers, backup.content)
    assert restored.status_code == 200, restored.text
    assert restored.json()["attachments"] == len(contents)
    for name, expected in zip(names, contents, strict=True):
        [item] = (
            await client.get(f"/passwords/{name}/attachments", headers=headers)
        ).json()
        response = await client.get(
            f"/passwords/{name}/attachments/{item['id']}", headers=headers
        )
        assert response.content == expected


@pytest.mark.stress
async def test_many_entry_metadata_above_old_64_mib_manifest_round_trips(
    client: httpx.AsyncClient,
) -> None:
    from sqlalchemy import text

    from helpers import VaultKey

    headers = auth(await create_vault(client))
    key = VaultKey(await raw_vault_key())
    count = 1100
    value = "v" * (64 * 1024)
    history = [
        {"value": f"old-{n}-" + "h" * 512, "changed_at": "2026-01-01T00:00:00"}
        for n in range(10)
    ]
    statement = text(
        "INSERT INTO entries (uid, name_index, document, backed_up) "
        "VALUES (:uid, :name_index, :document, 0)"
    )
    async with engine.begin() as connection:
        for start in range(0, count, 100):
            batch = []
            for index in range(start, min(start + 100, count)):
                name = f"large-{index:04d}"
                document = {
                    "name": name,
                    "kind": "note" if index % 2 else "login",
                    "username": None,
                    "value": value,
                    "url": None,
                    "totp_secret": None,
                    "description": "representative secure note metadata",
                    "tags": ["review", "capacity"],
                    "custom_fields": [
                        {"label": "field", "value": "x" * 128, "hidden": True}
                    ],
                    "folder": "Research",
                    "favorite": bool(index % 2),
                    "history": history,
                }
                uid = os.urandom(16)
                batch.append(
                    {
                        "uid": uid,
                        "name_index": key.name_index(name),
                        "document": key.seal_entry(
                            uid, json.dumps(document, ensure_ascii=False).encode()
                        ),
                    }
                )
            await connection.execute(statement, batch)

    attachment_data = b"a" * (5 * MIB)
    for index in range(3):
        uploaded = await client.post(
            f"/passwords/large-{index:04d}/attachments",
            files={
                "file": (
                    f"large-{index}.bin",
                    attachment_data,
                    "application/octet-stream",
                )
            },
            headers=headers,
        )
        assert uploaded.status_code == 200, uploaded.text
    total_attachment_bytes = len(attachment_data) * 3

    started = time.perf_counter()
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    generated_seconds = time.perf_counter() - started
    assert backup.status_code == 200, backup.json()
    assert len(backup.content) > 64 * MIB
    backup_size = len(backup.content)
    reader = BackupReader(io.BytesIO(backup.content))
    backup_key = await helpers.backup_key_for(MASTER_PASSWORD, reader.header)
    envelope = reader.read(backup_key, 64 * MIB)
    metadata_bytes = 0
    authenticated_attachment_bytes = 0
    for _ in range(count):
        entry_doc = json.loads(reader.read(backup_key, 64 * MIB))
        metadata_bytes += len(json.dumps(entry_doc, ensure_ascii=False).encode())
        for attachment in entry_doc["attachments"]:
            content = reader.read(backup_key, 5 * MIB)
            assert len(content) == attachment["size"]
            authenticated_attachment_bytes += len(content)
    reader.finish()
    assert json.loads(envelope)["entries_count"] == count
    assert metadata_bytes > 64 * MIB
    assert authenticated_attachment_bytes == total_attachment_bytes

    await reset_vault()
    headers = auth(await create_vault(client))
    started = time.perf_counter()
    restored = await _import(client, headers, backup.content)
    restored_seconds = time.perf_counter() - started
    assert restored.status_code == 200, restored.text[:300]
    assert restored.json()["imported"] == count
    assert await db_execute("SELECT count(*) FROM entries") == [(count,)]
    for name in ("large-0000", f"large-{count - 1:04d}"):
        item = await client.get(f"/passwords/{name}", headers=headers)
        assert item.status_code == 200
        assert len(item.json()["password_value"]) == len(value)
        assert len(item.json()["password_history"]) == 10
    attachment_response = await client.get(
        "/passwords/large-0000/attachments", headers=headers
    )
    [attachment] = attachment_response.json()
    attachment_response = await client.get(
        f"/passwords/large-0000/attachments/{attachment['id']}", headers=headers
    )
    assert attachment_response.content == attachment_data
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(
        f"large-backup entries={count} metadata={metadata_bytes} "
        f"attachments={total_attachment_bytes} backup={backup_size} "
        f"generation={generated_seconds:.2f}s restore={restored_seconds:.2f}s "
        f"peak-rss-platform-units={peak_rss}"
    )


async def test_backup_generation_failure_closes_ciphertext_spool_and_releases_db(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import crud.backup

    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("saved"), headers=headers)
    before = await db_snapshot()
    handles = []
    real_spool = tempfile.SpooledTemporaryFile

    def tracked_spool(*args, **kwargs):
        handle = real_spool(*args, **kwargs)
        handles.append(handle)
        return handle

    def fail_write(self, plaintext):
        raise OSError("synthetic encrypted-spool failure")

    monkeypatch.setattr(crud.backup.tempfile, "SpooledTemporaryFile", tracked_spool)
    monkeypatch.setattr(crud.backup.BackupWriter, "write", fail_write)
    response = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    assert response.status_code == 500
    assert handles and all(handle.closed for handle in handles)
    assert engine.sync_engine.pool.checkedout() == 0
    assert await db_snapshot() == before
    monkeypatch.undo()
    write = await client.post("/passwords/create", json=entry("after"), headers=headers)
    assert write.status_code == 200


async def test_cancelling_backup_generation_closes_the_spool_and_changes_nothing(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import crud.backup

    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("saved"), headers=headers)
    before = await db_snapshot()
    handles = []
    entered = threading.Event()
    release = threading.Event()
    real_spool = tempfile.SpooledTemporaryFile
    real_write = crud.backup.BackupWriter.write

    def tracked_spool(*args, **kwargs):
        handle = real_spool(*args, **kwargs)
        handles.append(handle)
        return handle

    def blocked_write(self, plaintext):
        if not entered.is_set():
            entered.set()
            assert release.wait(5)
        return real_write(self, plaintext)

    monkeypatch.setattr(crud.backup.tempfile, "SpooledTemporaryFile", tracked_spool)
    monkeypatch.setattr(crud.backup.BackupWriter, "write", blocked_write)
    request = asyncio.create_task(
        client.post(
            "/passwords/backup",
            json={"master_password": MASTER_PASSWORD},
            headers=headers,
        )
    )
    assert await asyncio.to_thread(entered.wait, 5)
    request.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await request

    assert handles and all(handle.closed for handle in handles)
    assert engine.sync_engine.pool.checkedout() == 0
    assert await db_snapshot() == before
    monkeypatch.undo()
    assert (
        await client.post("/passwords/create", json=entry("after"), headers=headers)
    ).status_code == 200


@pytest.mark.parametrize("failure", ["send", "cancel"])
async def test_backup_response_closes_spool_after_send_failure_or_cancellation(
    failure: str,
) -> None:
    from starlette.requests import ClientDisconnect

    from api.endpoints.password import BackupResponse

    backup = tempfile.SpooledTemporaryFile(max_size=1)
    backup.write(b"ciphertext")
    backup.seek(0)
    response = BackupResponse(backup, "test.cmbackup")
    body_started = asyncio.Event()
    allow_send = asyncio.Event()

    async def receive():
        await asyncio.Future()

    async def send(message):
        if message["type"] == "http.response.body":
            body_started.set()
            await allow_send.wait()
            if failure == "send":
                raise OSError("synthetic client disconnect")

    scope = {"type": "http", "asgi": {"spec_version": "2.4"}}
    task = asyncio.create_task(response(scope, receive, send))
    await asyncio.wait_for(body_started.wait(), timeout=2)
    if failure == "cancel":
        task.cancel()
    else:
        allow_send.set()
    expected = asyncio.CancelledError if failure == "cancel" else ClientDisconnect
    with pytest.raises(expected):
        await task
    assert backup.closed


async def test_an_empty_vault_backs_up_and_restores(client: httpx.AsyncClient) -> None:
    headers = auth(await create_vault(client))
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    assert backup.status_code == 200
    resp = await _import(client, headers, backup.content)
    assert resp.status_code == 200
    assert resp.json()["total"] == 0
    assert resp.json()["settings_restored"] is True


_TEXT = st.text(
    alphabet=st.characters(blacklist_categories=("Cs",), blacklist_characters="\x00"),
    min_size=1,
    max_size=20,
)


@given(
    names=st.lists(_TEXT, min_size=1, max_size=4, unique=True),
    values=st.lists(_TEXT, min_size=4, max_size=4),
    blobs=st.lists(st.binary(min_size=1, max_size=600), max_size=3),
    trashed=st.booleans(),
)
async def test_any_vault_survives_a_backup_round_trip(
    client: httpx.AsyncClient,
    names: list[str],
    values: list[str],
    blobs: list[bytes],
    trashed: bool,
) -> None:
    await reset_vault()
    headers = auth(await create_vault(client))
    stored = [n.strip() for n in names if n.strip() not in ("", ".", "..", "trash")]
    stored = list(dict.fromkeys(stored))
    for index, name in enumerate(stored):
        resp = await client.post(
            "/passwords/create",
            json=entry(name, values[index], description=values[-1], tags=[values[0]]),
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
    if stored:
        target = quote(stored[0], safe="")
        for blob in blobs:
            resp = await client.post(
                f"/passwords/{target}/attachments",
                files={"file": ("b", blob, "x/y")},
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
        if trashed:
            await client.delete(f"/passwords/{target}", headers=headers)
    original = await read_current_vault()
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    await reset_vault()
    headers = auth(await create_vault(client))
    resp = await _import(client, headers, backup.content)
    assert resp.status_code == 200, resp.text
    assert_same_vault(
        original, await read_current_vault(), compare=[*PLAINTEXT, "created", "updated"]
    )


def _multipart(
    chunks: list[bytes], boundary: str = "cmbound", gate: asyncio.Event | None = None
):
    sent: list[int] = []

    async def body():
        yield (
            f"--{boundary}\r\nContent-Disposition: form-data; "
            f'name="master_password"\r\n\r\n{MASTER_PASSWORD}\r\n'
            f"--{boundary}\r\nContent-Disposition: form-data; "
            f'name="file"; filename="b.cmbackup"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        for index, chunk in enumerate(chunks):
            if gate is not None and index == 1:
                await gate.wait()
            sent.append(len(chunk))
            yield chunk
        yield f"\r\n--{boundary}--\r\n".encode()

    return body(), sent, f"multipart/form-data; boundary={boundary}"


async def test_an_upload_without_a_session_is_refused_before_its_body_is_read(
    client: httpx.AsyncClient,
) -> None:
    await create_vault(client)
    body, sent, content_type = _multipart([b"x" * MIB] * 64)
    resp = await client.post(
        "/passwords/import", content=body, headers={"content-type": content_type}
    )
    assert resp.status_code == 401
    assert sum(sent) <= MIB


async def test_a_backup_upload_takes_one_file_and_holds_no_lock_while_it_arrives(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    resp = await client.post(
        "/passwords/import",
        data={"master_password": MASTER_PASSWORD},
        files=[
            ("file", ("a.cmbackup", FROZEN, "x/y")),
            ("file", ("b.cmbackup", FROZEN, "x/y")),
        ],
        headers=headers,
    )
    assert resp.status_code == 400

    gate = asyncio.Event()
    data = backup_file([backup_entry("slow")])
    body, _, content_type = _multipart([data[:10], data[10:]], gate=gate)
    upload = asyncio.create_task(
        client.post(
            "/passwords/import",
            content=body,
            headers=[*headers, (b"content-type", content_type.encode())],
        )
    )
    await asyncio.sleep(0.3)
    during = await asyncio.wait_for(
        client.post("/passwords/create", json=entry("during"), headers=headers),
        timeout=5,
    )
    gate.set()
    assert during.status_code == 200, during.text
    assert (await upload).json()["imported"] == 1


@pytest.mark.parametrize(
    ("limit", "value"),
    [("MAX_ENTRY_FRAME_BYTES", 1024), ("MAX_BACKUP_BYTES", 4096)],
)
async def test_a_backup_the_reader_would_refuse_is_never_written(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    limit: str,
    value: int,
) -> None:
    import crud.backup

    headers = auth(await create_vault(client))
    await client.post(
        "/passwords/create", json=entry("big", "v" * 1500), headers=headers
    )
    await client.post(
        "/passwords/big/attachments",
        files={"file": ("a.bin", os.urandom(3000), "x/y")},
        headers=headers,
    )
    before = await db_snapshot()
    monkeypatch.setattr(crud.backup, limit, value)

    resp = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )

    assert resp.status_code == 400
    assert "backup" in resp.json()["detail"].lower()
    assert await db_snapshot() == before
    monkeypatch.undo()
    resp = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    assert resp.status_code == 200
