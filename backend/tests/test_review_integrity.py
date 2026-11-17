"""Independent review regressions for damaged metadata and key derivations."""

import hashlib
import hmac
import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

import httpx
import pytest

import helpers
from storage import VAULT_FILE
from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    auth,
    create_vault,
    data_dir,
    db_execute,
    db_snapshot,
    entry,
    name_index,
)


def _hkdf_sha256(ikm: bytes, label: str) -> bytes:
    """RFC 5869 extract/expand, independently using only stdlib HMAC."""
    prk = hmac.digest(bytes(32), ikm, "sha256")
    return hmac.digest(prk, label.encode() + b"\x01", "sha256")


def test_frozen_derivations_against_independent_hmac_construction() -> None:
    vectors = json.loads(
        (Path(__file__).parents[2] / "testdata/vectors/vault-v2.json").read_text()
    )
    for vector in vectors["vaults"]:
        raw = bytes.fromhex(vector["vault_key_hex"])
        derived = bytes.fromhex(vector["derived_hex"])
        for field, key, label in (
            ("password_check_hex", derived, "ciphermoth/v2/password-commitment"),
            ("key_check_hex", raw, "ciphermoth/v2/key-check"),
            ("record_key_hex", raw, "ciphermoth/v2/record-encryption"),
        ):
            assert _hkdf_sha256(key, label).hex() == vector[field]
        index_key = _hkdf_sha256(raw, "ciphermoth/v2/name-index")
        vault = helpers.VaultKey(raw)
        for name in (" ", "same", "Same", "é", "e\u0301", "日本/🦋"):
            assert (
                vault.name_index(name)
                == hmac.new(index_key, name.encode(), hashlib.sha256).digest()
            )


async def test_password_rewrap_does_not_touch_orphan_attachment(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("kept"), headers=headers)
    uploaded = await client.post(
        "/passwords/kept/attachments",
        files={"file": ("recoverable.bin", b"recover me", "x/y")},
        headers=headers,
    )
    attachment_id = uploaded.json()["id"]
    with closing(sqlite3.connect(data_dir() / VAULT_FILE)) as unchecked:
        unchecked.execute("UPDATE attachments SET entry_id = 999")
        unchecked.commit()
    orphan_before = await db_execute(
        "SELECT entry_id, meta, content FROM attachments WHERE id = :id",
        id=attachment_id,
    )
    response = await client.patch(
        "/master_password/update",
        json={
            "master_password": MASTER_PASSWORD,
            "new_master_password": NEW_MASTER_PASSWORD,
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert (
        await db_execute(
            "SELECT entry_id, meta, content FROM attachments WHERE id = :id",
            id=attachment_id,
        )
        == orphan_before
    )
    assert (await client.get("/passwords/kept", headers=headers)).status_code == 401
    login = await client.post(
        "/master_password/unlock", json={"master_password": NEW_MASTER_PASSWORD}
    )
    fresh = auth(login.json()["session_token"])
    assert (await client.get("/passwords/kept", headers=fresh)).status_code == 200
    assert (await client.get("/vault/damaged", headers=fresh)).json() == {
        "entries": [],
        "attachments": [attachment_id],
    }


async def test_creation_refuses_orphan_attachments_without_a_key_record(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("kept"), headers=headers)
    await client.post(
        "/passwords/kept/attachments",
        files={"file": ("recoverable.bin", b"recover me", "x/y")},
        headers=headers,
    )
    with closing(sqlite3.connect(data_dir() / VAULT_FILE)) as unchecked:
        unchecked.execute("DELETE FROM entries")
        unchecked.execute("DELETE FROM vault")
        unchecked.commit()
    before = await db_snapshot()
    response = await client.post(
        "/master_password/create", json={"master_password": NEW_MASTER_PASSWORD}
    )
    assert response.status_code == 400
    assert await db_snapshot() == before


async def test_backup_capacity_is_enforced_before_a_vault_write_commits(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import crud.engine

    headers = auth(await create_vault(client))
    before = await db_snapshot()
    monkeypatch.setattr(crud.engine, "MAX_BACKUP_BYTES", 4096)
    response = await client.post(
        "/passwords/create", json=entry("capacity-check"), headers=headers
    )
    assert response.status_code == 400
    assert "backup capacity" in response.json()["detail"]
    assert await db_snapshot() == before


async def test_backup_frame_capacity_is_enforced_before_a_vault_write_commits(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import crud.engine

    headers = auth(await create_vault(client))
    before = await db_snapshot()
    monkeypatch.setattr(crud.engine, "MAX_FRAMES", 1)
    response = await client.post(
        "/passwords/create", json=entry("frame-capacity-check"), headers=headers
    )
    assert response.status_code == 400
    assert "frame limit" in response.json()["detail"]
    assert await db_snapshot() == before


async def test_backup_refuses_to_omit_a_damaged_entry(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("kept"), headers=headers)
    await db_execute("UPDATE entries SET document = x'00'")
    before = await db_snapshot()

    response = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )

    assert response.status_code == 500
    assert response.json()["code"] == "vault_damaged"
    assert await db_snapshot() == before
    assert (await client.get("/vault/damaged", headers=headers)).json() == {
        "entries": [1],
        "attachments": [],
    }


@pytest.mark.parametrize("mode", ["skip", "overwrite"])
async def test_csv_conflict_never_trusts_a_modified_blind_index(
    client: httpx.AsyncClient, mode: str
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("kept"), headers=headers)
    await db_execute("UPDATE entries SET name_index = :i", i=await name_index("other"))
    before = await db_snapshot()
    response = await client.post(
        "/passwords/import/csv",
        files={
            "file": ("entries.csv", b"name,password\nother,new-value\n", "text/csv")
        },
        data={"on_conflict": mode},
        headers=headers,
    )
    assert response.status_code == 500, response.text
    assert response.json()["code"] == "vault_damaged"
    assert await db_snapshot() == before


@pytest.mark.parametrize("column", ["created", "updated", "deleted"])
@pytest.mark.parametrize("value", ["not a timestamp", 42, b"\xff"])
async def test_invalid_entry_timestamp_is_isolated_and_intentionally_removable(
    client: httpx.AsyncClient, column: str, value: object
) -> None:
    headers = auth(await create_vault(client))
    for name in ("good", "damaged"):
        await client.post("/passwords/create", json=entry(name), headers=headers)
    await db_execute(f"UPDATE entries SET {column} = :v WHERE id = 2", v=value)
    before = await db_snapshot()
    for path in ("/passwords", "/passwords/trash"):
        response = await client.get(path, headers=headers)
        assert response.status_code == 200, response.text
        assert all(row["password_name"] == "good" for row in response.json())
    assert (await client.get("/vault/damaged", headers=headers)).json() == {
        "entries": [2],
        "attachments": [],
    }
    assert await db_snapshot() == before
    assert (
        await client.delete("/vault/damaged/entries/1", headers=headers)
    ).status_code == 400
    assert (
        await client.delete("/vault/damaged/entries/2", headers=headers)
    ).status_code == 200
    assert (await client.get("/passwords/good", headers=headers)).status_code == 200


async def test_invalid_attachment_timestamp_is_isolated_and_removable(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("good"), headers=headers)
    for name in ("healthy", "damaged"):
        await client.post(
            "/passwords/good/attachments",
            files={"file": (name, b"content", "x/y")},
            headers=headers,
        )
    await db_execute("UPDATE attachments SET created = 'invalid' WHERE id = 2")
    response = await client.get("/passwords/good/attachments", headers=headers)
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [1]
    assert (await client.get("/vault/damaged", headers=headers)).json() == {
        "entries": [],
        "attachments": [2],
    }
    assert (
        await client.delete("/vault/damaged/attachments/2", headers=headers)
    ).status_code == 200


@pytest.mark.parametrize("value", [100_000_000, "not ciphertext", b"short"])
async def test_invalid_wrapped_key_type_is_refused_before_kdf(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, value: object
) -> None:
    await create_vault(client)
    await db_execute("UPDATE vault SET wrapped_key = :v", v=value)
    before = await db_snapshot()

    def never(*args: object) -> bytes:
        raise AssertionError("KDF ran for an invalid key record")

    monkeypatch.setattr(helpers, "Argon2id", never)
    response = await client.post(
        "/master_password/unlock", json={"master_password": MASTER_PASSWORD}
    )
    assert response.status_code == 400
    assert await db_snapshot() == before


@pytest.mark.parametrize("value", ["65536", 65536.0, True, None])
def test_kdf_rejects_noninteger_parameters(value: Any) -> None:
    with pytest.raises(helpers.UnsupportedKdf):
        helpers.KdfParams(memory_kib=value).require_supported()


@pytest.mark.parametrize("action", ["restore", "purge"])
async def test_trash_action_selects_the_exact_id_and_never_a_namesake(
    client: httpx.AsyncClient, action: str
) -> None:
    headers = auth(await create_vault(client))
    for value in ("older", "newer"):
        await client.post(
            "/passwords/create", json=entry("same", value), headers=headers
        )
        await client.delete("/passwords/same", headers=headers)
    await client.post("/passwords/create", json=entry("different"), headers=headers)
    trash = (await client.get("/passwords/trash", headers=headers)).json()
    ids = {row["password_value"]: row["id"] for row in trash}
    call = client.post if action == "restore" else client.delete
    before = await db_snapshot()
    response = await call(
        f"/passwords/different/{action}",
        params={"entry_id": ids["older"]},
        headers=headers,
    )
    assert response.status_code == 404
    assert await db_snapshot() == before
    response = await call(
        f"/passwords/same/{action}",
        params={"entry_id": ids["older"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    trash = (await client.get("/passwords/trash", headers=headers)).json()
    assert [(row["id"], row["password_value"]) for row in trash] == [
        (ids["newer"], "newer")
    ]
    # A repeated action is stale: it may never fall back to the remaining row.
    before = await db_snapshot()
    response = await call(
        f"/passwords/same/{action}",
        params={"entry_id": ids["older"]},
        headers=headers,
    )
    assert response.status_code == 404
    assert await db_snapshot() == before
