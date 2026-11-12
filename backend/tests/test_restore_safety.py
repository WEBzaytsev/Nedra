import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import httpx
import pytest

import storage
from storage import RESTORING_SUFFIX, VAULT_FILE, StorageError, check_file
from tests.support import (
    BACKEND_DIR,
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    auth,
    client_for_data_dir,
    corrupt_name_index,
    crash_after_committing,
    create_vault,
    entry,
    unlock,
)

ATTACHMENT = os.urandom(300_000)
SETTINGS = {
    "inactivity_ms": 300_000,
    "warn_before_ms": 30_000,
    "hidden_ms": 90_000,
    "debounce_ms": 500,
    "clipboard_clear_ms": 15_000,
    "update_check_enabled": False,
}

CRASH_SCRIPT = r"""
import os, shutil, sys
from pathlib import Path

import storage

limit = int(sys.argv[3])
events = 0


def event():
    global events
    events += 1
    if events == limit:
        os._exit(9)


def after(function):
    def wrapped(*args, **kwargs):
        result = function(*args, **kwargs)
        event()
        return result

    return wrapped


storage._fsync = after(storage._fsync)
storage._fsync_dir = after(storage._fsync_dir)
os.replace = after(os.replace)
shutil.copyfile = after(shutil.copyfile)


class Watched:
    def __init__(self, connection):
        self._connection = connection

    def execute(self, sql, *args):
        result = self._connection.execute(sql, *args)
        if sql.startswith(("PRAGMA wal_checkpoint", "PRAGMA journal_mode")):
            event()
        return result

    def __getattr__(self, name):
        return getattr(self._connection, name)


take = storage._take_exclusively


def watched(live):
    connection = take(live)
    return None if connection is None else Watched(connection)


storage._take_exclusively = watched
storage.restore(Path(sys.argv[1]), Path(sys.argv[2]))
print(events)
"""

LIMITED_SCRIPT = r"""
import resource, signal, sys
from pathlib import Path

import storage

signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
resource.setrlimit(resource.RLIMIT_FSIZE, (int(sys.argv[3]), int(sys.argv[3])))
try:
    if sys.argv[1] == "snapshot":
        storage.snapshot(Path(sys.argv[2]))
    else:
        storage.restore(Path(sys.argv[2]), Path(sys.argv[4]))
except storage.StorageError as error:
    print(error)
    sys.exit(3)
"""


def _run(script: str, *args: object) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", script, *map(str, args)],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _content(database: Path) -> tuple:
    """What a vault holds, read from a private copy so the vault's own files
    (and their WAL) are never touched."""
    with closing(_private_copy(database)) as connection:
        names = connection.execute(
            "SELECT uid, deleted IS NOT NULL FROM entries ORDER BY id"
        ).fetchall()
        hidden = connection.execute("SELECT hidden_ms FROM settings").fetchone()
        attachments = connection.execute(
            "SELECT count(*), sum(size_bytes) FROM attachments"
        ).fetchone()
        key_check = connection.execute("SELECT key_check FROM vault").fetchone()
    return tuple(names), hidden, attachments, key_check


def _private_copy(database: Path) -> sqlite3.Connection:
    scratch = database.parent.parent / f"read-{os.urandom(4).hex()}"
    scratch.mkdir()
    for suffix in ("", "-wal"):
        source = database.with_name(database.name + suffix)
        if source.exists():
            shutil.copyfile(source, scratch / f"{VAULT_FILE}{suffix}")
    unfolded = database.with_name(f"{database.name}-wal.unfolded")
    if unfolded.exists() and unfolded.stat().st_size:
        shutil.copyfile(unfolded, scratch / f"{VAULT_FILE}-wal")
    return sqlite3.connect(scratch / VAULT_FILE)


def _kept(folder: Path) -> list[Path]:
    return sorted(
        path / VAULT_FILE
        for path in (folder / "snapshots").glob("replaced-*")
        if path.is_dir()
    )


def _raw(folder: Path) -> dict[str, bytes]:
    return {
        path.name: path.read_bytes()
        for path in folder.glob(f"{VAULT_FILE}*")
        if not path.name.endswith("-shm")
    }


async def _rich_vault(client: httpx.AsyncClient) -> str:
    token = await create_vault(client)
    headers = auth(token)
    for item in (
        entry("github", "gh-Value-1", url="https://github.com", tags=["dev"]),
        entry("wifi", "line one\nline two\n", kind="note"),
        entry("trashed"),
    ):
        assert (
            await client.post("/passwords/create", json=item, headers=headers)
        ).is_success
    assert (await client.delete("/passwords/trashed", headers=headers)).is_success
    resp = await client.patch(
        "/passwords/update",
        json={
            "password": entry("github", "gh-Value-1"),
            "new_password": entry("github", "gh-Value-2", url="https://github.com"),
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        "/passwords/github/attachments",
        files={"file": ("codes.bin", ATTACHMENT, "application/octet-stream")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert (await client.patch("/settings", json=SETTINGS, headers=headers)).is_success
    return token


async def _scenario(base: Path, *, damaged: bool = False) -> tuple[Path, Path]:
    """A vault, a snapshot of it, then later changes, the last one committed only
    to the WAL by a process that died before checkpointing."""
    folder = base / "template"
    async with client_for_data_dir(folder) as client:
        await _rich_vault(client)
    snap = storage.snapshot(folder, base / "restore-me.db")
    async with client_for_data_dir(folder) as client:
        headers = auth(await unlock(client))
        for name in ("after-1", "after-2"):
            resp = await client.post(
                "/passwords/create", json=entry(name), headers=headers
            )
            assert resp.is_success
    crash_after_committing(folder, "UPDATE settings SET hidden_ms = 4242")
    if damaged:
        corrupt_name_index(folder / VAULT_FILE)
        assert check_file(folder / VAULT_FILE)
    return folder, snap


def _events(base: Path, template: Path, snap: Path) -> int:
    work = base / "count"
    shutil.copytree(template, work)
    result = _run(CRASH_SCRIPT, work, snap, 0)
    assert result.returncode == 0, result.stderr
    return int(result.stdout.strip())


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process kill")
async def test_a_restore_killed_at_every_step_leaves_a_recoverable_vault(
    tmp_path: Path,
) -> None:
    template, snap = await _scenario(tmp_path)
    old, restored = _content(template / VAULT_FILE), _content(snap)
    assert old != restored
    steps = _events(tmp_path, template, snap)
    assert steps >= 8

    for step in range(1, steps + 1):
        work = tmp_path / f"crash-{step}"
        shutil.copytree(template, work)
        result = _run(CRASH_SCRIPT, work, snap, step)
        assert result.returncode == 9, (step, result.stderr)

        live = work / VAULT_FILE
        assert check_file(live) == [], step
        now = _content(live)
        assert now in (old, restored), step
        if now != old:
            assert old in [_content(kept) for kept in _kept(work)], step

        storage.restore(work, snap)
        assert check_file(live) == [], step
        assert _content(live) == restored, step
        assert old in [_content(kept) for kept in _kept(work)], step
        wal = work / f"{VAULT_FILE}-wal"
        assert not wal.exists() or wal.stat().st_size == 0, step
        assert not (work / f"{VAULT_FILE}{RESTORING_SUFFIX}").exists(), step


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process kill")
async def test_a_damaged_vault_survives_byte_for_byte_a_restore_killed_at_every_step(
    tmp_path: Path,
) -> None:
    template, snap = await _scenario(tmp_path, damaged=True)
    original = _raw(template)
    assert f"{VAULT_FILE}-wal" in original
    restored = _content(snap)
    steps = _events(tmp_path, template, snap)

    for step in range(1, steps + 1):
        work = tmp_path / f"crash-{step}"
        shutil.copytree(template, work)
        result = _run(CRASH_SCRIPT, work, snap, step)
        assert result.returncode == 9, (step, result.stderr)

        storage.restore(work, snap)
        assert _content(work / VAULT_FILE) == restored, step
        kept = [_raw(path.parent) for path in _kept(work)]
        assert any(
            copy.get(VAULT_FILE) == original[VAULT_FILE]
            and copy.get(f"{VAULT_FILE}-wal") == original[f"{VAULT_FILE}-wal"]
            for copy in kept
        ), step


async def test_a_restore_refuses_while_another_connection_has_the_vault_open(
    tmp_path: Path,
) -> None:
    folder, snap = await _scenario(tmp_path)
    before = _raw(folder)
    with closing(sqlite3.connect(folder / VAULT_FILE)) as reader:
        reader.execute("SELECT count(*) FROM entries").fetchone()
        with pytest.raises(StorageError, match="open in another program"):
            storage.restore(folder, snap)
        assert _raw(folder) == before
        assert _kept(folder) == []
        assert not (folder / f"{VAULT_FILE}{RESTORING_SUFFIX}").exists()


async def test_a_restore_refuses_while_another_connection_is_writing(
    tmp_path: Path,
) -> None:
    folder, snap = await _scenario(tmp_path)
    with closing(sqlite3.connect(folder / VAULT_FILE, isolation_level=None)) as writer:
        writer.execute("BEGIN IMMEDIATE")
        writer.execute("UPDATE settings SET hidden_ms = 1")
        with pytest.raises(StorageError, match="open in another program"):
            storage.restore(folder, snap)
        writer.execute("ROLLBACK")
    assert _content(folder / VAULT_FILE)[1] == (4242,)


async def test_a_snapshot_with_a_damaged_page_is_refused_and_changes_nothing(
    tmp_path: Path,
) -> None:
    folder, snap = await _scenario(tmp_path)
    bad = tmp_path / "bad.db"
    shutil.copyfile(snap, bad)
    corrupt_name_index(bad)
    before = _raw(folder)
    bad_before = bad.read_bytes()

    with pytest.raises(StorageError, match="cannot be restored"):
        storage.restore(folder, bad)

    assert _raw(folder) == before
    assert bad.read_bytes() == bad_before
    assert _kept(folder) == []


async def test_checking_and_copying_a_damaged_vault_never_changes_it(
    tmp_path: Path,
) -> None:
    folder, _ = await _scenario(tmp_path, damaged=True)
    before = _raw(folder)
    assert check_file(folder / VAULT_FILE)
    with pytest.raises(StorageError):
        storage.snapshot(folder)
    with pytest.raises(StorageError, match="cannot be restored"):
        storage.restore(tmp_path / "elsewhere", folder / VAULT_FILE)
    assert _raw(folder) == before
    assert not list((folder / "snapshots").glob("*.partial"))


@pytest.mark.skipif(sys.platform == "win32", reason="RLIMIT_FSIZE is POSIX")
@pytest.mark.parametrize("operation", ["snapshot", "restore"])
async def test_a_full_disk_fails_cleanly_and_changes_nothing(
    tmp_path: Path, operation: str
) -> None:
    folder, snap = await _scenario(tmp_path)
    before = _raw(folder)

    result = _run(LIMITED_SCRIPT, operation, folder, 256 * 1024, snap)

    assert result.returncode == 3, (result.stdout, result.stderr)
    assert _raw(folder) == before
    assert not list(folder.rglob("*.partial"))
    assert not (folder / f"{VAULT_FILE}{RESTORING_SUFFIX}").exists()
    assert _kept(folder) == []


@pytest.mark.skipif(
    sys.platform == "win32" or os.geteuid() == 0, reason="needs a non-root POSIX user"
)
async def test_unwritable_folders_fail_cleanly_and_change_nothing(
    tmp_path: Path,
) -> None:
    folder, snap = await _scenario(tmp_path)
    before = _raw(folder)
    snapshots = folder / "snapshots"
    snapshots.chmod(0o500)
    try:
        with pytest.raises(StorageError, match="Could not write the snapshot"):
            storage.snapshot(folder)
    finally:
        snapshots.chmod(0o700)
    folder.chmod(0o500)
    try:
        with pytest.raises(StorageError):
            storage.restore(folder, snap)
        with pytest.raises(StorageError, match="cannot write its vault"):
            storage.prepare_data_dir(folder / "inner")
        with pytest.raises(StorageError, match="cannot write its vault"):
            storage.VaultLock(folder / "inner").acquire()
    finally:
        folder.chmod(0o700)
    assert _raw(folder) == before


async def test_a_restored_vault_restarts_and_unlocks_with_everything_intact(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        await _rich_vault(client)
    snap = storage.snapshot(folder, tmp_path / "saved.db")
    with closing(sqlite3.connect(snap)) as connection:
        before = {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
            for table in (
                "vault",
                "entries",
                "attachments",
                "settings",
            )
        }
    async with client_for_data_dir(folder) as client:
        token = await unlock(client)
        resp = await client.patch(
            "/master_password/update",
            json={
                "master_password": MASTER_PASSWORD,
                "new_master_password": NEW_MASTER_PASSWORD,
            },
            headers=auth(token),
        )
        assert resp.status_code == 200

    storage.restore(folder, snap)
    storage.restore(folder, snap)

    with closing(sqlite3.connect(folder / VAULT_FILE)) as connection:
        after = {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
            for table in before
        }
    assert after == before
    async with client_for_data_dir(folder) as client:
        resp = await client.post(
            "/master_password/unlock", json={"master_password": NEW_MASTER_PASSWORD}
        )
        assert resp.json()["valid"] is False
        headers = auth(await unlock(client))
        github = (await client.get("/passwords/github", headers=headers)).json()
        assert github["password_value"] == "gh-Value-2"
        assert [h["value"] for h in github["password_history"]] == ["gh-Value-1"]
        trash = (await client.get("/passwords/trash", headers=headers)).json()
        assert [t["password_name"] for t in trash] == ["trashed"]
        attachments = (
            await client.get("/passwords/github/attachments", headers=headers)
        ).json()
        resp = await client.get(
            f"/passwords/github/attachments/{attachments[0]['id']}", headers=headers
        )
        assert resp.content == ATTACHMENT
        settings = (await client.get("/settings", headers=headers)).json()
        assert settings == SETTINGS


def _stale_wal(folder: Path, how: str) -> bytes:
    vault = folder / VAULT_FILE
    wal = (folder / f"{VAULT_FILE}-wal").read_bytes()
    if how == "deleted":
        vault.unlink()
    elif how == "emptied":
        vault.write_bytes(b"")
    else:
        vault.rename(folder / "vault-moved-aside.db")
    return wal


@pytest.mark.parametrize("how", ["deleted", "emptied", "moved-aside"])
async def test_a_stale_wal_next_to_a_missing_vault_is_never_replayed(
    tmp_path: Path, how: str
) -> None:
    folder, snap = await _scenario(tmp_path)
    wal = _stale_wal(folder, how)
    assert wal

    kept = storage.restore(folder, snap)

    assert check_file(folder / VAULT_FILE) == []
    assert _content(folder / VAULT_FILE) == _content(snap)
    assert kept is not None
    assert (kept / f"{VAULT_FILE}-wal.unfolded").read_bytes() == wal


async def test_a_restored_vault_is_already_in_wal_mode(tmp_path: Path) -> None:
    folder, snap = await _scenario(tmp_path)
    storage.restore(folder, snap)
    with closing(
        sqlite3.connect(f"{(folder / VAULT_FILE).as_uri()}?mode=ro", uri=True)
    ) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)
    assert not (folder / f"{VAULT_FILE}-journal").exists()


@pytest.mark.parametrize(
    "name",
    [f"{VAULT_FILE}-wal", f"{VAULT_FILE}-shm", f"{VAULT_FILE}{RESTORING_SUFFIX}"],
)
async def test_a_snapshot_cannot_take_a_name_the_vault_uses(
    tmp_path: Path, name: str
) -> None:
    folder, _ = await _scenario(tmp_path)
    with pytest.raises(StorageError, match="the vault itself uses"):
        storage.snapshot(folder, folder / name)


@pytest.mark.skipif(
    sys.platform == "win32" or os.geteuid() == 0, reason="needs a non-root POSIX user"
)
async def test_a_wal_the_restore_cannot_read_stops_it_and_changes_nothing(
    tmp_path: Path,
) -> None:
    folder, snap = await _scenario(tmp_path)
    before = _raw(folder)
    wal = folder / f"{VAULT_FILE}-wal"
    wal.chmod(0o000)
    try:
        with pytest.raises(StorageError, match="Nothing was changed"):
            storage.restore(folder, snap)
    finally:
        wal.chmod(0o600)
    assert _raw(folder) == before
    assert _kept(folder) == []
    assert not (folder / f"{VAULT_FILE}{RESTORING_SUFFIX}").exists()


async def test_a_failure_while_keeping_the_old_vault_changes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder, snap = await _scenario(tmp_path)
    before = _raw(folder)
    assert f"{VAULT_FILE}-wal" in before

    def full_disk(*args: object, **kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(storage.shutil, "copyfile", full_disk)
    with pytest.raises(StorageError, match="Nothing was replaced"):
        storage.restore(folder, snap)
    monkeypatch.undo()

    assert _raw(folder) == before
    assert list((folder / "snapshots").glob("replaced-*")) == []
    assert not (folder / f"{VAULT_FILE}{RESTORING_SUFFIX}").exists()


async def test_a_copy_that_fails_its_own_check_is_never_kept_or_restored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder, snap = await _scenario(tmp_path)
    before = _raw(folder)
    original = storage.check_connection

    def copy_damaged_on_the_way(
        connection: sqlite3.Connection, *, expected_schema: int = storage.SCHEMA_VERSION
    ) -> list[str]:
        name = connection.execute("PRAGMA database_list").fetchone()[2]
        if name.endswith(".partial"):
            return ["simulated damage in the copy"]
        return original(connection, expected_schema=expected_schema)

    monkeypatch.setattr(storage, "check_connection", copy_damaged_on_the_way)
    with pytest.raises(StorageError, match="failed its integrity check"):
        storage.snapshot(folder, tmp_path / "copy.db")
    with pytest.raises(StorageError, match="failed its integrity check"):
        storage.restore(folder, snap)
    monkeypatch.undo()

    assert not (tmp_path / "copy.db").exists()
    assert not list(tmp_path.glob("*.partial*"))
    assert _raw(folder) == before
    assert _kept(folder) == []
    assert not list(folder.glob(f"{VAULT_FILE}{RESTORING_SUFFIX}*"))


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process kill")
async def test_a_set_aside_killed_at_every_step_reunites_the_original_files(
    tmp_path: Path,
) -> None:
    template, _ = await _scenario(tmp_path)
    original = _raw(template)
    expected = _content(template / VAULT_FILE)
    script = CRASH_SCRIPT.replace(
        "storage.restore(Path(sys.argv[1]), Path(sys.argv[2]))",
        "storage.set_aside(Path(sys.argv[1]))",
    )
    count = tmp_path / "count"
    shutil.copytree(template, count)
    result = _run(script, count, "unused", 0)
    assert result.returncode == 0, result.stderr
    steps = int(result.stdout.strip())
    assert steps >= 8

    for step in range(1, steps + 1):
        work = tmp_path / f"set-aside-crash-{step}"
        shutil.copytree(template, work)
        result = _run(script, work, "unused", step)
        assert result.returncode == 9, (step, result.stderr)

        pending = work / "snapshots" / storage.SET_ASIDE_PENDING
        if pending.exists():
            with pytest.raises(StorageError, match="set-aside was interrupted"):
                storage.prepare_data_dir(work)
        storage.set_aside(work)
        kept = list((work / "snapshots").glob("set-aside-*"))
        assert len(kept) == 1, step
        assert _raw(kept[0]) == original, step
        assert _content(kept[0] / VAULT_FILE) == expected, step
        assert not list(work.glob(f"{VAULT_FILE}*")), step
        assert not pending.exists(), step


async def test_an_interrupted_set_aside_never_overwrites_either_copy(
    tmp_path: Path,
) -> None:
    folder, snap = await _scenario(tmp_path)
    pending = folder / "snapshots" / storage.SET_ASIDE_PENDING
    pending.mkdir()
    copy = pending / VAULT_FILE
    copy.write_bytes(b"an earlier vault must survive")
    before = _raw(folder)

    with pytest.raises(StorageError, match="Nothing was overwritten"):
        storage.set_aside(folder)
    with pytest.raises(StorageError, match="set-aside was interrupted"):
        storage.restore(folder, snap)
    assert _raw(folder) == before
    assert copy.read_bytes() == b"an earlier vault must survive"
