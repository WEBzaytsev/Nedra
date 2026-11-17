import asyncio
import base64
import hmac
import json
import os

import httpx
import pytest

from crud.master_password import MasterPasswordCRUD
from crud.password import PasswordCRUD
from main import app
from tests.integrity import hkdf, raw_key_bytes, read_vault
from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    WRONG_MASTER_PASSWORD,
    Headers,
    auth,
    create_vault,
    db_execute,
    db_snapshot,
    engine,
    entry,
    read_current_vault,
    retired_key_header,
    stored_vault_key,
    unlock,
)

ROTATE = {
    "master_password": MASTER_PASSWORD,
    "new_master_password": NEW_MASTER_PASSWORD,
}


async def _key_check() -> bytes | None:
    rows = await db_execute("SELECT key_check FROM vault")
    assert len(rows) == 1
    return rows[0][0]


async def _accepts(key: str) -> bool:
    expected = hkdf(raw_key_bytes(key), "ciphermoth/v2/key-check")
    return hmac.compare_digest(expected, await _key_check() or b"")


async def _sealed_values() -> int:
    [(entries,)] = await db_execute("SELECT count(*) FROM entries")
    [(attachments,)] = await db_execute("SELECT count(*) FROM attachments")
    return entries + 2 * attachments


async def _failures(key: str) -> int:
    async with engine.connect() as conn:
        vault = await read_vault(conn, key, strict=False)
    return sum(1 for p in vault.problems if p.reason == "does not authenticate")


def _random_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


async def test_create_stores_a_key_check_for_the_vault_key(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    assert await _accepts(await stored_vault_key())
    resp = await client.get("/passwords", headers=auth(token))
    assert resp.status_code == 200
    assert resp.json() == []


async def test_concurrent_creates_produce_exactly_one_vault(
    client: httpx.AsyncClient,
) -> None:
    passwords = [f"Concurrent-Vault-{i}-Pass!" for i in range(4)]
    responses = await asyncio.gather(
        *(
            client.post("/master_password/create", json={"master_password": pw})
            for pw in passwords
        )
    )

    statuses = sorted(r.status_code for r in responses)
    assert statuses == [200, 403, 403, 403]
    assert len(await db_execute("SELECT id FROM vault")) == 1

    winner = next(r for r in responses if r.status_code == 200)
    winning_password = passwords[responses.index(winner)]
    assert "key_derivation" not in winner.json()
    assert await _accepts(await stored_vault_key(winning_password))
    token = await unlock(client, winning_password)
    resp = await client.get("/passwords", headers=auth(token))
    assert resp.status_code == 200


async def _seed_everything(client: httpx.AsyncClient, headers: Headers) -> bytes:
    items = [
        entry(
            "full",
            "first-Value-1",
            username="moth@example.com",
            url="https://example.com",
            totp_secret="otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
            description="plain description",
            tags=["work", "ops"],
            custom_fields=[
                {"label": "PIN", "value": "1234", "hidden": True},
                {"label": "Note", "value": "visible", "hidden": False},
            ],
            folder="Banking",
            favorite=True,
        ),
        entry("note", "  body with spaces\n\n", kind="note"),
        entry("trashed", "trashed-Value-1", folder="Old"),
    ]
    for item in items:
        resp = await client.post("/passwords/create", json=item, headers=headers)
        assert resp.status_code == 200, resp.text

    first = items[0]
    for value in ("second-Value-2", "third-Value-3"):
        resp = await client.patch(
            "/passwords/update",
            json={
                "password": first,
                "new_password": {**first, "password_value": value},
            },
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        first = {**first, "password_value": value}

    blob = os.urandom(256 * 1024) + b"\xff\xfe\x00"
    resp = await client.post(
        "/passwords/full/attachments",
        files={"file": ("Preț ünïcode.bin", blob, "application/x-test")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        "/passwords/trashed/attachments",
        files={"file": ("old.txt", b"trashed attachment", "text/plain")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    resp = await client.delete("/passwords/trashed", headers=headers)
    assert resp.status_code == 200
    return blob


async def _readable_state(client: httpx.AsyncClient, headers: Headers) -> dict:
    active = await client.get("/passwords", headers=headers)
    trash = await client.get("/passwords/trash", headers=headers)
    attachments = await client.get("/passwords/full/attachments", headers=headers)
    assert active.status_code == trash.status_code == attachments.status_code == 200
    downloads = {}
    for att in attachments.json():
        resp = await client.get(
            f"/passwords/full/attachments/{att['id']}", headers=headers
        )
        assert resp.status_code == 200
        downloads[att["filename"]] = resp.content
    strip = {"updated", "backed_up"}
    return {
        "active": [
            {k: v for k, v in p.items() if k not in strip} for p in active.json()
        ],
        "trash": [{k: v for k, v in p.items() if k not in strip} for p in trash.json()],
        "attachments": attachments.json(),
        "downloads": downloads,
    }


async def test_password_change_rewraps_the_same_key_and_revokes_old_sessions(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    old_key = await stored_vault_key()
    blob = await _seed_everything(client, auth(token))
    before = await _readable_state(client, auth(token))
    ciphertext_before = (
        await db_execute("SELECT id, document FROM entries ORDER BY id"),
        await db_execute("SELECT id, meta, content FROM attachments ORDER BY id"),
    )
    assert before["downloads"]["Preț ünïcode.bin"] == blob
    assert len(before["active"][0]["password_history"]) == 2

    resp = await client.patch(
        "/master_password/update", json=ROTATE, headers=auth(token)
    )
    assert resp.status_code == 200, resp.text

    resp = await client.post(
        "/master_password/unlock", json={"master_password": MASTER_PASSWORD}
    )
    assert resp.json()["valid"] is False
    fresh = await unlock(client, NEW_MASTER_PASSWORD)
    new_key = await stored_vault_key(NEW_MASTER_PASSWORD)
    assert new_key == old_key
    assert await _accepts(new_key)
    assert await _accepts(old_key)

    assert (await client.get("/passwords", headers=auth(token))).status_code == 401
    assert await _readable_state(client, auth(fresh)) == before

    assert await _sealed_values() > 0
    assert await _failures(new_key) == 0
    assert await _failures(old_key) == 0
    assert ciphertext_before == (
        await db_execute("SELECT id, document FROM entries ORDER BY id"),
        await db_execute("SELECT id, meta, content FROM attachments ORDER BY id"),
    )


async def test_rotation_with_wrong_current_password_changes_nothing(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    await _seed_everything(client, auth(token))
    before = await db_snapshot()

    resp = await client.patch(
        "/master_password/update",
        json={**ROTATE, "master_password": WRONG_MASTER_PASSWORD},
        headers=auth(token),
    )
    assert resp.status_code == 403
    assert await db_snapshot() == before
    assert (await client.get("/passwords", headers=auth(token))).status_code == 200
    await unlock(client)


@pytest.mark.parametrize("header_key", ["real", "other"])
async def test_rotation_carrying_a_vault_key_header_changes_nothing(
    client: httpx.AsyncClient, header_key: str
) -> None:
    token = await create_vault(client)
    await _seed_everything(client, auth(token))
    key = await stored_vault_key() if header_key == "real" else _random_key()
    before = await db_snapshot()

    resp = await client.patch(
        "/master_password/update",
        json=ROTATE,
        headers=auth(token) + retired_key_header(key),
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "invalid_key"
    assert key not in resp.text
    assert await db_snapshot() == before
    assert (await client.get("/passwords", headers=auth(token))).status_code == 200


async def test_write_in_flight_during_rotation_is_reencrypted(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    gate = asyncio.Event()
    original = PasswordCRUD.create_password

    async def slow_create(self, password, key):
        result = await original(self, password, key)
        await gate.wait()
        return result

    monkeypatch.setattr(PasswordCRUD, "create_password", slow_create)

    create = asyncio.create_task(
        client.post("/passwords/create", json=entry("racer"), headers=auth(token))
    )
    await asyncio.sleep(0.3)
    rotate = asyncio.create_task(
        client.patch("/master_password/update", json=ROTATE, headers=auth(token))
    )
    await asyncio.sleep(1.5)
    gate.set()
    create_resp, rotate_resp = await asyncio.gather(create, rotate)

    assert create_resp.status_code == 200, create_resp.text
    assert rotate_resp.status_code == 200, rotate_resp.text
    fresh = await unlock(client, NEW_MASTER_PASSWORD)
    new_key = await stored_vault_key(NEW_MASTER_PASSWORD)
    assert await _failures(new_key) == 0
    resp = await client.get("/passwords/racer", headers=auth(fresh))
    assert resp.status_code == 200
    assert resp.json()["password_value"] == "s3cret-Value!"


async def test_write_queued_behind_rotation_is_rejected(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    other = await unlock(client)
    resp = await client.post(
        "/passwords/create", json=entry("existing"), headers=auth(token)
    )
    assert resp.status_code == 200
    gate = asyncio.Event()
    original = MasterPasswordCRUD.update_master_password

    async def slow_rotation(self, *args, **kwargs):
        result = await original(self, *args, **kwargs)
        await gate.wait()
        return result

    monkeypatch.setattr(MasterPasswordCRUD, "update_master_password", slow_rotation)

    rotate = asyncio.create_task(
        client.patch("/master_password/update", json=ROTATE, headers=auth(token))
    )
    await asyncio.sleep(1.5)
    create = asyncio.create_task(
        client.post("/passwords/create", json=entry("late"), headers=auth(other))
    )
    await asyncio.sleep(0.5)
    gate.set()
    rotate_resp, create_resp = await asyncio.gather(rotate, create)

    assert rotate_resp.status_code == 200, rotate_resp.text
    assert create_resp.status_code == 401, create_resp.text
    vault = await read_current_vault(NEW_MASTER_PASSWORD)
    assert [e.name for e in vault.entries] == ["existing"]


async def test_backup_and_import_still_require_the_master_password(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    resp = await client.post(
        "/passwords/backup",
        json={"master_password": WRONG_MASTER_PASSWORD},
        headers=auth(token),
    )
    assert resp.status_code == 403
    assert "code" not in resp.json()


async def test_key_check_never_appears_in_api_responses(
    client: httpx.AsyncClient,
) -> None:
    session_token = await create_vault(client)
    token = await _key_check()
    assert token is not None
    for path in ("/master_password/status", "/settings", "/passwords"):
        resp = await client.get(path, headers=auth(session_token))
        assert token.hex() not in resp.text
        assert base64.b64encode(token).decode() not in resp.text
        assert "key_check" not in json.dumps(resp.json())


@pytest.mark.parametrize("damage", ["foreign key", "zeroed check"])
async def test_a_damaged_key_check_fails_closed_and_is_never_rewritten(
    client: httpx.AsyncClient, damage: str
) -> None:
    token = await create_vault(client)
    resp = await client.post(
        "/passwords/create", json=entry("kept"), headers=auth(token)
    )
    assert resp.status_code == 200
    if damage == "foreign key":
        damaged = hkdf(os.urandom(32), "ciphermoth/v2/key-check")
    else:
        damaged = bytes(32)
    password = MASTER_PASSWORD
    await db_execute("UPDATE vault SET key_check = :token", token=damaged)
    before = await db_snapshot()

    resp = await client.get("/passwords", headers=auth(token))
    assert resp.status_code == 401
    assert resp.json()["code"] == "invalid_session"
    resp = await client.post(
        "/master_password/unlock", json={"master_password": WRONG_MASTER_PASSWORD}
    )
    assert resp.json()["valid"] is False
    resp = await client.post(
        "/master_password/unlock", json={"master_password": password}
    )
    assert resp.status_code == 400
    assert "damaged" in resp.json()["detail"]
    assert "session_token" not in resp.text
    assert len(app.state.vault_sessions) == 0
    assert await db_snapshot() == before
