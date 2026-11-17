import base64
import io
import json
import random

import httpx
import pytest
import pyzipper

from main import app
from tests.support import auth, db_execute, entry

ADMIN_PASSWORD = "Moth-Admin-Password-2026!"
MEMBER_PASSWORD = "Moth-Member-Password-2026!"
MIB = 1024 * 1024


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


async def raw_login(
    client: httpx.AsyncClient, username: str, password: str
) -> tuple[dict, list[tuple[bytes, bytes]]]:
    response = await client.post(
        "/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["valid"] is True
    return body["user"], auth(body["session_token"])


async def login(
    client: httpx.AsyncClient, username: str, password: str
) -> tuple[dict, list[tuple[bytes, bytes]]]:
    user, headers = await raw_login(client, username, password)
    if not user["must_change_password"]:
        return user, headers
    changed_password = f"{password}-changed"
    response = await client.put(
        "/auth/password",
        json={"current_password": password, "new_password": changed_password},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return body["user"], auth(body["session_token"])


async def test_entry_draft_key_survives_reauthentication_and_password_change(
    client: httpx.AsyncClient,
) -> None:
    user, headers = await bootstrap(client)
    first = await client.get("/auth/entry-draft-key", headers=headers)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "no-store"
    assert first.json()["user_id"] == user["id"]
    key = base64.b64decode(first.json()["key"], validate=True)
    assert len(key) == 32
    await client.post("/auth/logout", headers=headers)
    assert (
        await client.get("/auth/entry-draft-key", headers=headers)
    ).status_code == 401
    _, headers = await login(client, "owner", ADMIN_PASSWORD)
    second = await client.get("/auth/entry-draft-key", headers=headers)
    assert second.json() == first.json()
    changed = await client.put(
        "/auth/password",
        json={"current_password": ADMIN_PASSWORD, "new_password": MEMBER_PASSWORD},
        headers=headers,
    )
    assert changed.status_code == 200
    headers = auth(changed.json()["session_token"])
    assert (
        await client.get("/auth/entry-draft-key", headers=headers)
    ).json() == first.json()
    assert (await client.get("/passwords", headers=headers)).json() == []


def test_entry_draft_keys_are_separated_from_vault_keys_and_other_accounts() -> None:
    from helpers import VaultKey

    raw = bytes(range(32))
    key = VaultKey(raw)
    assert key.entry_draft_key(1) not in (raw, key.check, key.name_index("draft"))
    assert key.entry_draft_key(1) != key.entry_draft_key(2)
    assert key.entry_draft_key(1) == VaultKey(raw).entry_draft_key(1)
    assert key.entry_draft_key(1) != VaultKey(bytes(reversed(raw))).entry_draft_key(1)


def legacy_migration_archive(attachments: list[bytes]) -> bytes:
    stamp = "2026-10-20T12:00:00Z"
    payload = json.dumps(
        {
            "migration_version": 1,
            "exported_at": stamp,
            "passwords": [
                {
                    "legacy_id": 41,
                    "owner_username": "owner",
                    "access": "owner",
                    "created": stamp,
                    "updated": stamp,
                    "deleted": None,
                    "name": "attachment migration",
                    "kind": "login",
                    "username": "legacy-user",
                    "value": "legacy-value",
                    "url": None,
                    "totp_secret": None,
                    "description": None,
                    "tags": [],
                    "custom_fields": [],
                    "folder": None,
                    "favorite": False,
                    "password_history": [],
                    "shares": [],
                    "attachments": [
                        {
                            "filename": f"legacy-{index}.bin",
                            "content_type": "application/octet-stream",
                            "created": stamp,
                            "data": base64.urlsafe_b64encode(content)
                            .decode()
                            .rstrip("="),
                        }
                        for index, content in enumerate(attachments)
                    ],
                }
            ],
        }
    ).encode()
    archive = io.BytesIO()
    with pyzipper.AESZipFile(
        archive,
        "w",
        compression=pyzipper.ZIP_DEFLATED,
        encryption=pyzipper.WZ_AES,
    ) as backup:
        backup.setpassword(ADMIN_PASSWORD.encode())
        backup.setencryption(pyzipper.WZ_AES, nbits=256)
        backup.writestr("ciphermoth_backup.json", payload)
    return archive.getvalue()


@pytest.mark.asyncio
async def test_required_password_change_gates_vault_until_completed(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    created = await client.post(
        "/users",
        json={
            "username": "member",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert created.status_code == 200, created.text

    member, temporary_headers = await raw_login(client, "member", MEMBER_PASSWORD)
    assert member["must_change_password"] is True
    assert (await client.get("/auth/me", headers=temporary_headers)).status_code == 200

    blocked = await client.get("/passwords", headers=temporary_headers)
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == (
        "Password change is required before accessing the vault."
    )

    unchanged = await client.put(
        "/auth/password",
        json={"current_password": MEMBER_PASSWORD, "new_password": MEMBER_PASSWORD},
        headers=temporary_headers,
    )
    assert unchanged.status_code == 400
    assert (
        await client.get("/passwords", headers=temporary_headers)
    ).status_code == 403

    changed = await client.put(
        "/auth/password",
        json={
            "current_password": MEMBER_PASSWORD,
            "new_password": f"{MEMBER_PASSWORD}-changed",
        },
        headers=temporary_headers,
    )
    assert changed.status_code == 200, changed.text
    changed_body = changed.json()
    assert changed_body["user"]["must_change_password"] is False
    changed_headers = auth(changed_body["session_token"])
    assert (await client.get("/passwords", headers=changed_headers)).status_code == 200

    required = await client.post(
        f"/users/{created.json()['id']}/require-password-change",
        headers=owner_headers,
    )
    assert required.status_code == 200, required.text
    assert required.json()["must_change_password"] is True
    assert (await client.get("/auth/me", headers=changed_headers)).status_code == 200
    assert (await client.get("/passwords", headers=changed_headers)).status_code == 403


@pytest.mark.asyncio
async def test_legacy_migration_accepts_exporter_archive_over_ten_mib(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    rng = random.Random(0)
    archive = legacy_migration_archive([rng.randbytes(4 * MIB) for _ in range(3)])
    assert len(archive) > 10 * MIB

    imported = await client.post(
        "/passwords/import",
        files={"file": ("migration.zip", archive, "application/zip")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "skip"},
        headers=owner_headers,
    )

    assert imported.status_code == 200, imported.text
    assert imported.json()["attachments"] == 3


@pytest.mark.asyncio
async def test_legacy_migration_preserves_attachment_over_five_mib(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    content = random.Random(1).randbytes(6 * MIB)
    archive = legacy_migration_archive([content])

    imported = await client.post(
        "/passwords/import",
        files={"file": ("migration.zip", archive, "application/zip")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "skip"},
        headers=owner_headers,
    )
    assert imported.status_code == 200, imported.text

    [attachment] = (
        await client.get(
            "/passwords/attachment migration/attachments", headers=owner_headers
        )
    ).json()
    downloaded = await client.get(
        f"/passwords/attachment migration/attachments/{attachment['id']}",
        headers=owner_headers,
    )
    assert downloaded.content == content

    backup = await client.post(
        "/passwords/backup",
        json={"master_password": ADMIN_PASSWORD},
        headers=owner_headers,
    )
    assert backup.status_code == 200, backup.text
    restored = await client.post(
        "/passwords/import",
        files={"file": ("vault.cmbackup", backup.content, "application/octet-stream")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "skip"},
        headers=owner_headers,
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["skipped"] == 1


async def mcp_post(
    client: httpx.AsyncClient,
    token: str,
    payload: dict[str, object],
    protocol: str | None = None,
) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if protocol:
        headers["MCP-Protocol-Version"] = protocol
    return await client.post("http://testserver/mcp", headers=headers, json=payload)


@pytest.mark.asyncio
async def test_users_and_entry_acl_are_deny_by_default(
    client: httpx.AsyncClient,
) -> None:
    owner, owner_headers = await bootstrap(client)
    created = await client.post(
        "/passwords/create", json=entry("shared", "original"), headers=owner_headers
    )
    assert created.status_code == 200, created.text
    [owned] = (await client.get("/passwords", headers=owner_headers)).json()
    [owned_access] = (
        await client.get("/passwords/access", headers=owner_headers)
    ).json()
    assert owned_access["entry_id"] == owned["id"]
    assert owned_access["owner_id"] == owner["id"]
    assert owned_access["owner_username"] == "owner"
    assert owned_access["access"] == "owner"

    private = await client.post(
        "/passwords/create",
        json=entry("private", "private-value"),
        headers=owner_headers,
    )
    assert private.status_code == 200, private.text

    response = await client.post(
        "/users",
        json={
            "username": "member",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert response.status_code == 200, response.text
    member = response.json()
    _, member_headers = await login(client, "member", MEMBER_PASSWORD)
    assert (await client.get("/passwords", headers=member_headers)).json() == []
    assert (await client.get("/passwords", headers=auth(None))).status_code == 401

    granted = await client.put(
        f"/passwords/{owned['id']}/shares/{member['id']}",
        json={"permission": "read"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text
    [shared] = (await client.get("/passwords", headers=member_headers)).json()
    assert shared["password_name"] == "shared"
    [shared_access] = (
        await client.get("/passwords/access", headers=member_headers)
    ).json()
    assert shared_access["entry_id"] == shared["id"]
    assert shared_access["access"] == "read"
    assert shared["password_value"] == "original"

    denied = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "shared"},
            "new_password": entry("shared", "changed"),
        },
        headers=member_headers,
    )
    assert denied.status_code == 403

    upgraded = await client.put(
        f"/passwords/{owned['id']}/shares/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert upgraded.status_code == 200, upgraded.text
    changed = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "shared"},
            "new_password": entry("shared", "changed"),
        },
        headers=member_headers,
    )
    assert changed.status_code == 200, changed.text
    assert (await client.get("/passwords/shared", headers=owner_headers)).json()[
        "password_value"
    ] == "changed"


@pytest.mark.asyncio
async def test_shared_password_history_reuse_rechecks_acl_and_keeps_the_cap(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    created = await client.post(
        "/passwords/create", json=entry("history", "initial"), headers=owner_headers
    )
    assert created.status_code == 200, created.text
    [owned] = (await client.get("/passwords", headers=owner_headers)).json()

    for index in range(1, 11):
        updated = await client.patch(
            "/passwords/update",
            json={
                "password": {"password_name": "history"},
                "new_password": entry("history", f"value-{index}"),
            },
            headers=owner_headers,
        )
        assert updated.status_code == 200, updated.text
    before = (await client.get("/passwords/history", headers=owner_headers)).json()
    assert len(before["password_history"]) == 10
    selected = before["password_history"][-1]
    payload = {
        "password_name": "history",
        "history_index": len(before["password_history"]) - 1,
        "changed_at": selected["changed_at"],
    }

    await db_execute(
        "UPDATE entries SET backed_up = 1 WHERE id = :entry_id", entry_id=owned["id"]
    )
    assert (await client.get("/passwords/history", headers=owner_headers)).json()[
        "backed_up"
    ] is True

    member = await client.post(
        "/users",
        json={
            "username": "history-reader",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert member.status_code == 200, member.text
    _, member_headers = await login(client, "history-reader", MEMBER_PASSWORD)
    granted = await client.put(
        f"/passwords/{owned['id']}/shares/{member.json()['id']}",
        json={"permission": "read"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text
    denied = await client.post(
        "/passwords/history/reuse", json=payload, headers=member_headers
    )
    assert denied.status_code == 403

    granted = await client.put(
        f"/passwords/{owned['id']}/shares/{member.json()['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text
    reused = await client.post(
        "/passwords/history/reuse", json=payload, headers=member_headers
    )
    assert reused.status_code == 200, reused.text

    after = (await client.get("/passwords/history", headers=owner_headers)).json()
    assert after["password_value"] == selected["value"]
    assert len(after["password_history"]) == 10
    assert after["password_history"][0]["value"] == before["password_value"]
    assert selected["value"] not in [row["value"] for row in after["password_history"]]
    assert after["backed_up"] is False
    audit = (
        await client.get(f"/passwords/{owned['id']}/audit", headers=owner_headers)
    ).json()
    audit_text = json.dumps(audit)
    assert selected["value"] not in audit_text
    assert before["password_value"] not in audit_text


@pytest.mark.asyncio
async def test_password_history_reuse_preserves_a_concurrent_metadata_update(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    assert (
        await client.post(
            "/passwords/create", json=entry("history", "initial"), headers=owner_headers
        )
    ).status_code == 200
    changed = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "history"},
            "new_password": entry("history", "current"),
        },
        headers=owner_headers,
    )
    assert changed.status_code == 200, changed.text
    before = (await client.get("/passwords/history", headers=owner_headers)).json()
    selected = before["password_history"][0]
    payload = {
        "password_name": "history",
        "history_index": 0,
        "changed_at": selected["changed_at"],
    }
    writer = await client.post(
        "/users",
        json={
            "username": "history-writer",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert writer.status_code == 200, writer.text
    _, writer_headers = await login(client, "history-writer", MEMBER_PASSWORD)
    granted = await client.put(
        f"/passwords/{before['id']}/shares/{writer.json()['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text

    concurrent = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "history"},
            "new_password": entry(
                "history",
                "current",
                username="changed@example.test",
                description="Edited by another user",
            ),
        },
        headers=owner_headers,
    )
    assert concurrent.status_code == 200, concurrent.text

    reused = await client.post(
        "/passwords/history/reuse", json=payload, headers=writer_headers
    )
    assert reused.status_code == 200, reused.text
    after = (await client.get("/passwords/history", headers=owner_headers)).json()
    assert after["password_value"] == selected["value"]
    assert after["username"] == "changed@example.test"
    assert after["description"] == "Edited by another user"


@pytest.mark.asyncio
async def test_password_history_reuse_refuses_a_stale_history_selection(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    assert (
        await client.post(
            "/passwords/create", json=entry("history", "initial"), headers=owner_headers
        )
    ).status_code == 200
    assert (
        await client.patch(
            "/passwords/update",
            json={
                "password": {"password_name": "history"},
                "new_password": entry("history", "current"),
            },
            headers=owner_headers,
        )
    ).status_code == 200
    selected = (await client.get("/passwords/history", headers=owner_headers)).json()[
        "password_history"
    ][0]
    payload = {
        "password_name": "history",
        "history_index": 0,
        "changed_at": selected["changed_at"],
    }
    assert (
        await client.patch(
            "/passwords/update",
            json={
                "password": {"password_name": "history"},
                "new_password": entry("history", "newer"),
            },
            headers=owner_headers,
        )
    ).status_code == 200
    before_retry = (
        await client.get("/passwords/history", headers=owner_headers)
    ).json()

    stale = await client.post(
        "/passwords/history/reuse", json=payload, headers=owner_headers
    )
    assert stale.status_code == 400
    assert stale.json()["detail"] == "Password history changed. Refresh and try again."
    after_retry = (await client.get("/passwords/history", headers=owner_headers)).json()
    assert after_retry == before_retry


@pytest.mark.asyncio
async def test_admin_lifecycle_revokes_memory_sessions(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    created = await client.post(
        "/users",
        json={
            "username": "member",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    member = created.json()
    _, member_headers = await login(client, "member", MEMBER_PASSWORD)
    assert (await client.get("/auth/me", headers=member_headers)).status_code == 200

    revoked = await client.post(
        f"/users/{member['id']}/sessions/revoke", headers=owner_headers
    )
    assert revoked.status_code == 200, revoked.text
    assert (await client.get("/auth/me", headers=member_headers)).status_code == 401

    changed_password = f"{MEMBER_PASSWORD}-changed"
    _, member_headers = await login(client, "member", changed_password)
    disabled = await client.patch(
        f"/users/{member['id']}", json={"active": False}, headers=owner_headers
    )
    assert disabled.status_code == 200, disabled.text
    assert (await client.get("/auth/me", headers=member_headers)).status_code == 401
    refused = await client.post(
        "/auth/login", json={"username": "member", "password": changed_password}
    )
    assert refused.status_code == 200
    assert refused.json()["valid"] is False


@pytest.mark.asyncio
async def test_primary_vault_owner_cannot_be_deleted(
    client: httpx.AsyncClient,
) -> None:
    owner, owner_headers = await bootstrap(client)
    created = await client.post(
        "/users",
        json={
            "username": "second-admin",
            "role": "admin",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert created.status_code == 200, created.text
    _, second_headers = await login(client, "second-admin", MEMBER_PASSWORD)

    deleted = await client.delete(f"/users/{owner['id']}", headers=second_headers)
    assert deleted.status_code == 403
    assert "primary vault owner" in deleted.json()["detail"].lower()
    assert (await client.get("/auth/me", headers=owner_headers)).status_code == 200


async def _mcp_service_acl_flow(client: httpx.AsyncClient) -> None:
    owner, owner_headers = await bootstrap(client)
    await client.post(
        "/passwords/create", json=entry("shared", "secret"), headers=owner_headers
    )
    [owned] = (await client.get("/passwords", headers=owner_headers)).json()
    service_response = await client.post(
        "/users",
        json={
            "username": "assistant",
            "role": "service",
            "current_password": ADMIN_PASSWORD,
        },
        headers=owner_headers,
    )
    assert service_response.status_code == 200, service_response.text
    service = service_response.json()
    token = service.pop("service_token")
    assert token
    assert service["service_operations"] == ["list", "get"]
    grant = await client.put(
        f"/passwords/{owned['id']}/shares/{service['id']}",
        json={"permission": "read"},
        headers=owner_headers,
    )
    assert grant.status_code == 200, grant.text
    rejected_confirmation = await client.put(
        f"/users/{service['id']}/service-operations",
        json={"operations": ["create"], "current_password": "wrong-password"},
        headers=owner_headers,
    )
    assert rejected_confirmation.status_code == 403
    users = await client.get("/users", headers=owner_headers)
    assert next(user for user in users.json() if user["id"] == service["id"])[
        "service_operations"
    ] == ["list", "get"]
    configured = await client.put(
        f"/users/{service['id']}/service-operations",
        json={
            "operations": ["list", "get", "create"],
            "current_password": ADMIN_PASSWORD,
        },
        headers=owner_headers,
    )
    assert configured.status_code == 200, configured.text

    initialized = await mcp_post(
        client,
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    assert initialized.status_code == 200, initialized.text
    protocol = initialized.json()["result"]["protocolVersion"]
    listed = await mcp_post(
        client,
        token,
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "list_entries", "arguments": {}},
        },
        protocol,
    )
    assert listed.status_code == 200, listed.text
    [listed_entry] = listed.json()["result"]["structuredContent"]["result"]
    assert listed_entry["id"] == owned["id"]
    assert listed_entry["access"] == "read"

    denied = await mcp_post(
        client,
        token,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "update_entry",
                "arguments": {
                    "entry_id": owned["id"],
                    "changes": {"password_value": "changed"},
                },
            },
        },
        protocol,
    )
    assert denied.json()["result"]["isError"] is True

    folder_response = await client.post(
        "/folders", json={"name": "Automation"}, headers=owner_headers
    )
    assert folder_response.status_code == 201, folder_response.text
    folder = folder_response.json()
    granted = await client.put(
        f"/folders/{folder['id']}/grants/users/{service['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text
    created = await mcp_post(
        client,
        token,
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "create_entry",
                "arguments": {
                    "entry": entry(
                        "agent-created",
                        "secret",
                        folder=folder["name"],
                        folder_id=folder["id"],
                    )
                },
            },
        },
        protocol,
    )
    assert created.status_code == 200, created.text
    assert created.json()["result"].get("isError") is not True
    created_entry = created.json()["result"]["structuredContent"]
    assert created_entry["folder_id"] == folder["id"]
    assert {source["source"] for source in created_entry["access_sources"]} == {
        "folder"
    }

    stripped = await client.put(
        f"/users/{service['id']}/service-operations",
        json={"operations": ["list", "get"], "current_password": ADMIN_PASSWORD},
        headers=owner_headers,
    )
    assert stripped.status_code == 200, stripped.text
    blocked_create = await mcp_post(
        client,
        token,
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "create_entry",
                "arguments": {
                    "entry": entry(
                        "agent-blocked",
                        "secret",
                        folder=folder["name"],
                        folder_id=folder["id"],
                    )
                },
            },
        },
        protocol,
    )
    assert blocked_create.status_code == 200, blocked_create.text
    assert blocked_create.json()["result"]["isError"] is True
    assert "agent-blocked" not in {
        item["password_name"]
        for item in (await client.get("/passwords", headers=owner_headers)).json()
    }

    revoked_folder = await client.delete(
        f"/folders/{folder['id']}/grants/users/{service['id']}",
        headers=owner_headers,
    )
    assert revoked_folder.status_code == 200, revoked_folder.text
    listed_after_revoke = await mcp_post(
        client,
        token,
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "list_entries", "arguments": {}},
        },
        protocol,
    )
    assert listed_after_revoke.status_code == 200, listed_after_revoke.text
    assert {
        item["id"]
        for item in listed_after_revoke.json()["result"]["structuredContent"]["result"]
    } == {owned["id"]}
    owner_entries = (await client.get("/passwords", headers=owner_headers)).json()
    agent_created = next(
        item for item in owner_entries if item["password_name"] == "agent-created"
    )
    assert agent_created["owner_id"] == owner["id"]
    audit_rows = await db_execute(
        "SELECT action, resource_id FROM access_audit WHERE resource_type = 'service'"
    )
    assert ("mcp_create_entry", service["id"]) in audit_rows
    assert ("mcp_create_entry_denied", service["id"]) in audit_rows
    assert token not in str(audit_rows)

    await client.patch(
        f"/users/{service['id']}", json={"active": False}, headers=owner_headers
    )
    revoked = await mcp_post(
        client,
        token,
        {"jsonrpc": "2.0", "id": 6, "method": "tools/list"},
        protocol,
    )
    assert revoked.status_code == 401


@pytest.mark.asyncio
async def test_mcp_service_uses_the_same_explicit_acl(
    client: httpx.AsyncClient,
) -> None:
    async with app.state.mcp_server.session_manager.run():
        await _mcp_service_acl_flow(client)


@pytest.mark.asyncio
async def test_legacy_migration_backup_restores_history_trash_attachments_and_grants(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    service_response = await client.post(
        "/users",
        json={
            "username": "assistant",
            "role": "service",
            "current_password": ADMIN_PASSWORD,
        },
        headers=owner_headers,
    )
    assert service_response.status_code == 200, service_response.text
    service = service_response.json()
    other_response = await client.post(
        "/users",
        json={
            "username": "other",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert other_response.status_code == 200, other_response.text
    _, other_headers = await login(client, "other", MEMBER_PASSWORD)
    collision = await client.post(
        "/passwords/create",
        json=entry("migrated", "belongs-to-other"),
        headers=other_headers,
    )
    assert collision.status_code == 200, collision.text

    attachment = b"migration attachment"
    stamp = "2026-10-20T12:00:00Z"
    row = {
        "legacy_id": 41,
        "owner_username": "owner",
        "access": "owner",
        "created": stamp,
        "updated": stamp,
        "deleted": None,
        "name": "migrated",
        "kind": "login",
        "username": "legacy-user",
        "value": "legacy-value",
        "url": "https://example.test",
        "totp_secret": None,
        "description": "from PostgreSQL",
        "tags": ["legacy"],
        "custom_fields": [{"label": "PIN", "value": "1234", "hidden": True}],
        "folder": "Migration",
        "favorite": True,
        "password_history": [{"value": "older-value", "changed_at": stamp}],
        "shares": [{"username": "assistant", "role": "service", "permission": "write"}],
        "attachments": [
            {
                "filename": "proof.txt",
                "content_type": "text/plain",
                "created": stamp,
                "data": base64.urlsafe_b64encode(attachment).decode().rstrip("="),
            }
        ],
    }
    trashed = {
        **row,
        "legacy_id": 42,
        "name": "migrated-trash",
        "deleted": "2026-10-21T12:00:00Z",
        "shares": [],
        "attachments": [],
    }
    payload = json.dumps(
        {"migration_version": 1, "exported_at": stamp, "passwords": [row, trashed]}
    ).encode()
    archive = io.BytesIO()
    with pyzipper.AESZipFile(
        archive,
        "w",
        compression=pyzipper.ZIP_DEFLATED,
        encryption=pyzipper.WZ_AES,
    ) as backup:
        backup.setpassword(ADMIN_PASSWORD.encode())
        backup.setencryption(pyzipper.WZ_AES, nbits=256)
        backup.writestr("ciphermoth_backup.json", payload)

    wrong_archive = io.BytesIO()
    wrong_payload = json.dumps(
        {
            "migration_version": 1,
            "exported_at": stamp,
            "passwords": [{**row, "owner_username": "other"}],
        }
    ).encode()
    with pyzipper.AESZipFile(
        wrong_archive,
        "w",
        compression=pyzipper.ZIP_DEFLATED,
        encryption=pyzipper.WZ_AES,
    ) as backup:
        backup.setpassword(ADMIN_PASSWORD.encode())
        backup.setencryption(pyzipper.WZ_AES, nbits=256)
        backup.writestr("ciphermoth_backup.json", wrong_payload)
    wrong_owner = await client.post(
        "/passwords/import",
        files={"file": ("migration.zip", wrong_archive.getvalue(), "application/zip")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "skip"},
        headers=owner_headers,
    )
    assert wrong_owner.status_code == 403, wrong_owner.text
    assert (await client.get("/passwords", headers=owner_headers)).json() == []

    imported = await client.post(
        "/passwords/import",
        files={"file": ("migration.zip", archive.getvalue(), "application/zip")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "skip"},
        headers=owner_headers,
    )
    assert imported.status_code == 200, imported.text
    assert imported.json() == {
        "imported": 1,
        "skipped": 0,
        "overwritten": 0,
        "total": 2,
        "ignored": 0,
        "ignored_rows": [],
        "renamed": 1,
        "renamed_rows": [
            {
                "where": "entry 1",
                "name": "migrated",
                "reason": (
                    "imported as 'migrated (2)' because that active name is already "
                    "in use"
                ),
            }
        ],
        "trashed": 1,
        "attachments": 1,
        "grants_restored": 1,
        "settings_restored": False,
    }

    [active] = (await client.get("/passwords", headers=owner_headers)).json()
    assert active["password_name"] == "migrated (2)"
    assert active["password_history"] == [
        {"value": "older-value", "changed_at": "2026-10-20T12:00:00Z"}
    ]
    assert active["attachment_count"] == 1
    [share] = (
        await client.get(f"/passwords/{active['id']}/shares", headers=owner_headers)
    ).json()
    assert share["user_id"] == service["id"]
    assert share["permission"] == "write"
    [trash] = (await client.get("/passwords/trash", headers=owner_headers)).json()
    assert trash["password_name"] == "migrated-trash"
    [described] = (
        await client.get("/passwords/migrated (2)/attachments", headers=owner_headers)
    ).json()
    downloaded = await client.get(
        f"/passwords/migrated (2)/attachments/{described['id']}", headers=owner_headers
    )
    assert downloaded.content == attachment


@pytest.mark.asyncio
async def test_backup_import_cannot_overwrite_another_owners_entry(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    created_entry = await client.post(
        "/passwords/create",
        json=entry("protected", "owner-value"),
        headers=owner_headers,
    )
    assert created_entry.status_code == 200, created_entry.text
    backup = await client.post(
        "/passwords/backup",
        json={"master_password": ADMIN_PASSWORD},
        headers=owner_headers,
    )
    assert backup.status_code == 200, backup.text

    created_user = await client.post(
        "/users",
        json={
            "username": "member",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert created_user.status_code == 200, created_user.text
    _, member_headers = await login(client, "member", MEMBER_PASSWORD)
    imported = await client.post(
        "/passwords/import",
        files={"file": ("backup.cmbackup", backup.content, "application/octet-stream")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "overwrite"},
        headers=member_headers,
    )
    assert imported.status_code == 403, imported.text

    [owned] = (await client.get("/passwords", headers=owner_headers)).json()
    assert owned["password_name"] == "protected"
    assert owned["password_value"] == "owner-value"
    assert (await client.get("/passwords", headers=member_headers)).json() == []


@pytest.mark.asyncio
async def test_csv_import_renames_instead_of_overwriting_a_shared_entry(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    assert (
        await client.post(
            "/passwords/create",
            json=entry("shared-name", "owner-value"),
            headers=owner_headers,
        )
    ).status_code == 200
    [owned] = (await client.get("/passwords", headers=owner_headers)).json()
    created_user = await client.post(
        "/users",
        json={
            "username": "member",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    member = created_user.json()
    _, member_headers = await login(client, "member", MEMBER_PASSWORD)
    grant = await client.put(
        f"/passwords/{owned['id']}/shares/{member['id']}",
        json={"permission": "read"},
        headers=owner_headers,
    )
    assert grant.status_code == 200, grant.text

    imported = await client.post(
        "/passwords/import/csv",
        files={
            "file": (
                "entries.csv",
                b"name,password\nshared-name,member-value\n",
                "text/csv",
            )
        },
        data={"on_conflict": "overwrite"},
        headers=member_headers,
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["renamed"] == 1

    owner_entry = await client.get("/passwords/shared-name", headers=owner_headers)
    assert owner_entry.json()["password_value"] == "owner-value"
    member_entries = (await client.get("/passwords", headers=member_headers)).json()
    assert {item["password_name"] for item in member_entries} == {
        "shared-name",
        "shared-name (2)",
    }


@pytest.mark.asyncio
async def test_member_backup_import_cannot_restore_global_settings(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    before = {
        "inactivity_ms": 300_000,
        "warn_before_ms": 30_000,
        "hidden_ms": 120_000,
        "debounce_ms": 500,
        "clipboard_clear_ms": 15_000,
        "update_check_enabled": False,
    }
    assert (
        await client.patch("/settings", json=before, headers=owner_headers)
    ).status_code == 200
    backup = await client.post(
        "/passwords/backup",
        json={"master_password": ADMIN_PASSWORD},
        headers=owner_headers,
    )
    after = {**before, "inactivity_ms": 600_000, "update_check_enabled": True}
    assert (
        await client.patch("/settings", json=after, headers=owner_headers)
    ).status_code == 200

    created = await client.post(
        "/users",
        json={
            "username": "member",
            "role": "member",
            "temporary_password": MEMBER_PASSWORD,
        },
        headers=owner_headers,
    )
    assert created.status_code == 200, created.text
    _, member_headers = await login(client, "member", MEMBER_PASSWORD)
    imported = await client.post(
        "/passwords/import",
        files={"file": ("backup.cmbackup", backup.content, "application/octet-stream")},
        data={"master_password": ADMIN_PASSWORD, "on_conflict": "skip"},
        headers=member_headers,
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["settings_restored"] is False
    assert (await client.get("/settings", headers=owner_headers)).json() == after
