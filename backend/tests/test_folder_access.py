from datetime import UTC, datetime, timedelta

import httpx
import pytest

from tests.support import auth, db_execute, entry, reset_vault

ADMIN_PASSWORD = "Moth-Admin-Password-2026!"
MEMBER_PASSWORD = "Moth-Member-Password-2026!"


async def bootstrap(
    client: httpx.AsyncClient,
) -> tuple[dict, list[tuple[bytes, bytes]]]:
    response = await client.post(
        "/auth/bootstrap",
        json={"username": "owner", "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return body["user"], auth(body["session_token"])


async def create_user(
    client: httpx.AsyncClient,
    headers: list[tuple[bytes, bytes]],
    username: str,
    *,
    role: str = "member",
) -> dict:
    response = await client.post(
        "/users",
        json={
            "username": username,
            "role": role,
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def login(
    client: httpx.AsyncClient, username: str
) -> tuple[dict, list[tuple[bytes, bytes]]]:
    response = await client.post(
        "/auth/login", json={"username": username, "password": MEMBER_PASSWORD}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    headers = auth(body["session_token"])
    if not body["user"]["must_change_password"]:
        return body["user"], headers
    changed = await client.put(
        "/auth/password",
        json={
            "current_password": MEMBER_PASSWORD,
            "new_password": f"{MEMBER_PASSWORD}-{username}",
        },
        headers=headers,
    )
    assert changed.status_code == 200, changed.text
    return changed.json()["user"], auth(changed.json()["session_token"])


async def create_folder(
    client: httpx.AsyncClient,
    headers: list[tuple[bytes, bytes]],
    name: str = "Engineering",
) -> dict:
    response = await client.post("/folders", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def create_folder_entry(
    client: httpx.AsyncClient,
    headers: list[tuple[bytes, bytes]],
    folder: dict,
    name: str,
    value: str = "folder-secret",
) -> dict:
    response = await client.post(
        "/passwords/create",
        json=entry(
            name,
            value,
            folder=folder["name"],
            folder_id=folder["id"],
        ),
        headers=headers,
    )
    assert response.status_code == 200, response.text
    listed = await client.get("/passwords", headers=headers)
    assert listed.status_code == 200, listed.text
    return next(item for item in listed.json() if item["password_name"] == name)


@pytest.mark.asyncio
async def test_folder_grant_covers_future_entries_and_unions_with_direct_acl(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    folder = await create_folder(client, owner_headers)
    first = await create_folder_entry(client, owner_headers, folder, "first")

    assert (await client.get("/passwords", headers=member_headers)).json() == []
    granted = await client.put(
        f"/folders/{folder['id']}/grants/users/{member['id']}",
        json={"permission": "read"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text
    second = await create_folder_entry(client, owner_headers, folder, "second")
    assert {
        item["password_name"]
        for item in (await client.get("/passwords", headers=member_headers)).json()
    } == {"first", "second"}

    denied = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "first"},
            "new_password": entry(
                "first",
                "denied",
                folder=folder["name"],
                folder_id=folder["id"],
            ),
        },
        headers=member_headers,
    )
    assert denied.status_code == 403

    direct = await client.put(
        f"/passwords/{first['id']}/shares/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert direct.status_code == 200, direct.text
    updated = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "first"},
            "new_password": entry(
                "first",
                "changed",
                folder=folder["name"],
                folder_id=folder["id"],
            ),
        },
        headers=member_headers,
    )
    assert updated.status_code == 200, updated.text

    relinquished = await client.delete(
        f"/passwords/{first['id']}/access", headers=member_headers
    )
    assert relinquished.status_code == 200, relinquished.text
    assert relinquished.json()["direct_access_relinquished"] is True
    assert relinquished.json()["effective_access"] == "read"
    assert (
        await client.get("/passwords/first", headers=member_headers)
    ).status_code == 200

    expired = datetime.now(UTC) - timedelta(minutes=1)
    await db_execute(
        "UPDATE folder_user_access SET expires_at = :expired "
        "WHERE folder_id = :folder_id AND user_id = :user_id",
        expired=expired,
        folder_id=folder["id"],
        user_id=member["id"],
    )
    assert (await client.get("/passwords", headers=member_headers)).json() == []
    sources = await client.get("/passwords/access", headers=member_headers)
    assert sources.status_code == 200, sources.text
    assert sources.json() == []

    grants = await client.get(f"/folders/{folder['id']}/grants", headers=owner_headers)
    assert grants.status_code == 200, grants.text
    [grant] = grants.json()
    assert grant["expired"] is True
    assert second["folder_id"] == folder["id"]


@pytest.mark.asyncio
async def test_admin_can_manage_any_folder_without_implicit_secret_access(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    admin = await create_user(client, owner_headers, "second-admin", role="admin")
    _, member_headers = await login(client, "member")
    _, admin_headers = await login(client, "second-admin")
    folder = await create_folder(client, owner_headers, "Finance")
    await create_folder_entry(client, owner_headers, folder, "payroll")

    assert (await client.get("/passwords", headers=admin_headers)).json() == []
    [admin_folder] = (await client.get("/folders", headers=admin_headers)).json()
    assert admin_folder["id"] == folder["id"]
    assert admin_folder["can_manage"] is True
    assert admin_folder["access"] is None

    granted = await client.put(
        f"/folders/{folder['id']}/grants/users/{member['id']}",
        json={"permission": "read"},
        headers=admin_headers,
    )
    assert granted.status_code == 200, granted.text
    assert [
        item["password_name"]
        for item in (await client.get("/passwords", headers=member_headers)).json()
    ] == ["payroll"]
    assert (await client.get("/passwords", headers=admin_headers)).json() == []

    user_access = await client.get(
        f"/users/{member['id']}/folder-access", headers=admin_headers
    )
    assert user_access.status_code == 200, user_access.text
    [access] = user_access.json()
    assert access["folder"]["id"] == folder["id"]
    assert access["effective_permission"] == "read"
    assert any(source["source"] == "direct" for source in access["sources"])

    audit = await client.get(f"/folders/{folder['id']}/audit", headers=admin_headers)
    assert audit.status_code == 200, audit.text
    assert any(
        event["action"] == "folder_user_grant_created"
        and event["actor_username"] == "second-admin"
        for event in audit.json()
    )
    assert admin["id"] != member["id"]


@pytest.mark.asyncio
async def test_group_grant_and_membership_revocation_change_effective_access(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    folder = await create_folder(client, owner_headers, "Operations")
    await create_folder_entry(client, owner_headers, folder, "router")

    group = await client.post(
        "/groups", json={"name": "Operators"}, headers=owner_headers
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]
    added = await client.put(
        f"/groups/{group_id}/members/{member['id']}", headers=owner_headers
    )
    assert added.status_code == 200, added.text
    granted = await client.put(
        f"/folders/{folder['id']}/grants/groups/{group_id}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text

    [shared] = (await client.get("/passwords", headers=member_headers)).json()
    assert shared["password_name"] == "router"
    [access] = (await client.get("/passwords/access", headers=member_headers)).json()
    assert access["access"] == "write"
    assert any(source["source"] == "group" for source in access["sources"])

    removed = await client.delete(
        f"/groups/{group_id}/members/{member['id']}", headers=owner_headers
    )
    assert removed.status_code == 200, removed.text
    assert (await client.get("/passwords", headers=member_headers)).json() == []


@pytest.mark.asyncio
async def test_folder_rename_move_and_delete_keep_entry_links_consistent(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    source = await create_folder(client, owner_headers, "Source")
    target = await create_folder(client, owner_headers, "Target")
    await create_folder_entry(client, owner_headers, source, "movable")
    granted = await client.put(
        f"/folders/{source['id']}/grants/users/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text

    denied_move = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "movable"},
            "new_password": entry(
                "movable",
                "folder-secret",
                folder=target["name"],
                folder_id=target["id"],
            ),
        },
        headers=member_headers,
    )
    assert denied_move.status_code == 403

    renamed = await client.patch(
        f"/folders/{source['id']}",
        json={"name": "Renamed source"},
        headers=owner_headers,
    )
    assert renamed.status_code == 200, renamed.text
    visible = await client.get("/passwords/movable", headers=member_headers)
    assert visible.status_code == 200, visible.text
    assert visible.json()["folder"] == "Renamed source"
    assert visible.json()["folder_id"] == source["id"]

    mismatched = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "movable"},
            "new_password": entry(
                "movable",
                "folder-secret",
                folder="Wrong name",
                folder_id=target["id"],
            ),
        },
        headers=owner_headers,
    )
    assert mismatched.status_code == 400

    moved = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "movable"},
            "new_password": entry(
                "movable",
                "folder-secret",
                folder=target["name"],
                folder_id=target["id"],
            ),
        },
        headers=owner_headers,
    )
    assert moved.status_code == 200, moved.text
    assert (await client.get("/passwords", headers=member_headers)).json() == []

    removed = await client.delete(f"/folders/{source['id']}", headers=owner_headers)
    assert removed.status_code == 200, removed.text
    nonempty = await client.delete(f"/folders/{target['id']}", headers=owner_headers)
    assert nonempty.status_code == 400


@pytest.mark.asyncio
async def test_backup_restores_folder_identity_and_entry_links(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    populated = await create_folder(client, owner_headers, "Populated")
    await create_folder(client, owner_headers, "Empty")
    await create_folder_entry(client, owner_headers, populated, "backed-up")
    backup = await client.post(
        "/passwords/backup",
        json={"master_password": ADMIN_PASSWORD},
        headers=owner_headers,
    )
    assert backup.status_code == 200, backup.text

    await reset_vault()
    _owner, restored_headers = await bootstrap(client)
    restored = await client.post(
        "/passwords/import",
        files={"file": ("vault.cmbackup", backup.content, "application/octet-stream")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "skip"},
        headers=restored_headers,
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["imported"] == 1

    folders = (await client.get("/folders", headers=restored_headers)).json()
    assert {folder["name"] for folder in folders} == {"Populated", "Empty"}
    [restored_entry] = (await client.get("/passwords", headers=restored_headers)).json()
    restored_folder = next(
        folder for folder in folders if folder["name"] == "Populated"
    )
    assert restored_entry["folder"] == "Populated"
    assert restored_entry["folder_id"] == restored_folder["id"]


@pytest.mark.asyncio
async def test_non_admin_folder_owner_can_share_with_an_existing_group(
    client: httpx.AsyncClient,
) -> None:
    _owner, admin_headers = await bootstrap(client)
    folder_owner = await create_user(client, admin_headers, "folder-owner")
    recipient = await create_user(client, admin_headers, "recipient")
    group = await client.post(
        "/groups", json={"name": "Project team"}, headers=admin_headers
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]
    added = await client.put(
        f"/groups/{group_id}/members/{recipient['id']}", headers=admin_headers
    )
    assert added.status_code == 200, added.text

    _, folder_owner_headers = await login(client, "folder-owner")
    _, recipient_headers = await login(client, "recipient")
    listed_groups = await client.get("/groups", headers=folder_owner_headers)
    assert listed_groups.status_code == 200, listed_groups.text
    assert [item["name"] for item in listed_groups.json()] == ["Project team"]

    folder = await create_folder(client, folder_owner_headers, "Owned by member")
    await create_folder_entry(
        client, folder_owner_headers, folder, "member-owned-entry"
    )
    granted = await client.put(
        f"/folders/{folder['id']}/grants/groups/{group_id}",
        json={"permission": "read"},
        headers=folder_owner_headers,
    )
    assert granted.status_code == 200, granted.text
    [shared] = (await client.get("/passwords", headers=recipient_headers)).json()
    assert shared["password_name"] == "member-owned-entry"
    assert shared["access"] == "read"
    assert folder_owner["id"] == folder["owner_id"]


@pytest.mark.asyncio
async def test_shared_folder_writer_creates_an_entry_owned_by_the_folder_owner(
    client: httpx.AsyncClient,
) -> None:
    owner, owner_headers = await bootstrap(client)
    writer = await create_user(client, owner_headers, "writer")
    _, writer_headers = await login(client, "writer")
    folder = await create_folder(client, owner_headers, "Shared work")
    granted = await client.put(
        f"/folders/{folder['id']}/grants/users/{writer['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text

    created = await create_folder_entry(
        client, writer_headers, folder, "created-by-writer"
    )
    assert created["owner_id"] == owner["id"]
    assert created["access"] == "write"

    owner_entry = await client.get(
        "/passwords/created-by-writer", headers=owner_headers
    )
    assert owner_entry.status_code == 200, owner_entry.text
    assert owner_entry.json()["access"] == "owner"


@pytest.mark.asyncio
async def test_relinquish_and_group_membership_changes_are_audited(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    folder = await create_folder(client, owner_headers, "Audit")
    entry_response = await create_folder_entry(client, owner_headers, folder, "audited")
    shared = await client.put(
        f"/passwords/{entry_response['id']}/shares/{member['id']}",
        json={"permission": "read"},
        headers=owner_headers,
    )
    assert shared.status_code == 200, shared.text
    relinquished = await client.delete(
        f"/passwords/{entry_response['id']}/access", headers=member_headers
    )
    assert relinquished.status_code == 200, relinquished.text
    entry_audit = await client.get(
        f"/passwords/{entry_response['id']}/audit", headers=owner_headers
    )
    assert any(
        event["action"] == "entry_grant_relinquished"
        and event["target_user_id"] == member["id"]
        for event in entry_audit.json()
    )

    group = await client.post(
        "/groups", json={"name": "Audited group"}, headers=owner_headers
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]
    assert (
        await client.put(
            f"/groups/{group_id}/members/{member['id']}", headers=owner_headers
        )
    ).status_code == 200
    audit = await client.get(f"/groups/{group_id}/audit", headers=owner_headers)
    assert audit.status_code == 200, audit.text
    assert any(
        event["action"] == "group_member_added"
        and event["target_user_id"] == member["id"]
        for event in audit.json()
    )


@pytest.mark.asyncio
async def test_grant_expiry_requires_future_timezone_and_removes_effective_access(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "expiring-member")
    _, member_headers = await login(client, "expiring-member")
    folder = await create_folder(client, owner_headers, "Temporary")
    created = await create_folder_entry(
        client, owner_headers, folder, "temporary-secret"
    )

    for invalid_expiry in (
        (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
        (datetime.now(UTC) + timedelta(hours=1)).replace(tzinfo=None).isoformat(),
    ):
        rejected = await client.put(
            f"/folders/{folder['id']}/grants/users/{member['id']}",
            json={"permission": "read", "expires_at": invalid_expiry},
            headers=owner_headers,
        )
        assert rejected.status_code == 422, rejected.text

    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    granted = await client.put(
        f"/passwords/{created['id']}/shares/{member['id']}",
        json={"permission": "read", "expires_at": future},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text
    assert (await client.get("/passwords", headers=member_headers)).status_code == 200

    await db_execute(
        "UPDATE entry_access SET expires_at = :expired "
        "WHERE entry_id = :entry_id AND user_id = :user_id",
        expired=datetime.now(UTC) - timedelta(minutes=1),
        entry_id=created["id"],
        user_id=member["id"],
    )
    assert (await client.get("/passwords", headers=member_headers)).json() == []
