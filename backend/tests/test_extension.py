import httpx
import pytest

from tests.support import auth, entry
from tests.test_folder_access import (
    MEMBER_PASSWORD,
    bootstrap,
    create_folder,
    create_folder_entry,
    create_user,
)


@pytest.mark.asyncio
async def test_extension_session_enforces_scope_origin_and_live_folder_acl(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "extension-member")
    folder = await create_folder(client, owner_headers, "Extension ACL")
    shared = await create_folder_entry(
        client,
        owner_headers,
        folder,
        "shared-login",
        "shared-secret",
    )
    private = await client.post(
        "/passwords/create",
        json=entry(
            "private-login", "private-secret", url="https://portal.example.test"
        ),
        headers=owner_headers,
    )
    assert private.status_code == 200, private.text
    grant = await client.put(
        f"/folders/{folder['id']}/grants/users/{member['id']}",
        json={"permission": "read"},
        headers=owner_headers,
    )
    assert grant.status_code == 200, grant.text

    member_login = await client.post(
        "/auth/login",
        json={"username": "extension-member", "password": MEMBER_PASSWORD},
    )
    assert member_login.status_code == 200, member_login.text
    member_password = f"{MEMBER_PASSWORD}-extension-member"
    changed_member_password = await client.put(
        "/auth/password",
        json={"current_password": MEMBER_PASSWORD, "new_password": member_password},
        headers=auth(member_login.json()["session_token"]),
    )
    assert changed_member_password.status_code == 200, changed_member_password.text

    unlocked = await client.post(
        "/extension/unlock",
        json={
            "username": "extension-member",
            "password": member_password,
            "browser": "Firefox",
        },
    )
    assert unlocked.status_code == 200, unlocked.text
    extension_headers = auth(unlocked.json()["session_token"])

    denied_full_api = await client.get("/passwords", headers=extension_headers)
    assert denied_full_api.status_code == 403
    assert denied_full_api.json()["code"] == "extension_scope"

    denied_extension_api = await client.post(
        "/extension/matches",
        json={"origin": "https://portal.example.test"},
        headers=owner_headers,
    )
    assert denied_extension_api.status_code == 403
    assert denied_extension_api.json()["code"] == "extension_scope"

    before_url = await client.post(
        "/extension/matches",
        json={"origin": "https://portal.example.test"},
        headers=extension_headers,
    )
    assert before_url.status_code == 200, before_url.text
    assert before_url.json()["logins"] == []

    changed = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "shared-login"},
            "new_password": entry(
                "shared-login",
                "shared-secret",
                url="https://portal.example.test/login",
                folder=folder["name"],
                folder_id=folder["id"],
            ),
        },
        headers=owner_headers,
    )
    assert changed.status_code == 200, changed.text

    matches = await client.post(
        "/extension/matches",
        json={"origin": "https://portal.example.test"},
        headers=extension_headers,
    )
    assert matches.status_code == 200, matches.text
    assert [login["id"] for login in matches.json()["logins"]] == [shared["id"]]

    credential = await client.post(
        "/extension/credential",
        json={"id": shared["id"], "origin": "http://portal.example.test"},
        headers=extension_headers,
    )
    assert credential.status_code == 409
    assert credential.json()["code"] == "origin_mismatch"

    revoked = await client.delete(
        f"/folders/{folder['id']}/grants/users/{member['id']}", headers=owner_headers
    )
    assert revoked.status_code == 200, revoked.text
    stale = await client.post(
        "/extension/credential",
        json={"id": shared["id"], "origin": "https://portal.example.test"},
        headers=extension_headers,
    )
    assert stale.status_code == 404

    locked = await client.post("/extension/lock", headers=extension_headers)
    assert locked.status_code == 200, locked.text
    after_lock = await client.post(
        "/extension/matches",
        json={"origin": "https://portal.example.test"},
        headers=extension_headers,
    )
    assert after_lock.status_code == 401


@pytest.mark.asyncio
async def test_extension_handoff_is_one_time_and_bound(
    client: httpx.AsyncClient,
) -> None:
    _owner, web_headers = await bootstrap(client)
    request = "r" * 43
    tab = "t" * 43
    client_id = "c" * 22
    body = {
        "request": request,
        "tab": tab,
        "origin": "http://localhost:3000",
        "browser": "Chromium",
        "client": client_id,
    }
    started = await client.post("/extension/handoffs/start", json=body)
    assert started.status_code == 200, started.text
    wrong_origin = await client.post(
        "/extension/handoffs/approve",
        json={**body, "origin": "https://evil.example"},
        headers=web_headers,
    )
    assert wrong_origin.status_code == 403
    approved = await client.post(
        "/extension/handoffs/approve", json=body, headers=web_headers
    )
    assert approved.status_code == 200, approved.text
    wrong_tab = await client.post(
        "/extension/handoffs/redeem",
        json={
            "request": request,
            "tab": "x" * 43,
            "redeem": approved.json()["redeem"],
            "browser": "Chromium",
            "client": client_id,
        },
    )
    assert wrong_tab.status_code == 403
    replay = await client.post(
        "/extension/handoffs/redeem",
        json={
            "request": request,
            "tab": tab,
            "redeem": approved.json()["redeem"],
            "browser": "Chromium",
            "client": client_id,
        },
    )
    assert replay.status_code == 403

    fresh = {**body, "request": "n" * 43, "tab": "q" * 43}
    started_fresh = await client.post("/extension/handoffs/start", json=fresh)
    assert started_fresh.status_code == 200
    approval = await client.post(
        "/extension/handoffs/approve", json=fresh, headers=web_headers
    )
    session = await client.post(
        "/extension/handoffs/redeem",
        json={
            "request": fresh["request"],
            "tab": fresh["tab"],
            "redeem": approval.json()["redeem"],
            "browser": fresh["browser"],
            "client": fresh["client"],
        },
    )
    assert session.status_code == 200, session.text
    extension_headers = auth(session.json()["session_token"])
    assert (
        await client.get("/passwords", headers=extension_headers)
    ).status_code == 403
    assert (
        await client.post("/extension/session", headers=extension_headers)
    ).status_code == 200
