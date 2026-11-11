import pytest

from tests.support import (
    MASTER_PASSWORD,
    NEW_MASTER_PASSWORD,
    auth,
    create_vault,
    db_execute,
)


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


@pytest.mark.anyio
async def test_admin_reset_revokes_user_recovery_and_all_old_sessions(client):
    owner = await client.post(
        "/auth/bootstrap",
        json={"username": "owner", "password": MASTER_PASSWORD},
    )
    assert owner.status_code == 200, owner.text
    owner_body = owner.json()
    owner_headers = auth(owner_body["session_token"])
    created = await client.post(
        "/users",
        json={
            "username": "member",
            "role": "member",
            "temporary_password": MASTER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert created.status_code == 200, created.text
    member_id = created.json()["id"]

    first_login = await client.post(
        "/auth/login",
        json={"username": "member", "password": MASTER_PASSWORD},
    )
    assert first_login.status_code == 200, first_login.text
    changed = await client.put(
        "/auth/password",
        json={"current_password": MASTER_PASSWORD, "new_password": NEW_MASTER_PASSWORD},
        headers=auth(first_login.json()["session_token"]),
    )
    assert changed.status_code == 200, changed.text
    first_headers = auth(changed.json()["session_token"])
    recovery = await client.post(
        "/auth/recovery",
        json={"current_password": NEW_MASTER_PASSWORD},
        headers=first_headers,
    )
    assert recovery.status_code == 200, recovery.text
    recovery_code = recovery.json()["recovery_code"]

    second_login = await client.post(
        "/auth/login",
        json={"username": "member", "password": NEW_MASTER_PASSWORD},
    )
    assert second_login.status_code == 200, second_login.text
    second_headers = auth(second_login.json()["session_token"])
    reset = await client.put(
        f"/users/{member_id}/password",
        json={"temporary_password": MASTER_PASSWORD},
        headers=owner_headers,
    )
    assert reset.status_code == 200, reset.text
    assert reset.json()["must_change_password"] is True

    for stale_headers in (first_headers, second_headers):
        assert (await client.get("/auth/me", headers=stale_headers)).status_code == 401
    rejected_recovery = await client.post(
        "/auth/recover",
        json={
            "username": "member",
            "recovery_code": recovery_code,
            "new_password": NEW_MASTER_PASSWORD,
        },
    )
    assert rejected_recovery.status_code == 200
    assert rejected_recovery.json()["valid"] is False

    reset_login = await client.post(
        "/auth/login",
        json={"username": "member", "password": MASTER_PASSWORD},
    )
    assert reset_login.status_code == 200, reset_login.text
    assert reset_login.json()["user"]["must_change_password"] is True
    status = await client.get(
        "/auth/recovery", headers=auth(reset_login.json()["session_token"])
    )
    assert status.status_code == 200, status.text
    assert status.json()["configured"] is False
    expected_audit = [
        (owner_body["user"]["id"], "user_password_reset", "user", member_id, member_id)
    ]
    assert (
        await db_execute(
            "SELECT actor_user_id, action, resource_type, resource_id, target_user_id "
            "FROM access_audit WHERE action = 'user_password_reset'"
        )
        == expected_audit
    )
