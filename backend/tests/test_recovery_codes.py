import pytest

from tests.support import MASTER_PASSWORD, NEW_MASTER_PASSWORD, auth, create_vault


@pytest.mark.anyio
async def test_recovery_code_is_one_time_and_replaces_sessions(client):
    token = await create_vault(client)
    created = await client.post(
        "/auth/recovery",
        json={"current_password": MASTER_PASSWORD},
        headers=auth(token),
    )
    assert created.status_code == 200, created.text
    code = created.json()["recovery_code"]
    assert len(code.replace("-", "")) == 32

    recovered = await client.post(
        "/auth/recover",
        json={
            "username": "admin",
            "recovery_code": code.lower(),
            "new_password": NEW_MASTER_PASSWORD,
        },
    )
    assert recovered.status_code == 200, recovered.text
    body = recovered.json()
    assert body["valid"] is True
    assert body["recovery_code"] != code
    assert (await client.get("/auth/me", headers=auth(token))).status_code == 401

    reused = await client.post(
        "/auth/recover",
        json={
            "username": "admin",
            "recovery_code": code,
            "new_password": MASTER_PASSWORD,
        },
    )
    assert reused.status_code == 200
    assert reused.json() == {
        "valid": False,
        "user": None,
        "session_token": None,
        "idle_timeout_ms": None,
        "recovery_code": None,
    }


@pytest.mark.anyio
async def test_revoke_recovery_code_fails_closed(client):
    token = await create_vault(client)
    created = await client.post(
        "/auth/recovery",
        json={"current_password": MASTER_PASSWORD},
        headers=auth(token),
    )
    code = created.json()["recovery_code"]
    revoked = await client.request(
        "DELETE",
        "/auth/recovery",
        json={"current_password": MASTER_PASSWORD},
        headers=auth(token),
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["configured"] is False
    recovered = await client.post(
        "/auth/recover",
        json={
            "username": "admin",
            "recovery_code": code,
            "new_password": NEW_MASTER_PASSWORD,
        },
    )
    assert recovered.status_code == 200
    assert recovered.json()["valid"] is False
