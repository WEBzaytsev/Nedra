import asyncio
import os
import secrets

import httpx
import pytest

from crud.master_password import MasterPasswordCRUD
from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    auth,
    create_vault,
    db_execute,
    db_snapshot,
    entry,
    plant_entry,
    read_current_vault,
    unlock,
)

ROTATE = {
    "master_password": MASTER_PASSWORD,
    "new_master_password": NEW_MASTER_PASSWORD,
}


async def test_method_and_path_variants_stay_protected(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    await client.post("/passwords/create", json=entry("alpha"), headers=auth(token))
    for forged, refused in ((auth(secrets.token_urlsafe(32)), 401),):
        for path in ("/passwords", "/passwords/alpha", "/settings"):
            resp = await client.head(path, headers=forged)
            assert resp.status_code in (refused, 405)
            assert resp.content == b""
        resp = await client.get("/passwords/", headers=forged, follow_redirects=True)
        assert resp.status_code == refused
        resp = await client.options("/passwords/alpha", headers=forged)
        assert resp.status_code in (refused, 405)
        assert "s3cret" not in resp.text


async def test_concurrent_rotations_with_the_same_key_apply_once(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    await client.post("/passwords/create", json=entry("one"), headers=auth(token))

    first, second = await asyncio.gather(
        client.patch("/master_password/update", json=ROTATE, headers=auth(token)),
        client.patch("/master_password/update", json=ROTATE, headers=auth(token)),
    )

    assert sorted([first.status_code, second.status_code]) == [200, 401]
    await unlock(client, NEW_MASTER_PASSWORD)
    assert len((await read_current_vault(NEW_MASTER_PASSWORD)).entries) == 1


async def test_write_burst_racing_a_rotation_never_corrupts_or_deadlocks(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    writes = [
        client.post("/passwords/create", json=entry(f"e{i}"), headers=auth(token))
        for i in range(20)
    ]
    rotation = client.patch("/master_password/update", json=ROTATE, headers=auth(token))

    responses = await asyncio.gather(*writes[:10], rotation, *writes[10:])

    statuses = [r.status_code for r in responses]
    assert 500 not in statuses, [r.text for r in responses if r.status_code == 500]
    assert responses[10].status_code == 200
    assert set(statuses) <= {200, 401}
    await unlock(client, NEW_MASTER_PASSWORD)
    created = sum(1 for r in responses if r.status_code == 200) - 1
    assert len((await read_current_vault(NEW_MASTER_PASSWORD)).entries) == created


async def test_a_damaged_row_is_isolated_reported_and_removable(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("good"), headers=headers)
    await client.post(
        "/passwords/good/attachments",
        files={"file": ("a.bin", b"kept", "x/y")},
        headers=headers,
    )
    planted = await plant_entry("planted", master_password=MASTER_PASSWORD)
    await db_execute(
        "UPDATE entries SET document = :document WHERE id = :id",
        document=b"\x02" + os.urandom(80),
        id=planted,
    )
    listing = await client.get("/passwords", headers=headers)
    assert listing.status_code == 200
    assert [p["password_name"] for p in listing.json()] == ["good"]
    damaged = await client.get("/vault/damaged", headers=headers)
    assert damaged.json() == {"entries": [planted], "attachments": []}

    rotated = await client.patch(
        "/master_password/update", json=ROTATE, headers=headers
    )
    assert rotated.status_code == 200, rotated.text
    headers = auth(await unlock(client, NEW_MASTER_PASSWORD))

    before = await db_snapshot()
    backup = await client.post(
        "/passwords/backup",
        json={"master_password": NEW_MASTER_PASSWORD},
        headers=headers,
    )
    assert backup.status_code == 500
    assert backup.json()["code"] == "vault_damaged"
    assert f"Entry #{planted}" in backup.json()["detail"]
    assert "nedra damaged" in backup.json()["detail"]
    [(good_id,)] = await db_execute(
        "SELECT id FROM entries WHERE id <> :id", id=planted
    )
    for kind, row_id, status in (
        ("entries", good_id, 400),
        ("attachments", 1, 400),
        ("entries", 999, 404),
    ):
        resp = await client.delete(f"/vault/damaged/{kind}/{row_id}", headers=headers)
        assert resp.status_code == status, resp.text
    assert await db_snapshot() == before

    resp = await client.delete(f"/vault/damaged/entries/{planted}", headers=headers)
    assert resp.status_code == 200
    assert (await client.get("/vault/damaged", headers=headers)).json() == {
        "entries": [],
        "attachments": [],
    }
    backup = await client.post(
        "/passwords/backup",
        json={"master_password": NEW_MASTER_PASSWORD},
        headers=headers,
    )
    assert backup.status_code == 200, backup.text


async def test_a_damaged_attachment_is_isolated_and_removable(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    await client.post("/passwords/create", json=entry("box"), headers=headers)
    for name in ("good.bin", "bad.bin"):
        await client.post(
            "/passwords/box/attachments",
            files={"file": (name, b"bytes of " + name.encode(), "x/y")},
            headers=headers,
        )
    await db_execute("UPDATE attachments SET size_bytes = 3 WHERE id = 2")
    listed = (await client.get("/passwords/box/attachments", headers=headers)).json()
    assert [a["filename"] for a in listed] == ["good.bin", "bad.bin"]
    resp = await client.get("/passwords/box/attachments/2", headers=headers)
    assert resp.status_code == 500
    await db_execute("UPDATE attachments SET meta = content WHERE id = 2")
    listed = (await client.get("/passwords/box/attachments", headers=headers)).json()
    assert [a["filename"] for a in listed] == ["good.bin"]
    damaged = (await client.get("/vault/damaged", headers=headers)).json()
    assert damaged == {"entries": [], "attachments": [2]}
    resp = await client.delete("/vault/damaged/attachments/2", headers=headers)
    assert resp.status_code == 200
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=headers
    )
    assert backup.status_code == 200


async def test_unauthenticated_bodies_are_bounded(client: httpx.AsyncClient) -> None:
    await create_vault(client)
    resp = await client.post(
        "/passwords/import/csv",
        content=b"x" * (13 * 1024 * 1024),
        headers={"content-type": "multipart/form-data; boundary=x"},
    )
    assert resp.status_code == 413


async def test_forged_credentials_never_wait_on_vault_locks(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    gate = asyncio.Event()
    original = MasterPasswordCRUD.update_master_password

    async def slow_rotation(self, *args, **kwargs):
        result = await original(self, *args, **kwargs)
        await gate.wait()
        return result

    monkeypatch.setattr(MasterPasswordCRUD, "update_master_password", slow_rotation)
    rotation = asyncio.create_task(
        client.patch("/master_password/update", json=ROTATE, headers=auth(token))
    )
    await asyncio.sleep(1.5)
    try:
        for forged, refused in ((auth(secrets.token_urlsafe(32)), 401),):
            resp = await asyncio.wait_for(
                client.get("/passwords", headers=forged), timeout=3
            )
            assert resp.status_code == refused
    finally:
        gate.set()
        assert (await rotation).status_code == 200
