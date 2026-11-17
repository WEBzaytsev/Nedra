import asyncio

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

import crud.backup
import crud.settings
import helpers
from crud.engine import Database, create_engine
from crud.password import PasswordCRUD
from main import app, get_application
from storage import VAULT_FILE, check_file
from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    auth,
    backup_entry,
    backup_file,
    create_vault,
    data_dir,
    db_execute,
    db_snapshot,
    engine,
    entry,
    read_current_vault,
    unlock,
    wait_for_queued_requests,
    write_lock_held,
)

ROTATE = {
    "master_password": MASTER_PASSWORD,
    "new_master_password": NEW_MASTER_PASSWORD,
}
OTHER_PASSWORD = "Moth-Other-Rotation-2028#"
GATE_SECONDS = 10


class FirstDerivationWaits:
    """Hold the first Argon2id derivation of the test until released (at most
    GATE_SECONDS, so a failing test cannot leave a request holding the vault),
    so a request can be stopped between its first transaction and its last."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0
        original = helpers.derive

        async def derive(
            password: str, salt: bytes, params: helpers.KdfParams = helpers.DEFAULT_KDF
        ) -> bytes:
            self.calls += 1
            if self.calls == 1:
                self.entered.set()
                await asyncio.wait_for(self.release.wait(), GATE_SECONDS)
            return await original(password, salt, params)

        monkeypatch.setattr(helpers, "derive", derive)


async def _decrypts(master_password: str) -> bool:
    await read_current_vault(master_password)
    return True


async def _names(client: httpx.AsyncClient, password: str) -> list[str]:
    resp = await client.get("/passwords", headers=auth(await unlock(client, password)))
    assert resp.status_code == 200, resp.text
    return [item["password_name"] for item in resp.json()]


async def test_an_unlock_overtaken_by_a_rotation_opens_no_session(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    await client.post("/passwords/create", json=entry("kept"), headers=auth(token))
    waits = FirstDerivationWaits(monkeypatch)

    stale = asyncio.create_task(
        client.post(
            "/master_password/unlock", json={"master_password": MASTER_PASSWORD}
        )
    )
    await waits.entered.wait()
    resp = await client.patch(
        "/master_password/update", json=ROTATE, headers=auth(token)
    )
    assert resp.status_code == 200, resp.text
    waits.release.set()
    resp = await stale

    assert resp.status_code == 200, resp.text
    assert resp.json()["valid"] is False
    assert resp.json()["session_token"] is None
    assert len(app.state.vault_sessions) == 0


@pytest.mark.parametrize("entries", [0, 3], ids=["empty", "populated"])
async def test_of_two_concurrent_rotations_only_the_first_applies(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, entries: int
) -> None:
    token = await create_vault(client)
    for i in range(entries):
        await client.post("/passwords/create", json=entry(f"e{i}"), headers=auth(token))
    other = await unlock(client)
    waits = FirstDerivationWaits(monkeypatch)

    late = asyncio.create_task(
        client.patch(
            "/master_password/update",
            json={
                "master_password": MASTER_PASSWORD,
                "new_master_password": OTHER_PASSWORD,
            },
            headers=auth(other),
        )
    )
    await waits.entered.wait()
    first = await client.patch(
        "/master_password/update", json=ROTATE, headers=auth(token)
    )
    waits.release.set()
    late_resp = await late

    assert first.status_code == 200, first.text
    assert late_resp.status_code == 401, late_resp.text
    assert late_resp.json()["code"] == "invalid_session"
    assert await _decrypts(NEW_MASTER_PASSWORD)
    resp = await client.post(
        "/master_password/unlock", json={"master_password": OTHER_PASSWORD}
    )
    assert resp.json()["valid"] is False
    assert await _names(client, NEW_MASTER_PASSWORD) == [
        f"e{i}" for i in range(entries)
    ]


async def test_writes_go_on_while_a_rotation_derives_its_keys(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    writer = await unlock(client)
    waits = FirstDerivationWaits(monkeypatch)

    rotation = asyncio.create_task(
        client.patch("/master_password/update", json=ROTATE, headers=auth(token))
    )
    await waits.entered.wait()
    try:
        during = await asyncio.wait_for(
            client.post(
                "/passwords/create",
                json=entry("during", "written-During-1"),
                headers=auth(writer),
            ),
            timeout=5,
        )
    finally:
        waits.release.set()
        rotated = await rotation

    assert during.status_code == 200, during.text
    assert rotated.status_code == 200
    resp = await client.get(
        "/passwords/during", headers=auth(await unlock(client, NEW_MASTER_PASSWORD))
    )
    assert resp.json()["password_value"] == "written-During-1"
    assert await _decrypts(NEW_MASTER_PASSWORD)


async def test_a_rotation_whose_final_commit_fails_changes_nothing(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    await client.post("/passwords/create", json=entry("kept"), headers=auth(token))
    before = await db_snapshot()
    original = AsyncSession.commit
    calls = 0

    async def commit(self: AsyncSession) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("the final commit failed")
        await original(self)

    monkeypatch.setattr(AsyncSession, "commit", commit)
    resp = await client.patch(
        "/master_password/update", json=ROTATE, headers=auth(token)
    )
    monkeypatch.undo()

    assert calls == 2
    assert resp.status_code == 500
    assert await db_snapshot() == before
    assert (await client.get("/passwords", headers=auth(token))).status_code == 200
    assert await _names(client, MASTER_PASSWORD) == ["kept"]


async def test_writes_go_on_while_a_backup_checks_the_master_password(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    waits = FirstDerivationWaits(monkeypatch)

    backup = asyncio.create_task(
        client.post(
            "/passwords/backup",
            json={"master_password": MASTER_PASSWORD},
            headers=auth(token),
        )
    )
    await waits.entered.wait()
    try:
        during = await asyncio.wait_for(
            client.post("/passwords/create", json=entry("during"), headers=auth(token)),
            timeout=5,
        )
    finally:
        waits.release.set()
        backed_up = await backup

    assert during.status_code == 200, during.text
    assert backed_up.status_code == 200


async def test_backup_generation_does_not_block_event_loop_or_hold_writer_lock(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    headers = auth(token)
    for index in range(4):
        name = f"large-{index}"
        assert (
            await client.post("/passwords/create", json=entry(name), headers=headers)
        ).status_code == 200
        assert (
            await client.post(
                f"/passwords/{name}/attachments",
                files={"file": ("large.bin", b"x" * (5 * 1024 * 1024), "x/y")},
                headers=headers,
            )
        ).status_code == 200

    entered = asyncio.Event()
    release = asyncio.Event()
    original = crud.backup._work

    async def gated(function, *args):
        if not entered.is_set():
            entered.set()
            await release.wait()
        return await original(function, *args)

    monkeypatch.setattr(crud.backup, "_work", gated)
    before = await db_snapshot()
    backup = asyncio.create_task(
        client.post(
            "/passwords/backup",
            json={"master_password": MASTER_PASSWORD},
            headers=headers,
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), timeout=10)
        write = await asyncio.wait_for(
            client.post(
                "/passwords/create", json=entry("during-backup"), headers=headers
            ),
            timeout=5,
        )
    finally:
        release.set()
    response = await backup

    assert write.status_code == 200, write.text
    assert response.status_code == 200, response.text
    assert len(response.content) > 19 * 1024 * 1024
    assert await db_snapshot() != before


async def test_an_import_overtaken_by_a_rotation_writes_nothing(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    await client.post("/passwords/create", json=entry("kept"), headers=auth(token))
    importer = await unlock(client)
    waits = FirstDerivationWaits(monkeypatch)

    imported = asyncio.create_task(
        client.post(
            "/passwords/import",
            data={"master_password": MASTER_PASSWORD, "on_conflict": "skip"},
            files={
                "file": (
                    "b.cmbackup",
                    backup_file([backup_entry("late", "late-Value-1")]),
                    "application/octet-stream",
                )
            },
            headers=auth(importer),
        )
    )
    await waits.entered.wait()
    rotated = await client.patch(
        "/master_password/update", json=ROTATE, headers=auth(token)
    )
    waits.release.set()
    resp = await imported

    assert rotated.status_code == 200, rotated.text
    assert resp.status_code == 401, resp.text
    assert resp.json()["code"] == "invalid_session"
    assert await _decrypts(NEW_MASTER_PASSWORD)
    assert await _names(client, NEW_MASTER_PASSWORD) == ["kept"]


@pytest.mark.parametrize("held", [1, 2], ids=["password-check", "backup-key"])
async def test_a_backup_overtaken_by_a_rotation_is_refused(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, held: int
) -> None:
    token = await create_vault(client)
    await client.post("/passwords/create", json=entry("kept"), headers=auth(token))
    backer = await unlock(client)
    entered, release = asyncio.Event(), asyncio.Event()
    original = helpers.derive
    calls = 0

    async def derive(
        password: str, salt: bytes, params: helpers.KdfParams = helpers.DEFAULT_KDF
    ) -> bytes:
        nonlocal calls
        calls += 1
        if calls == held:
            entered.set()
            await asyncio.wait_for(release.wait(), GATE_SECONDS)
        return await original(password, salt, params)

    monkeypatch.setattr(helpers, "derive", derive)
    backup = asyncio.create_task(
        client.post(
            "/passwords/backup",
            json={"master_password": MASTER_PASSWORD},
            headers=auth(backer),
        )
    )
    await entered.wait()
    rotated = await client.patch(
        "/master_password/update", json=ROTATE, headers=auth(token)
    )
    release.set()
    resp = await backup

    assert rotated.status_code == 200, rotated.text
    assert resp.status_code == 401, resp.text
    assert resp.json()["code"] == "invalid_session"
    assert not resp.content.startswith(b"CMBACKUP")
    assert await _decrypts(NEW_MASTER_PASSWORD)


async def test_a_session_opened_after_the_rotation_ended_all_sessions_is_refused(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    await client.post("/passwords/create", json=entry("kept"), headers=auth(token))
    entered, release = asyncio.Event(), asyncio.Event()
    original = crud.settings.SettingsCRUD.inactivity_ms
    calls = 0

    async def inactivity_ms(self) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await asyncio.wait_for(release.wait(), GATE_SECONDS)
        return await original(self)

    monkeypatch.setattr(crud.settings.SettingsCRUD, "inactivity_ms", inactivity_ms)
    overlapping = asyncio.create_task(
        client.post(
            "/master_password/unlock", json={"master_password": MASTER_PASSWORD}
        )
    )
    await entered.wait()
    rotated = await client.patch(
        "/master_password/update", json=ROTATE, headers=auth(token)
    )
    release.set()
    resp = await overlapping

    assert rotated.status_code == 200, rotated.text
    assert resp.json()["valid"] is True
    stale = auth(resp.json()["session_token"])
    attempts = [
        client.get("/passwords", headers=stale),
        client.get("/passwords/kept", headers=stale),
        client.post("/passwords/create", json=entry("stale"), headers=stale),
        client.patch("/settings", json={}, headers=stale),
        client.post("/master_password/session", headers=stale),
        client.patch("/master_password/update", json=ROTATE, headers=stale),
    ]
    for attempt in attempts:
        assert (await attempt).status_code == 401
    assert len(app.state.vault_sessions) == 0
    assert await _decrypts(NEW_MASTER_PASSWORD)
    assert await _names(client, NEW_MASTER_PASSWORD) == ["kept"]


async def test_of_two_racing_vault_creations_only_one_initializes_the_vault(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    waits = FirstDerivationWaits(monkeypatch)
    first = asyncio.create_task(
        client.post(
            "/master_password/create", json={"master_password": MASTER_PASSWORD}
        )
    )
    await waits.entered.wait()
    second = await client.post(
        "/master_password/create", json={"master_password": NEW_MASTER_PASSWORD}
    )
    waits.release.set()
    resp = await first

    assert second.status_code == 200, second.text
    assert resp.status_code == 403, resp.text
    assert "session_token" not in resp.text
    assert await db_execute("SELECT count(*) FROM vault") == [(1,)]
    assert len(app.state.vault_sessions) == 1
    assert await _names(client, NEW_MASTER_PASSWORD) == []
    resp = await client.post(
        "/master_password/unlock", json={"master_password": MASTER_PASSWORD}
    )
    assert resp.json()["valid"] is False


async def test_a_request_that_cannot_get_a_connection_is_a_clean_503(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    engine = create_engine(
        data_dir() / VAULT_FILE, pool_size=1, max_overflow=0, pool_timeout=0.5
    )
    narrow = get_application(database=Database(data_dir(), engine=engine))
    narrow.state.vault_sessions = app.state.vault_sessions
    before = await db_snapshot()
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=narrow), base_url="http://testserver/api"
        ) as other:
            with write_lock_held():
                waiting = asyncio.create_task(
                    other.post(
                        "/passwords/create", json=entry("a"), headers=auth(token)
                    )
                )
                await asyncio.sleep(0.3)
                starved = await other.post(
                    "/passwords/create", json=entry("b"), headers=auth(token)
                )
            await waiting
    finally:
        await engine.dispose()

    assert starved.status_code == 503, starved.text
    assert starved.json()["code"] == "busy"
    assert await db_snapshot() != before
    assert [e.name for e in (await read_current_vault()).entries] == ["a"]


async def test_cancelled_writes_leave_the_vault_consistent_and_unlocked(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await create_vault(client)
    before = await db_snapshot()
    for attempt in range(20):
        with write_lock_held():
            queued = asyncio.create_task(
                client.post(
                    "/passwords/create",
                    json=entry(f"queued-{attempt}"),
                    headers=auth(token),
                )
            )
            await wait_for_queued_requests(1)
            queued.cancel()
        with pytest.raises(asyncio.CancelledError):
            await queued
    assert engine.sync_engine.pool.checkedout() == 0

    written, release = asyncio.Event(), asyncio.Event()
    original = PasswordCRUD.create_password

    async def create_then_wait(self, password, key):
        result = await original(self, password, key)
        written.set()
        await asyncio.wait_for(release.wait(), GATE_SECONDS)
        return result

    monkeypatch.setattr(PasswordCRUD, "create_password", create_then_wait)
    halfway = asyncio.create_task(
        client.post("/passwords/create", json=entry("halfway"), headers=auth(token))
    )
    await written.wait()
    halfway.cancel()
    with pytest.raises(asyncio.CancelledError):
        await halfway
    monkeypatch.undo()

    assert await db_snapshot() == before
    resp = await asyncio.wait_for(
        client.post("/passwords/create", json=entry("after"), headers=auth(token)),
        timeout=5,
    )
    assert resp.status_code == 200, resp.text
    assert check_file(data_dir() / VAULT_FILE) == []
