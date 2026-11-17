import sqlite3
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

import storage
from schemas import SettingsUpdate
from settings import SETTINGS_DEFAULTS, get_storage_settings, get_vault_defaults
from tests.support import (
    auth,
    client_for_data_dir,
    create_vault,
    db_execute,
    entry,
    unlock,
)
from vault_admin import app as admin_app


@pytest.fixture
def env_defaults(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("NEDRA_INACTIVITY_MS", "900000")
    monkeypatch.setenv("NEDRA_HIDDEN_MS", "600000")
    monkeypatch.setenv("NEDRA_UPDATE_CHECK_ENABLED", "false")
    get_vault_defaults.cache_clear()
    try:
        yield
    finally:
        get_vault_defaults.cache_clear()
        get_storage_settings.cache_clear()


async def test_env_defaults_apply_without_materializing_overrides(
    client: httpx.AsyncClient, env_defaults: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    await db_execute("DELETE FROM settings")
    token = await create_vault(client)
    expected = {
        **SETTINGS_DEFAULTS,
        "inactivity_ms": 900_000,
        "hidden_ms": 600_000,
        "update_check_enabled": False,
    }
    response = await client.get("/settings", headers=auth(token))
    assert response.status_code == 200
    assert response.json() == expected
    assert SettingsUpdate(**expected).model_dump() == expected
    status = await client.get("/master_password/session", headers=auth(token))
    assert status.status_code == 200
    assert status.json()["idle_timeout_ms"] == 900_000
    assert 890_000 < status.json()["expires_in_ms"] <= 900_000
    assert await db_execute("SELECT id FROM settings") == []

    # Simulate a new process reading changed deployment defaults. Reading the
    # previous defaults must not have frozen them into the database.
    monkeypatch.setenv("NEDRA_INACTIVITY_MS", "1200000")
    get_vault_defaults.cache_clear()
    response = await client.get("/settings", headers=auth(token))
    assert response.json()["inactivity_ms"] == 1_200_000
    assert await db_execute("SELECT id FROM settings") == []


async def test_admin_override_wins_and_survives_reopen(
    tmp_path: Path, env_defaults: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    override = {
        **SETTINGS_DEFAULTS,
        "inactivity_ms": 180_000,
        "hidden_ms": 120_000,
        "update_check_enabled": False,
    }
    async with client_for_data_dir(tmp_path) as client:
        token = await create_vault(client)
        response = await client.patch("/settings", json=override, headers=auth(token))
        assert response.status_code == 200
        assert response.json() == override

    monkeypatch.setenv("NEDRA_INACTIVITY_MS", "1200000")
    get_vault_defaults.cache_clear()
    async with client_for_data_dir(tmp_path) as client:
        token = await unlock(client)
        response = await client.get("/settings", headers=auth(token))
        assert response.json() == override
        status = await client.get("/master_password/session", headers=auth(token))
        assert status.json()["idle_timeout_ms"] == 180_000


async def test_existing_stored_defaults_are_preserved_as_overrides(
    client: httpx.AsyncClient, env_defaults: None
) -> None:
    # The shared compatibility fixture deliberately contains an old stored row.
    token = await create_vault(client)
    response = await client.get("/settings", headers=auth(token))
    assert response.status_code == 200
    assert response.json() == SETTINGS_DEFAULTS
    status = await client.get("/master_password/session", headers=auth(token))
    assert status.json()["idle_timeout_ms"] == SETTINGS_DEFAULTS["inactivity_ms"]


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("INACTIVITY_MS", "not-a-number"),
        ("INACTIVITY_MS", "0"),
        ("INACTIVITY_MS", "3600001"),
        ("HIDDEN_MS", "9999"),
        ("HIDDEN_MS", "3600001"),
        ("WARN_BEFORE_MS", "4999"),
        ("WARN_BEFORE_MS", "600001"),
        ("DEBOUNCE_MS", "99"),
        ("DEBOUNCE_MS", "10001"),
        ("CLIPBOARD_CLEAR_MS", "4999"),
        ("CLIPBOARD_CLEAR_MS", "600001"),
        ("UPDATE_CHECK_ENABLED", "maybe"),
    ],
)
def test_invalid_env_is_refused(
    env_defaults: None, monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    monkeypatch.setenv(f"NEDRA_{name}", value)
    with pytest.raises(ValidationError):
        get_vault_defaults()


def test_warning_must_precede_idle_lock(
    env_defaults: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NEDRA_INACTIVITY_MS", "60000")
    monkeypatch.setenv("NEDRA_WARN_BEFORE_MS", "60000")
    with pytest.raises(ValidationError, match="shorter than inactivity_ms"):
        get_vault_defaults()


async def test_native_reset_is_guarded_snapshotted_and_preserves_vault(
    tmp_path: Path, env_defaults: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NEDRA_DATA_DIR", str(tmp_path))
    get_storage_settings.cache_clear()
    override = {**SETTINGS_DEFAULTS, "inactivity_ms": 180_000}
    async with client_for_data_dir(tmp_path) as client:
        token = await create_vault(client)
        response = await client.post(
            "/passwords/create",
            json=entry("settings-reset-survivor"),
            headers=auth(token),
        )
        assert response.status_code == 200
        response = await client.patch("/settings", json=override, headers=auth(token))
        assert response.status_code == 200

        # Hold the same ownership lock as the real backend lifespan. This
        # in-process API helper intentionally does not enter that lifespan.
        with storage.VaultLock(tmp_path):
            refused = CliRunner().invoke(admin_app, ["reset-settings", "--yes"])
        assert refused.exit_code == 1
        assert "Another Nedra process" in refused.output
        assert not (tmp_path / "snapshots").exists()
        assert (await client.get("/settings", headers=auth(token))).json() == override

    result = CliRunner().invoke(admin_app, ["reset-settings", "--yes"])
    assert result.exit_code == 0, result.output
    snapshots = list((tmp_path / "snapshots").glob("vault-*.db"))
    assert len(snapshots) == 1
    saved = snapshots[0]
    assert storage.check_file(saved) == []
    assert storage.check_file(tmp_path / storage.VAULT_FILE) == []
    with closing(sqlite3.connect(saved)) as before:
        with closing(sqlite3.connect(tmp_path / storage.VAULT_FILE)) as after:
            assert before.execute("SELECT inactivity_ms FROM settings").fetchall() == [
                (180_000,)
            ]
            assert after.execute("SELECT id FROM settings").fetchall() == []
            tables = before.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name!='settings'"
            ).fetchall()
            for (table,) in tables:
                assert (
                    before.execute(f'SELECT * FROM "{table}"').fetchall()
                    == after.execute(f'SELECT * FROM "{table}"').fetchall()
                ), table
    async with client_for_data_dir(tmp_path) as client:
        token = await unlock(client)
        response = await client.get("/settings", headers=auth(token))
        assert response.json() == get_vault_defaults().model_dump()
        response = await client.get(
            "/passwords/settings-reset-survivor", headers=auth(token)
        )
        assert response.status_code == 200
        assert response.json()["password_name"] == "settings-reset-survivor"
