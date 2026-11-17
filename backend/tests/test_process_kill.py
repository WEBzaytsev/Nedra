import asyncio
import base64
import hashlib
import os
import random
import signal
import sqlite3
import time
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager, closing
from pathlib import Path

import httpx
import pytest
from cryptography.exceptions import InvalidTag
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from crud.engine import Database
from storage import VAULT_FILE, check_file
from tests.integrity import VaultContents, assert_same_vault, raw_vault, read_vault
from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    ApiServer,
    api_server,
    backup_entry,
    backup_file,
    unwrap_vault_key,
)

ATTACHMENT_BYTES = 4 * 1024 * 1024


async def _seed(base_url: str, entries: int = 40, attachments: int = 1) -> str:
    async with httpx.AsyncClient(base_url=base_url, timeout=60) as http:
        resp = await http.post(
            "/master_password/create", json={"master_password": MASTER_PASSWORD}
        )
        headers = {"x-nedra-session": resp.json()["session_token"]}
        for i in range(entries):
            resp = await http.post(
                "/passwords/create",
                json={
                    "password_name": f"entry-{i:03d}",
                    "password_value": f"value-{i}",
                    "url": f"https://site-{i}.test",
                    "tags": ["a", "b"],
                },
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
        for i in range(attachments):
            resp = await http.post(
                "/passwords/entry-000/attachments",
                files={
                    "file": (
                        f"a{i}.bin",
                        os.urandom(ATTACHMENT_BYTES),
                        "application/octet-stream",
                    )
                },
                headers=headers,
            )
            assert resp.status_code == 200
        return headers["x-nedra-session"]


@asynccontextmanager
async def _connection(folder: Path) -> AsyncIterator[AsyncConnection]:
    database = Database(folder)
    try:
        async with database.engine.connect() as conn:
            yield conn
    finally:
        await database.dispose()


async def _state(folder: Path) -> tuple[dict, list]:
    async with _connection(folder) as conn:
        settings = await conn.execute(text("SELECT * FROM settings"))
        return await raw_vault(conn), [tuple(row) for row in settings]


async def _scan(folder: Path, key: str) -> VaultContents:
    async with _connection(folder) as conn:
        return await read_vault(conn, key)


def _vault_row(folder: Path) -> tuple:
    with closing(sqlite3.connect(folder / VAULT_FILE)) as connection:
        return connection.execute(
            "SELECT kdf_memory_kib, kdf_iterations, kdf_lanes, kdf_salt, wrapped_key "
            "FROM vault"
        ).fetchone()


def _key(folder: Path, password: str = MASTER_PASSWORD) -> str:
    return base64.urlsafe_b64encode(
        unwrap_vault_key(_vault_row(folder), password)
    ).decode()


def _opens(folder: Path, password: str) -> bool:
    try:
        unwrap_vault_key(_vault_row(folder), password)
    except InvalidTag:
        return False
    return True


def _kill(server: ApiServer) -> None:
    server.process.send_signal(signal.SIGKILL)
    server.process.wait(timeout=10)


def _wal_bytes(folder: Path) -> int:
    wal = folder / f"{VAULT_FILE}-wal"
    return wal.stat().st_size if wal.exists() else 0


def _checkpoint(folder: Path) -> None:
    with closing(sqlite3.connect(folder / VAULT_FILE)) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")


async def _kill_before_commit(
    tmp_path: Path, send: Callable[[httpx.AsyncClient, dict], Coroutine]
) -> int:
    """Send one write to a server that stops right before committing it, kill
    the server there, and return how many WAL bytes it had written."""
    folder = tmp_path / "vault"
    _checkpoint(folder)
    marker = tmp_path / "paused"
    with api_server(tmp_path / "paused.log", folder, pause_marker=marker) as server:
        async with httpx.AsyncClient(base_url=server.base_url, timeout=60) as http:
            resp = await http.post(
                "/master_password/unlock", json={"master_password": MASTER_PASSWORD}
            )
            headers = {"x-nedra-session": resp.json()["session_token"]}
            request = asyncio.create_task(send(http, headers))
            deadline = time.monotonic() + 60
            while not marker.exists():
                assert time.monotonic() < deadline, "the write never reached commit"
                assert not request.done(), request.result()
                await asyncio.sleep(0.02)
            written = _wal_bytes(folder)
            _kill(server)
            with pytest.raises(httpx.TransportError):
                await request
    return written


async def _seeded(tmp_path: Path, **sizes: int) -> Path:
    folder = tmp_path / "vault"
    with api_server(tmp_path / "seed.log", folder) as server:
        await _seed(server.base_url, **sizes)
    return folder


async def test_killing_the_server_before_a_rotation_commits_keeps_the_old_vault(
    tmp_path: Path,
) -> None:
    folder = await _seeded(tmp_path, attachments=3)
    key = _key(folder)
    before_state = await _state(folder)
    before = await _scan(folder, key)

    await _kill_before_commit(
        tmp_path,
        lambda http, headers: http.patch(
            "/master_password/update",
            json={
                "master_password": MASTER_PASSWORD,
                "new_master_password": NEW_MASTER_PASSWORD,
            },
            headers=headers,
        ),
    )

    assert check_file(folder / VAULT_FILE) == []
    assert await _state(folder) == before_state
    assert_same_vault(before, await _scan(folder, key))
    assert _opens(folder, MASTER_PASSWORD)
    assert not _opens(folder, NEW_MASTER_PASSWORD)


async def test_killing_the_server_before_an_import_commits_writes_nothing(
    tmp_path: Path,
) -> None:
    folder = await _seeded(tmp_path, entries=5)
    before = await _state(folder)
    rows = "\n".join(f"import-{i:04d},pass-{i}" for i in range(2000))
    csv = f"name,password\nentry-004,overwritten\n{rows}\n".encode()

    await _kill_before_commit(
        tmp_path,
        lambda http, headers: http.post(
            "/passwords/import/csv",
            data={"on_conflict": "overwrite"},
            files={"file": ("x.csv", csv, "text/csv")},
            headers=headers,
        ),
    )

    assert check_file(folder / VAULT_FILE) == []
    assert await _state(folder) == before


async def test_killing_the_server_before_a_backup_restore_commits_writes_nothing(
    tmp_path: Path,
) -> None:
    folder = await _seeded(tmp_path, entries=5)
    before = await _state(folder)
    content = os.urandom(ATTACHMENT_BYTES)
    restored = [
        backup_entry(
            f"restored-{i:03d}",
            attachments=[
                {
                    "filename": f"r{i}.bin",
                    "content_type": None,
                    "size": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "created": "2026-01-01T00:00:00+00:00",
                }
            ],
        )
        for i in range(2)
    ]
    archive = backup_file(
        [backup_entry("entry-004", "overwritten"), *restored],
        contents=[content, content],
    )

    written = await _kill_before_commit(
        tmp_path,
        lambda http, headers: http.post(
            "/passwords/import",
            data={"master_password": MASTER_PASSWORD, "on_conflict": "overwrite"},
            files={"file": ("b.cmbackup", archive, "application/octet-stream")},
            headers=headers,
        ),
    )

    assert written > ATTACHMENT_BYTES, "the restore never spilled into the WAL"
    assert check_file(folder / VAULT_FILE) == []
    assert await _state(folder) == before


@pytest.mark.stress
async def test_rotations_killed_at_random_points_are_all_or_nothing(
    tmp_path: Path,
) -> None:
    passwords = [MASTER_PASSWORD, NEW_MASTER_PASSWORD]
    rng = random.Random(1729)
    folder = await _seeded(tmp_path, entries=150, attachments=3)
    reference = await _scan(folder, _key(folder))
    current = 0
    outcomes = {"old": 0, "new": 0}

    for attempt in range(25):
        with api_server(tmp_path / f"server-{attempt}.log", folder) as server:
            async with httpx.AsyncClient(base_url=server.base_url, timeout=60) as http:
                resp = await http.post(
                    "/master_password/unlock",
                    json={"master_password": passwords[current]},
                )
                token = resp.json()["session_token"]
                request = asyncio.create_task(
                    http.patch(
                        "/master_password/update",
                        json={
                            "master_password": passwords[current],
                            "new_master_password": passwords[1 - current],
                        },
                        headers={"x-nedra-session": token},
                    )
                )
                await asyncio.sleep(rng.uniform(0.0, 2.5))
                _kill(server)
                try:
                    await request
                except httpx.TransportError:
                    pass

        assert check_file(folder / VAULT_FILE) == []
        if _opens(folder, passwords[1 - current]):
            current = 1 - current
            outcomes["new"] += 1
        else:
            assert _opens(folder, passwords[current])
            outcomes["old"] += 1
        assert_same_vault(
            reference, await _scan(folder, _key(folder, passwords[current]))
        )

    assert outcomes["old"] and outcomes["new"], outcomes
