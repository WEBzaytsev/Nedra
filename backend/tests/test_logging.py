import logging

import httpx
import pytest

from crud.password import PasswordCRUD
from tests.support import (
    MASTER_PASSWORD,
    auth,
    create_vault,
    entry,
    retired_key_header,
    stored_vault_key,
)

SECRET_NAME = "bank-of-moth-private"
SECRET_QUERY = "query-secret-7f3a"
SECRET_MESSAGE = "row value hunter2-plaintext"


CLIENT_LOGGERS = ("httpx", "httpcore")


@pytest.fixture
def capture_all(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG)
    return caplog


def server_logs(caplog: pytest.LogCaptureFixture) -> str:
    return "\n".join(
        caplog.handler.format(record)
        for record in caplog.records
        if not record.name.startswith(CLIENT_LOGGERS)
    )


async def test_unhandled_errors_log_the_route_template_not_the_request(
    client: httpx.AsyncClient,
    capture_all: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = await create_vault(client)
    resp = await client.post(
        "/passwords/create", json=entry(SECRET_NAME), headers=auth(key)
    )
    assert resp.status_code == 200

    async def explode(self, password_name, key_derivation):
        try:
            raise ValueError(f"inner {SECRET_MESSAGE} for {password_name}")
        except ValueError as exc:
            raise RuntimeError(f"failed on {password_name}: {SECRET_MESSAGE}") from exc

    monkeypatch.setattr(PasswordCRUD, "get_password", explode)
    capture_all.clear()

    resp = await client.get(
        f"/passwords/{SECRET_NAME}",
        params={"q": SECRET_QUERY},
        headers=auth(key),
    )

    assert resp.status_code == 500
    assert resp.json() == {"detail": "An internal server error occurred."}
    assert resp.headers["cache-control"] == "no-store"
    logged = server_logs(capture_all)
    assert "api.endpoints.password.get_password (/{password_name})" in logged
    assert "RuntimeError" in logged
    vault_key = await stored_vault_key()
    for secret in (SECRET_NAME, SECRET_QUERY, SECRET_MESSAGE, key, vault_key):
        assert secret not in logged


async def test_database_errors_do_not_leak_statement_parameters(
    client: httpx.AsyncClient,
    capture_all: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = await create_vault(client)

    async def bad_flush(self, *args, **kwargs):
        raise RuntimeError(f"[parameters: ('{SECRET_NAME}', b'gAAAA')]")

    monkeypatch.setattr("sqlalchemy.ext.asyncio.AsyncSession.flush", bad_flush)
    capture_all.clear()

    resp = await client.post(
        "/passwords/create", json=entry(SECRET_NAME), headers=auth(key)
    )

    assert resp.status_code == 500
    logged = server_logs(capture_all)
    assert SECRET_NAME not in logged
    assert "api.endpoints.password.create_password" in logged


async def test_rejected_keys_are_not_logged(
    client: httpx.AsyncClient, capture_all: pytest.LogCaptureFixture
) -> None:
    token = await create_vault(client)
    key = await stored_vault_key()
    forged = key[:-6] + "AAAAA="
    capture_all.clear()

    for value in (key, forged):
        for headers in (
            retired_key_header(value),
            auth(token) + retired_key_header(value),
        ):
            resp = await client.get("/passwords", headers=headers)
            assert resp.status_code == 403
    resp = await client.post(
        "/master_password/check", json={"master_password": MASTER_PASSWORD}
    )
    assert resp.status_code == 410

    logged = server_logs(capture_all)
    assert forged not in logged
    assert key not in logged
    assert token not in logged
    assert MASTER_PASSWORD not in logged


async def test_session_tokens_and_keys_are_never_logged(
    client: httpx.AsyncClient, capture_all: pytest.LogCaptureFixture
) -> None:
    capture_all.clear()
    token = await create_vault(client)
    vault_key = await stored_vault_key()
    forged = token[:-4] + "AAAA"
    for headers in (auth(token), auth(forged)):
        await client.get("/passwords", headers=headers)
        await client.get("/master_password/session", headers=headers)
    await client.post("/master_password/lock", headers=auth(token))
    resp = await client.get("/passwords", headers=auth(token))

    assert resp.status_code == 401
    logged = server_logs(capture_all)
    for secret in (token, forged, vault_key, token[:16]):
        assert secret not in logged
