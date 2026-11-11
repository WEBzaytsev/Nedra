import asyncio
import os
import shutil
import sqlite3
import stat
import time
from contextlib import closing
from pathlib import Path

import httpx
import pytest
from sqlalchemy import event, insert, text
from sqlalchemy.exc import OperationalError
from typer.testing import CliRunner

import storage
from crud.engine import Database, after_commit, after_rollback, create_engine, is_busy
from main import get_application
from models import SettingsModel
from settings import SETTINGS_DEFAULTS
from storage import (
    APPLICATION_ID,
    SCHEMA_VERSION,
    VAULT_FILE,
    StorageError,
    VaultLock,
    check_file,
)
from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    auth,
    client_for_data_dir,
    corrupt_name_index,
    crash_after_committing,
    create_vault,
    data_dir,
    db_execute,
    db_snapshot,
    entry,
    unlock,
    write_lock_held,
)
from vault_admin import app as admin_app

ROTATE = {
    "master_password": MASTER_PASSWORD,
    "new_master_password": NEW_MASTER_PASSWORD,
}


async def _prepared(folder: Path) -> Database:
    database = Database(folder)
    await database.prepare()
    return database


def _pragma(path: Path, name: str) -> object:
    with closing(sqlite3.connect(path)) as connection:
        return connection.execute(f"PRAGMA {name}").fetchone()[0]


def _database_state(
    path: Path,
) -> tuple[object, list[tuple[object, ...]], dict[str, list[tuple[object, ...]]]]:
    with closing(sqlite3.connect(path)) as connection:
        schema = connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).fetchall()
        contents = {
            name: connection.execute(
                f'SELECT * FROM "{name}" ORDER BY rowid'
            ).fetchall()
            for kind, name, _, _ in schema
            if kind == "table"
        }
        return (
            connection.execute("PRAGMA user_version").fetchone()[0],
            schema,
            contents,
        )


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


async def _populate(client: httpx.AsyncClient, names: list[str]) -> str:
    token = await create_vault(client)
    configured = await client.patch(
        "/settings", json=SETTINGS_DEFAULTS, headers=auth(token)
    )
    assert configured.status_code == 200, configured.text
    for name in names:
        resp = await client.post(
            "/passwords/create", json=entry(name), headers=auth(token)
        )
        assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"/passwords/{names[0]}/attachments",
        files={"file": ("a.bin", os.urandom(4096), "application/octet-stream")},
        headers=auth(token),
    )
    assert resp.status_code == 200, resp.text
    return token


@pytest.mark.asyncio
async def test_schema_two_user_migration_snapshot_bootstrap_and_rollback(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "legacy"
    async with client_for_data_dir(folder) as client:
        bootstrapped = await client.post(
            "/auth/bootstrap",
            json={"username": "owner", "password": MASTER_PASSWORD},
        )
        assert bootstrapped.status_code == 200, bootstrapped.text
        headers = auth(bootstrapped.json()["session_token"])
        created = await client.post(
            "/passwords/create", json=entry("kept"), headers=headers
        )
        assert created.status_code == 200, created.text

    vault = folder / VAULT_FILE
    with closing(sqlite3.connect(vault)) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("PRAGMA legacy_alter_table=ON")
        connection.executescript(
            """
            DROP TABLE access_audit;
            DROP TABLE user_recovery;
            DROP TABLE folder_group_access;
            DROP TABLE folder_user_access;
            DROP TABLE group_members;
            DROP TABLE groups;
            DROP TABLE folders;
            DROP TABLE entry_access;
            DROP INDEX uq_entries_name_active;
            DROP INDEX ix_entries_owner_id;
            DROP INDEX ix_entries_folder_id;
            ALTER TABLE entries RENAME TO entries_v3;
            CREATE TABLE entries (
                id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                uid BLOB NOT NULL UNIQUE,
                created TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                deleted TIMESTAMP,
                name_index BLOB NOT NULL,
                document BLOB NOT NULL,
                backed_up BOOLEAN DEFAULT 0 NOT NULL,
                CONSTRAINT ck_entries_uid CHECK (length(uid) = 16),
                CONSTRAINT ck_entries_name_index CHECK (length(name_index) = 32)
            );
            INSERT INTO entries
                (id, uid, created, updated, deleted, name_index, document, backed_up)
            SELECT id, uid, created, updated, deleted, name_index, document, backed_up
            FROM entries_v3;
            DROP TABLE entries_v3;
            CREATE UNIQUE INDEX uq_entries_name_active
                ON entries (name_index) WHERE deleted IS NULL;

            ALTER TABLE vault RENAME TO vault_v3;
            CREATE TABLE vault (
                id INTEGER NOT NULL PRIMARY KEY,
                created TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                format_version INTEGER NOT NULL,
                kdf VARCHAR NOT NULL,
                kdf_memory_kib INTEGER NOT NULL,
                kdf_iterations INTEGER NOT NULL,
                kdf_lanes INTEGER NOT NULL,
                kdf_salt BLOB NOT NULL,
                password_check BLOB NOT NULL,
                wrapped_key BLOB NOT NULL,
                key_check BLOB NOT NULL,
                CONSTRAINT ck_vault_singleton CHECK (id = 1),
                CONSTRAINT ck_vault_salt CHECK (length(kdf_salt) = 16),
                CONSTRAINT ck_vault_password_check CHECK (length(password_check) = 32),
                CONSTRAINT ck_vault_key_check CHECK (length(key_check) = 32)
            );
            INSERT INTO vault
                (id, created, updated, format_version, kdf, kdf_memory_kib,
                 kdf_iterations, kdf_lanes, kdf_salt, password_check, wrapped_key,
                 key_check)
            SELECT id, created, updated, format_version, kdf, kdf_memory_kib,
                   kdf_iterations, kdf_lanes, kdf_salt, password_check, wrapped_key,
                   key_check
            FROM vault_v3;
            DROP TABLE vault_v3;
            DROP INDEX ix_users_service_owner_id;
            DROP TABLE users;
            """
        )
        connection.execute(f"PRAGMA user_version={storage.PREVIOUS_SCHEMA_VERSION}")
        connection.commit()

    rollback = storage.migrate_users_if_needed(folder)
    assert rollback is not None
    assert rollback.is_file()
    assert _pragma(rollback, "user_version") == storage.PREVIOUS_SCHEMA_VERSION
    assert _pragma(vault, "user_version") == SCHEMA_VERSION
    assert storage.migrate_users_if_needed(folder) is None
    with closing(sqlite3.connect(rollback)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("SELECT count(*) FROM entries").fetchone() == (1,)
    with closing(sqlite3.connect(vault)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("SELECT count(*) FROM users").fetchone() == (0,)
        assert connection.execute("SELECT owner_id FROM entries").fetchone() == (None,)

    async with client_for_data_dir(folder) as migrated:
        status = await migrated.get("/auth/status")
        assert status.json() == {"initialized": False}
        bootstrapped = await migrated.post(
            "/auth/bootstrap",
            json={"username": "owner", "password": MASTER_PASSWORD},
        )
        assert bootstrapped.status_code == 200, bootstrapped.text
        headers = auth(bootstrapped.json()["session_token"])
        [restored] = (await migrated.get("/passwords", headers=headers)).json()
        assert restored["password_name"] == "kept"
        assert restored["owner_username"] == "owner"
        assert restored["access"] == "owner"

    rollback_folder = tmp_path / "rollback"
    rollback_folder.mkdir()
    shutil.copy2(rollback, rollback_folder / VAULT_FILE)
    assert _pragma(rollback_folder / VAULT_FILE, "user_version") == (
        storage.PREVIOUS_SCHEMA_VERSION
    )
    with closing(sqlite3.connect(rollback_folder / VAULT_FILE)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("SELECT count(*) FROM entries").fetchone() == (1,)


@pytest.mark.asyncio
async def test_schema_three_folder_migration_links_encrypted_legacy_names(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "schema-three"
    async with client_for_data_dir(folder) as client:
        bootstrapped = await client.post(
            "/auth/bootstrap",
            json={"username": "owner", "password": MASTER_PASSWORD},
        )
        assert bootstrapped.status_code == 200, bootstrapped.text
        headers = auth(bootstrapped.json()["session_token"])
        created = await client.post(
            "/passwords/create",
            json=entry("legacy folder entry", folder="Legacy folder"),
            headers=headers,
        )
        assert created.status_code == 200, created.text

    vault = folder / VAULT_FILE
    with closing(sqlite3.connect(vault)) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("PRAGMA legacy_alter_table=ON")
        connection.executescript(
            """
            DROP TABLE access_audit;
            DROP TABLE user_recovery;
            DROP TABLE folder_group_access;
            DROP TABLE folder_user_access;
            DROP TABLE group_members;
            DROP TABLE groups;
            DROP TABLE folders;
            DROP TABLE entry_access;
            DROP INDEX ix_entries_folder_id;
            DROP INDEX ix_entries_owner_id;
            DROP INDEX uq_entries_name_active;
            ALTER TABLE entries RENAME TO entries_v4;
            CREATE TABLE entries (
                id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                uid BLOB NOT NULL UNIQUE,
                created TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
                deleted TIMESTAMP,
                name_index BLOB NOT NULL,
                document BLOB NOT NULL,
                backed_up BOOLEAN DEFAULT 0 NOT NULL,
                owner_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
                CONSTRAINT ck_entries_uid CHECK (length(uid) = 16),
                CONSTRAINT ck_entries_name_index CHECK (length(name_index) = 32)
            );
            INSERT INTO entries
                (id, uid, created, updated, deleted, name_index, document,
                 backed_up, owner_id)
            SELECT id, uid, created, updated, deleted, name_index, document,
                   backed_up, owner_id
            FROM entries_v4;
            DROP TABLE entries_v4;
            CREATE UNIQUE INDEX uq_entries_name_active
                ON entries (name_index) WHERE deleted IS NULL;
            CREATE INDEX ix_entries_owner_id ON entries(owner_id);
            CREATE TABLE entry_access (
                entry_id INTEGER NOT NULL
                    REFERENCES entries(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
                permission VARCHAR(16) NOT NULL,
                granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (entry_id, user_id),
                CONSTRAINT ck_entry_access_permission
                    CHECK (permission IN ('read', 'write'))
            );
            ALTER TABLE vault DROP COLUMN folder_links_ready;
            """
        )
        connection.execute(f"PRAGMA user_version={storage.MULTIUSER_SCHEMA_VERSION}")
        connection.commit()

    snapshot = storage.migrate_folders(folder)
    assert snapshot.is_file()
    assert _pragma(snapshot, "user_version") == storage.MULTIUSER_SCHEMA_VERSION
    assert _pragma(vault, "user_version") == SCHEMA_VERSION
    assert check_file(vault) == []
    with closing(sqlite3.connect(snapshot)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table'"
            )
        }
        assert "folders" not in tables
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)

    async with client_for_data_dir(folder) as migrated:
        logged_in = await migrated.post(
            "/auth/login",
            json={"username": "owner", "password": MASTER_PASSWORD},
        )
        assert logged_in.status_code == 200, logged_in.text
        assert logged_in.json()["valid"] is True
        headers = auth(logged_in.json()["session_token"])
        [entry_response] = (await migrated.get("/passwords", headers=headers)).json()
        [folder_response] = (await migrated.get("/folders", headers=headers)).json()
        assert entry_response["folder"] == "Legacy folder"
        assert entry_response["folder_id"] == folder_response["id"]
        assert folder_response["name"] == "Legacy folder"

    with closing(sqlite3.connect(vault)) as connection:
        assert connection.execute(
            "SELECT folder_links_ready FROM vault"
        ).fetchone() == (1,)
        assert connection.execute("SELECT count(*) FROM folders").fetchone() == (1,)


async def test_schema_four_service_permission_migration_disables_existing_tokens(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "schema-four"
    async with client_for_data_dir(folder) as client:
        bootstrapped = await client.post(
            "/auth/bootstrap",
            json={"username": "owner", "password": MASTER_PASSWORD},
        )
        assert bootstrapped.status_code == 200, bootstrapped.text
        headers = auth(bootstrapped.json()["session_token"])
        service = await client.post(
            "/users",
            json={
                "username": "assistant",
                "role": "service",
                "current_password": MASTER_PASSWORD,
            },
            headers=headers,
        )
        assert service.status_code == 200, service.text

    vault = folder / VAULT_FILE
    user_columns = (
        "id, created, updated, username, role, active, must_change_password, "
        "service_owner_id, service_token_hash, kdf, kdf_memory_kib, "
        "kdf_iterations, kdf_lanes, kdf_salt, password_check, wrapped_key, key_check"
    )
    with closing(sqlite3.connect(vault)) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("DROP TABLE user_recovery")
        connection.execute(
            "CREATE TABLE users_legacy AS SELECT " + user_columns + " FROM users"
        )
        connection.execute("DROP TABLE users")
        connection.execute(
            """
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                username VARCHAR(64) NOT NULL UNIQUE,
                role VARCHAR(16) NOT NULL,
                active BOOLEAN NOT NULL DEFAULT 1,
                must_change_password BOOLEAN NOT NULL DEFAULT 0,
                service_owner_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
                service_token_hash BLOB UNIQUE,
                kdf VARCHAR NOT NULL,
                kdf_memory_kib INTEGER NOT NULL,
                kdf_iterations INTEGER NOT NULL,
                kdf_lanes INTEGER NOT NULL,
                kdf_salt BLOB NOT NULL,
                password_check BLOB NOT NULL,
                wrapped_key BLOB NOT NULL,
                key_check BLOB NOT NULL,
                CONSTRAINT ck_users_role CHECK (role IN ('admin', 'member', 'service')),
                CONSTRAINT ck_users_salt CHECK (length(kdf_salt) = 16),
                CONSTRAINT ck_users_password_check CHECK (length(password_check) = 32),
                CONSTRAINT ck_users_key_check CHECK (length(key_check) = 32)
            )
            """
        )
        connection.execute(
            "INSERT INTO users ("
            + user_columns
            + ") SELECT "
            + user_columns
            + " FROM users_legacy"
        )
        connection.execute("DROP TABLE users_legacy")
        connection.execute(
            "CREATE INDEX ix_users_service_owner_id ON users(service_owner_id)"
        )
        connection.execute(
            f"PRAGMA user_version={storage.SERVICE_PERMISSIONS_SCHEMA_VERSION}"
        )
        connection.commit()

    snapshot = storage.migrate_service_permissions(folder)
    assert (
        _pragma(snapshot, "user_version") == storage.SERVICE_PERMISSIONS_SCHEMA_VERSION
    )
    assert _pragma(vault, "user_version") == SCHEMA_VERSION
    assert check_file(vault) == []
    with closing(sqlite3.connect(snapshot)) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
        assert "service_operations" not in columns
    with closing(sqlite3.connect(vault)) as connection:
        assert connection.execute(
            "SELECT service_operations FROM users WHERE username = 'assistant'"
        ).fetchone() == (0,)


@pytest.mark.asyncio
async def test_schema_five_recovery_migration_is_checked_and_keeps_login(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "schema-five"
    async with client_for_data_dir(folder) as client:
        assert await create_vault(client)
    vault = folder / VAULT_FILE
    with closing(sqlite3.connect(vault)) as connection:
        connection.execute("DROP TABLE user_recovery")
        connection.execute(f"PRAGMA user_version={storage.RECOVERY_SCHEMA_VERSION}")
        connection.commit()

    snapshot = storage.migrate_recovery(folder)
    assert snapshot.is_file()
    assert check_file(vault) == []
    with closing(sqlite3.connect(vault)) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (SCHEMA_VERSION,)
        assert connection.execute(
            "SELECT name FROM sqlite_schema "
            "WHERE type = 'table' AND name = 'user_recovery'"
        ).fetchone() == ("user_recovery",)

    async with client_for_data_dir(folder) as client:
        logged_in = await client.post(
            "/auth/login", json={"username": "admin", "password": MASTER_PASSWORD}
        )
        assert logged_in.json()["valid"] is True


@pytest.mark.asyncio
async def test_recovery_migration_rejects_unknown_crypto_format_without_writing(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "schema-five-unsupported-format"
    async with client_for_data_dir(folder) as client:
        assert await create_vault(client)
    vault = folder / VAULT_FILE
    with closing(sqlite3.connect(vault)) as connection:
        connection.execute("DROP TABLE user_recovery")
        connection.execute(f"PRAGMA user_version={storage.RECOVERY_SCHEMA_VERSION}")
        connection.execute("UPDATE vault SET format_version = 0")
        connection.commit()

    before = _database_state(vault)
    with pytest.raises(StorageError, match="unsupported vault format"):
        storage.migrate_recovery(folder)
    assert _database_state(vault) == before


async def _names(client: httpx.AsyncClient, password: str) -> list[str]:
    resp = await client.get("/passwords", headers=auth(await unlock(client, password)))
    assert resp.status_code == 200, resp.text
    return [item["password_name"] for item in resp.json()]


async def test_a_fresh_folder_becomes_a_private_identified_vault(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "data"
    database = await _prepared(folder)
    try:
        async with database.engine.connect() as connection:
            pragmas = {
                name: await connection.scalar(text(f"PRAGMA {name}"))
                for name in (
                    "journal_mode",
                    "synchronous",
                    "foreign_keys",
                    "secure_delete",
                    "trusted_schema",
                    "busy_timeout",
                )
            }
    finally:
        await database.dispose()

    vault = folder / VAULT_FILE
    if os.name != "nt":
        assert _mode(folder) == 0o700
        assert _mode(vault) == 0o600
    assert pragmas == {
        "journal_mode": "wal",
        "synchronous": 2,
        "foreign_keys": 1,
        "secure_delete": 1,
        "trusted_schema": 0,
        "busy_timeout": storage.BUSY_TIMEOUT_MS,
    }
    assert _pragma(vault, "application_id") == APPLICATION_ID
    assert _pragma(vault, "user_version") == SCHEMA_VERSION
    assert check_file(vault) == []


async def test_preparing_twice_changes_nothing(tmp_path: Path) -> None:
    for _ in range(2):
        await (await _prepared(tmp_path)).dispose()
    with closing(sqlite3.connect(tmp_path / VAULT_FILE)) as connection:
        rows = connection.execute("SELECT inactivity_ms FROM settings").fetchall()
    assert rows == [], (
        "new vaults inherit deployment defaults rather than freezing a settings row"
    )


async def test_an_interrupted_first_start_is_completed_on_the_next(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail_after_creating_tables(connection) -> None:
        storage.BaseModel.metadata.create_all(connection)
        raise RuntimeError("power cut during the first start")

    monkeypatch.setattr("crud.engine.ensure_schema", fail_after_creating_tables)
    database = Database(tmp_path)
    with pytest.raises(RuntimeError):
        await database.prepare()
    await database.dispose()
    monkeypatch.undo()

    assert _pragma(tmp_path / VAULT_FILE, "user_version") == 0
    with closing(sqlite3.connect(tmp_path / VAULT_FILE)) as connection:
        assert connection.execute("SELECT count(*) FROM sqlite_schema").fetchone() == (
            0,
        )
    await (await _prepared(tmp_path)).dispose()
    assert check_file(tmp_path / VAULT_FILE) == []


async def test_cancelling_a_writer_rolls_back_and_releases_its_connection(
    tmp_path: Path,
) -> None:
    database = await _prepared(tmp_path)
    async with database.transaction() as session:
        await session.execute(insert(SettingsModel).values(**SETTINGS_DEFAULTS))
    entered = asyncio.Event()
    hooks: list[str] = []

    async def write_until_cancelled() -> None:
        async with database.transaction() as session:
            after_commit(session, lambda: hooks.append("commit"))
            after_rollback(session, lambda: hooks.append("rollback"))
            await session.execute(text("UPDATE settings SET hidden_ms = 1"))
            entered.set()
            await asyncio.Event().wait()

    try:
        task = asyncio.create_task(write_until_cancelled())
        await asyncio.wait_for(entered.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert hooks == ["rollback"]
        # A synchronous second connection proves rollback has released SQLite's
        # writer lock, independently of SQLAlchemy's pool bookkeeping.
        with closing(sqlite3.connect(database.path, timeout=0)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            assert connection.execute("SELECT hidden_ms FROM settings").fetchone() == (
                SETTINGS_DEFAULTS["hidden_ms"],
            )
            connection.execute("ROLLBACK")
        async with database.transaction() as session:
            await session.execute(text("UPDATE settings SET hidden_ms = 2"))
    finally:
        await database.dispose()


@pytest.mark.parametrize("marker", ["invalid", b"invalid", 2.5])
async def test_an_invalid_sqlite_format_value_is_refused_without_modification(
    tmp_path: Path, marker: object
) -> None:
    async with client_for_data_dir(tmp_path) as client:
        await create_vault(client)
    path = tmp_path / VAULT_FILE
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("UPDATE vault SET format_version = ?", (marker,))
        connection.commit()
    before = path.read_bytes()
    with pytest.raises(StorageError, match="invalid vault format marker"):
        storage.prepare_data_dir(tmp_path)
    assert check_file(path) == ["the file has an invalid vault format marker"]
    assert path.read_bytes() == before


def _foreign_database(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE notes (body TEXT)")
        connection.commit()


def _future_vault(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute(f"PRAGMA application_id={APPLICATION_ID}")
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION + 1}")
        connection.execute("CREATE TABLE future (x)")
        connection.commit()


def _other_application(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA application_id=1")
        connection.commit()


def _not_sqlite(path: Path) -> None:
    path.write_bytes(b"this is not a database" * 100)


@pytest.mark.parametrize(
    ("damage", "message"),
    [
        (_foreign_database, "not a CipherMoth vault"),
        (_other_application, "not a CipherMoth vault"),
        (_future_vault, "newer CipherMoth"),
        (_not_sqlite, "cannot open"),
    ],
    ids=["foreign", "other-application", "newer-schema", "not-sqlite"],
)
async def test_files_that_are_not_a_vault_of_this_release_are_refused_untouched(
    tmp_path: Path, damage, message: str
) -> None:
    vault = tmp_path / VAULT_FILE
    damage(vault)
    before = vault.read_bytes()

    database = Database(tmp_path)
    with pytest.raises(StorageError, match=message):
        await database.prepare()
    await database.dispose()

    assert vault.read_bytes() == before


@pytest.mark.parametrize(
    ("version", "supported"),
    [((3, 40, 1), False), ((3, 51, 2), False), ((3, 51, 3), True), ((3, 54, 0), True)],
)
def test_sqlite_without_the_wal_reset_fix_is_refused(
    version: tuple[int, int, int], supported: bool
) -> None:
    if supported:
        storage.require_supported_sqlite(version)
    else:
        with pytest.raises(StorageError, match="WAL-reset"):
            storage.require_supported_sqlite(version)


def test_the_running_sqlite_has_the_wal_reset_fix() -> None:
    storage.require_supported_sqlite()


async def test_a_corrupted_vault_is_refused_at_startup(tmp_path: Path) -> None:
    async with client_for_data_dir(tmp_path) as client:
        await _populate(client, [f"entry-{i}" for i in range(50)])
    vault = tmp_path / VAULT_FILE
    with closing(sqlite3.connect(vault)) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        root = connection.execute(
            "SELECT rootpage FROM sqlite_schema WHERE name = 'uq_entries_name_active'"
        ).fetchone()[0]
    data = bytearray(vault.read_bytes())
    offset = (root - 1) * page_size + 100
    data[offset : offset + 64] = os.urandom(64)
    vault.write_bytes(bytes(data))

    assert check_file(vault)
    database = Database(tmp_path)
    with pytest.raises(StorageError, match="integrity check|cannot open"):
        await database.prepare()
    await database.dispose()


def test_only_one_process_can_serve_a_vault_folder(tmp_path: Path) -> None:
    with VaultLock(tmp_path):
        with pytest.raises(StorageError, match="Another CipherMoth process"):
            VaultLock(tmp_path).acquire()
    with VaultLock(tmp_path):
        pass


async def test_the_server_refuses_to_start_on_a_folder_another_one_serves(
    tmp_path: Path,
) -> None:
    app = get_application(database=Database(tmp_path))
    with VaultLock(tmp_path), pytest.raises(StorageError, match="Another"):
        async with app.router.lifespan_context(app):
            pass
    async with app.router.lifespan_context(app):
        assert (tmp_path / VAULT_FILE).exists()


async def test_a_snapshot_is_consistent_while_a_writer_holds_the_vault(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    await _populate(client, ["alpha", "beta"])
    with write_lock_held() as writer:
        writer.execute(
            "INSERT INTO entries (uid, name_index, document) "
            "VALUES (randomblob(16), randomblob(32), x'00')"
        )
        target = storage.snapshot(data_dir(), tmp_path / "snap.db")
    assert check_file(target) == []
    assert _pragma(target, "journal_mode") == "delete"
    if os.name != "nt":
        assert _mode(target) == 0o600
    with closing(sqlite3.connect(target)) as connection:
        rows = connection.execute("SELECT count(*) FROM entries").fetchone()
    assert rows == (2,)
    assert not list(tmp_path.glob("*.partial"))


async def test_a_snapshot_contains_writes_that_are_only_in_the_wal(
    client: httpx.AsyncClient,
) -> None:
    await _populate(client, ["alpha"])
    assert (data_dir() / f"{VAULT_FILE}-wal").stat().st_size > 0
    target = storage.snapshot(data_dir())
    assert target.parent == data_dir() / "snapshots"
    with closing(sqlite3.connect(target)) as connection:
        assert connection.execute("SELECT count(*) FROM entries").fetchone() == (1,)
    target.unlink()


async def test_a_snapshot_restores_the_complete_vault(tmp_path: Path) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        token = await _populate(client, ["alpha", "beta"])
        await client.delete("/passwords/beta", headers=auth(token))
        saved = storage.snapshot(folder, tmp_path / "saved.db")
        before = await _raw(folder)

        await client.post("/passwords/create", json=entry("later"), headers=auth(token))
        resp = await client.patch(
            "/master_password/update", json=ROTATE, headers=auth(token)
        )
        assert resp.status_code == 200
        assert (folder / f"{VAULT_FILE}-wal").stat().st_size > 0

    kept = storage.restore(folder, saved)

    assert kept is not None and check_file(kept / VAULT_FILE) == []
    assert not (folder / f"{VAULT_FILE}-wal").exists()
    assert await _raw(folder) == before
    async with client_for_data_dir(folder) as client:
        assert await _names(client, MASTER_PASSWORD) == ["alpha"]
        resp = await client.get(
            "/passwords/trash", headers=auth(await unlock(client, MASTER_PASSWORD))
        )
        assert [item["password_name"] for item in resp.json()] == ["beta"]
    with closing(sqlite3.connect(kept / VAULT_FILE)) as connection:
        rows = connection.execute("SELECT count(*) FROM entries").fetchone()
    assert rows == (3,)


async def _raw(folder: Path) -> dict:
    database = Database(folder)
    try:
        async with database.engine.connect() as connection:
            return {
                table: [
                    tuple(row)
                    for row in await connection.execute(
                        text(f"SELECT * FROM {table} ORDER BY id")
                    )
                ]
                for table in ("vault", "entries", "attachments")
            }
    finally:
        await database.dispose()


@pytest.mark.parametrize(
    "damage",
    [_foreign_database, _future_vault, _not_sqlite],
    ids=["foreign", "newer", "garbage"],
)
async def test_a_restore_refuses_a_bad_snapshot_and_changes_nothing(
    tmp_path: Path, damage
) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        await _populate(client, ["alpha"])
    vault_before = (folder / VAULT_FILE).read_bytes()
    bad = tmp_path / "bad.db"
    damage(bad)

    with pytest.raises(StorageError, match="cannot be restored"):
        storage.restore(folder, bad)

    assert (folder / VAULT_FILE).read_bytes() == vault_before
    assert not list(folder.glob(f"{VAULT_FILE}{storage.RESTORING_SUFFIX}*"))


async def test_a_restore_refuses_while_the_vault_is_served(tmp_path: Path) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        await _populate(client, ["alpha"])
    saved = storage.snapshot(folder, tmp_path / "saved.db")
    with VaultLock(folder), pytest.raises(StorageError, match="Stop it first"):
        storage.restore(folder, saved)


async def test_a_restore_replaces_a_damaged_vault_and_keeps_its_files(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        await _populate(client, ["alpha"])
    saved = storage.snapshot(folder, tmp_path / "saved.db")
    _not_sqlite(folder / VAULT_FILE)

    kept = storage.restore(folder, saved)

    assert kept is not None and kept.is_dir()
    assert (kept / VAULT_FILE).read_bytes().startswith(b"this is not a database")
    async with client_for_data_dir(folder) as client:
        assert await _names(client, MASTER_PASSWORD) == ["alpha"]


async def test_the_admin_commands_snapshot_check_and_restore(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        await _populate(client, ["alpha"])
    monkeypatch.setenv("CIPHERMOTH_DATA_DIR", str(folder))
    storage_settings = __import__("settings").get_storage_settings
    storage_settings.cache_clear()
    runner = CliRunner()
    try:
        result = runner.invoke(
            admin_app, ["snapshot", "--output", str(tmp_path / "s.db")]
        )
        assert result.exit_code == 0, result.output
        assert runner.invoke(admin_app, ["check"]).exit_code == 0
        assert (
            runner.invoke(admin_app, ["check", str(tmp_path / "s.db")]).exit_code == 0
        )
        _not_sqlite(tmp_path / "junk.db")
        result = runner.invoke(admin_app, ["check", str(tmp_path / "junk.db")])
        assert result.exit_code == 1
        result = runner.invoke(
            admin_app, ["restore", str(tmp_path / "s.db")], input="n\n"
        )
        assert result.exit_code == 1
        result = runner.invoke(admin_app, ["restore", str(tmp_path / "s.db"), "--yes"])
        assert result.exit_code == 0, result.output
        assert "kept as" in result.output
    finally:
        storage_settings.cache_clear()


async def test_reads_keep_working_while_a_writer_holds_the_vault(
    client: httpx.AsyncClient,
) -> None:
    token = await _populate(client, ["alpha"])
    headers = auth(token)
    reads = (
        "/passwords",
        "/passwords/alpha",
        "/passwords/trash",
        "/passwords/alpha/attachments",
        "/passwords/alpha/attachments/1",
        "/settings",
        "/master_password/status",
        "/master_password/session",
        "/health",
        "/meta",
    )
    with write_lock_held():
        started = time.monotonic()
        responses = await asyncio.gather(
            *(client.get(path, headers=headers) for path in reads),
            client.post("/master_password/session", headers=headers),
            client.post(
                "/master_password/unlock", json={"master_password": MASTER_PASSWORD}
            ),
        )
        elapsed = time.monotonic() - started
    assert [r.status_code for r in responses] == [200] * (len(reads) + 2)
    assert responses[-1].json()["valid"] is True
    assert elapsed < 2


async def test_requests_without_a_live_session_never_wait_for_the_write_lock(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    await client.post("/master_password/lock", headers=auth(token))
    with write_lock_held():
        started = time.monotonic()
        responses = await asyncio.gather(
            client.post("/passwords/create", json=entry("x"), headers=auth(token)),
            client.patch("/settings", json={}, headers=auth("A" * 43)),
            client.delete("/passwords/x/purge"),
            client.patch("/master_password/update", json=ROTATE, headers=auth(token)),
        )
        elapsed = time.monotonic() - started
    assert {r.status_code for r in responses} == {401}
    assert elapsed < 2


async def test_a_write_that_cannot_get_the_lock_in_time_is_a_clean_503(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    engine = create_engine(data_dir() / VAULT_FILE)

    @event.listens_for(engine.sync_engine, "connect")
    def impatient(dbapi_connection, _record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA busy_timeout=200")
        cursor.close()

    other = get_application(database=Database(data_dir(), engine=engine))
    other.state.vault_sessions = client._transport.app.state.vault_sessions  # ty: ignore[unresolved-attribute]
    before = await db_snapshot()
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=other), base_url="http://testserver/api"
        ) as impatient_client:
            with write_lock_held():
                resp = await impatient_client.post(
                    "/passwords/create", json=entry("late"), headers=auth(token)
                )
    finally:
        await engine.dispose()

    assert resp.status_code == 503
    assert resp.json() == {
        "detail": "The vault is busy with another change. Try again in a moment.",
        "code": "busy",
    }
    assert resp.headers["retry-after"] == "2"
    assert await db_snapshot() == before
    resp = await client.post(
        "/passwords/create", json=entry("late"), headers=auth(token)
    )
    assert resp.status_code == 200


async def test_deleting_an_entry_row_deletes_its_attachments(
    client: httpx.AsyncClient,
) -> None:
    await _populate(client, ["alpha"])
    assert await db_execute("SELECT count(*) FROM attachments") == [(1,)]
    await db_execute("DELETE FROM entries")
    assert await db_execute("SELECT count(*) FROM attachments") == [(0,)]


async def test_ids_are_never_reused(client: httpx.AsyncClient) -> None:
    token = await _populate(client, ["alpha"])
    resp = await client.delete("/passwords/alpha/attachments/1", headers=auth(token))
    assert resp.status_code == 200
    resp = await client.post(
        "/passwords/alpha/attachments",
        files={"file": ("b.bin", b"second", "application/octet-stream")},
        headers=auth(token),
    )
    assert resp.json()["id"] == 2


def _files(folder: Path) -> dict[str, bytes]:
    return {
        path.name: path.read_bytes()
        for path in sorted(folder.glob(f"{VAULT_FILE}*"))
        if path.name != f"{VAULT_FILE}-shm"
    }


async def _vault_with_committed_wal(folder: Path) -> None:
    async with client_for_data_dir(folder) as client:
        await _populate(client, [f"entry-{i}" for i in range(50)])
    crash_after_committing(folder, "UPDATE settings SET hidden_ms = 4242")


async def test_a_damaged_vault_is_refused_without_touching_its_files(
    tmp_path: Path,
) -> None:
    await _vault_with_committed_wal(tmp_path)
    corrupt_name_index(tmp_path / VAULT_FILE)
    before = _files(tmp_path)
    assert f"{VAULT_FILE}-wal" in before

    database = Database(tmp_path)
    with pytest.raises(StorageError, match="integrity check"):
        await database.prepare()
    await database.dispose()

    assert _files(tmp_path) == before


async def test_a_restore_keeps_the_wal_of_a_damaged_vault(tmp_path: Path) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        await _populate(client, [f"entry-{i}" for i in range(50)])
    saved = storage.snapshot(folder, tmp_path / "saved.db")
    crash_after_committing(folder, "UPDATE settings SET hidden_ms = 4242")
    corrupt_name_index(folder / VAULT_FILE)
    wal = (folder / f"{VAULT_FILE}-wal").read_bytes()

    kept = storage.restore(folder, saved)

    assert kept is not None and kept.is_dir()
    assert (kept / f"{VAULT_FILE}-wal").read_bytes() == wal
    assert check_file(folder / VAULT_FILE) == []


async def test_a_restore_never_replays_the_old_wal_into_the_restored_vault(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "data"
    async with client_for_data_dir(folder) as client:
        await _populate(client, ["alpha"])
    saved = storage.snapshot(folder, tmp_path / "saved.db")
    crash_after_committing(folder, "UPDATE settings SET hidden_ms = 4242")

    kept = storage.restore(folder, saved)

    assert not (folder / f"{VAULT_FILE}-wal").exists()
    assert check_file(folder / VAULT_FILE) == []
    assert _pragma(folder / VAULT_FILE, "user_version") == SCHEMA_VERSION
    with closing(sqlite3.connect(folder / VAULT_FILE)) as connection:
        assert connection.execute("SELECT hidden_ms FROM settings").fetchone() == (
            SETTINGS_DEFAULTS["hidden_ms"],
        )
        assert connection.execute("SELECT count(*) FROM entries").fetchone() == (1,)
    assert kept is not None
    with closing(sqlite3.connect(kept / VAULT_FILE)) as connection:
        assert connection.execute("SELECT hidden_ms FROM settings").fetchone() == (
            4242,
        )


def test_busy_errors_are_recognised_by_their_primary_code() -> None:
    def error(code: int) -> OperationalError:
        orig = sqlite3.OperationalError("database is locked")
        orig.sqlite_errorcode = code
        return OperationalError("statement", {}, orig)

    assert is_busy(error(5))
    assert is_busy(error(517))
    assert is_busy(error(6))
    assert not is_busy(error(1))


async def test_checking_a_vault_without_a_wal_leaves_its_file_byte_for_byte(
    tmp_path: Path,
) -> None:
    await (await _prepared(tmp_path)).dispose()
    vault = tmp_path / VAULT_FILE
    assert not (tmp_path / f"{VAULT_FILE}-wal").exists()
    with closing(sqlite3.connect(vault)) as connection:
        connection.execute("PRAGMA user_version=99")
        connection.commit()
    before = vault.read_bytes()

    database = Database(tmp_path)
    with pytest.raises(StorageError, match="newer CipherMoth"):
        await database.prepare()
    await database.dispose()
    assert check_file(vault)

    assert vault.read_bytes() == before
    wal = tmp_path / f"{VAULT_FILE}-wal"
    assert not wal.exists() or wal.stat().st_size == 0
