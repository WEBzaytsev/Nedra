"""Atomic, ACL-authorized bulk trash actions."""

from datetime import UTC, datetime, timedelta

import httpx

from schemas import MAX_BULK_ENTRIES, BulkMovePayload, BulkTrashPayload
from tests.support import auth, create_vault, db_execute, db_snapshot, entry
from tests.test_folder_access import (
    bootstrap,
    create_folder,
    create_folder_entry,
    create_user,
    login,
)


async def _trash(client: httpx.AsyncClient, headers, *names: str) -> httpx.Response:
    return await client.post(
        "/vault/entries/trash",
        json={"entries": [{"password_name": name} for name in names]},
        headers=headers,
    )


async def _refs(client: httpx.AsyncClient, headers) -> dict[str, dict]:
    response = await client.get("/passwords/trash", headers=headers)
    assert response.status_code == 200, response.text
    return {
        item["password_name"]: {
            "password_name": item["password_name"],
            "entry_id": item["id"],
        }
        for item in response.json()
    }


async def _move(
    client: httpx.AsyncClient, headers, folder_id, *entries: dict
) -> httpx.Response:
    return await client.post(
        "/vault/entries/move",
        json={
            "entries": [{"entry_id": entry["id"]} for entry in entries],
            "folder_id": folder_id,
        },
        headers=headers,
    )


async def test_bulk_actions_are_atomic_and_bind_trashed_ids(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    for name in ("a", "b", "keep"):
        response = await client.post(
            "/passwords/create", json=entry(name), headers=headers
        )
        assert response.status_code == 200, response.text

    before = await db_snapshot()
    response = await _trash(client, headers, "a", "missing", "b")
    assert response.status_code == 404, response.text
    assert await db_snapshot() == before

    response = await _trash(client, headers, "a", "b")
    assert response.status_code == 200, response.text
    assert response.json() == {"count": 2, "detail": "2 entries moved to trash."}
    refs = await _refs(client, headers)

    before = await db_snapshot()
    response = await client.post(
        "/vault/trash/restore",
        json={
            "entries": [
                refs["a"],
                {"password_name": "wrong", "entry_id": refs["b"]["entry_id"]},
            ]
        },
        headers=headers,
    )
    assert response.status_code == 404, response.text
    assert await db_snapshot() == before

    response = await client.post(
        "/vault/trash/restore", json={"entries": [refs["a"]]}, headers=headers
    )
    assert response.status_code == 200, response.text
    before = await db_snapshot()
    response = await client.post(
        "/vault/trash/restore", json={"entries": [refs["a"]]}, headers=headers
    )
    assert response.status_code == 404, response.text
    assert await db_snapshot() == before

    response = await client.post(
        "/vault/trash/purge", json={"entries": [refs["b"]]}, headers=headers
    )
    assert response.status_code == 200, response.text
    before = await db_snapshot()
    response = await client.post(
        "/vault/trash/purge", json={"entries": [refs["b"]]}, headers=headers
    )
    assert response.status_code == 404, response.text
    assert await db_snapshot() == before


async def test_bulk_requests_validate_bounds_and_duplicates_without_writes(
    client: httpx.AsyncClient,
) -> None:
    headers = auth(await create_vault(client))
    response = await client.post("/passwords/create", json=entry("a"), headers=headers)
    assert response.status_code == 200, response.text
    before = await db_snapshot()
    accepted = BulkTrashPayload.model_validate(
        {
            "entries": [
                {"password_name": str(index)} for index in range(MAX_BULK_ENTRIES)
            ]
        }
    )
    assert len(accepted.entries) == MAX_BULK_ENTRIES

    for body in (
        {"entries": []},
        {"entries": [{"password_name": "a"}, {"password_name": "a"}]},
        {"entries": [{"password_name": "a"}] * 10_001},
    ):
        response = await client.post("/vault/entries/trash", json=body, headers=headers)
        assert response.status_code == 422, response.text
    assert await db_snapshot() == before


async def test_bulk_actions_require_effective_write_access_and_honor_expiry(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    folder = await create_folder(client, owner_headers, "Shared")
    first = await create_folder_entry(client, owner_headers, folder, "first")
    second = await create_folder_entry(client, owner_headers, folder, "second")

    for entry_id, permission in ((first["id"], "write"), (second["id"], "read")):
        response = await client.put(
            f"/passwords/{entry_id}/shares/{member['id']}",
            json={"permission": permission},
            headers=owner_headers,
        )
        assert response.status_code == 200, response.text

    before = await db_snapshot()
    response = await _trash(client, member_headers, "first", "second")
    assert response.status_code == 403, response.text
    assert await db_snapshot() == before

    response = await _trash(client, member_headers, "first")
    assert response.status_code == 200, response.text
    first_ref = (await _refs(client, member_headers))["first"]
    response = await client.post(
        "/vault/trash/restore", json={"entries": [first_ref]}, headers=member_headers
    )
    assert response.status_code == 200, response.text

    group = await client.post(
        "/groups", json={"name": "writers"}, headers=owner_headers
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]
    assert (
        await client.put(
            f"/groups/{group_id}/members/{member['id']}", headers=owner_headers
        )
    ).status_code == 200
    granted = await client.put(
        f"/folders/{folder['id']}/grants/groups/{group_id}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text

    group_first = await create_folder_entry(
        client, owner_headers, folder, "group-first"
    )
    group_second = await create_folder_entry(
        client, owner_headers, folder, "group-second"
    )
    assert group_first["id"] != group_second["id"]
    response = await _trash(client, member_headers, "group-first", "group-second")
    assert response.status_code == 200, response.text
    refs = await _refs(client, member_headers)
    response = await client.post(
        "/vault/trash/restore",
        json={"entries": [refs["group-first"], refs["group-second"]]},
        headers=member_headers,
    )
    assert response.status_code == 200, response.text

    await db_execute(
        "UPDATE folder_group_access SET expires_at = :expired "
        "WHERE folder_id = :folder_id AND group_id = :group_id",
        expired=datetime.now(UTC) - timedelta(minutes=1),
        folder_id=folder["id"],
        group_id=group_id,
    )
    before = await db_snapshot()
    response = await _trash(client, member_headers, "group-first", "group-second")
    assert response.status_code == 404, response.text
    assert await db_snapshot() == before


async def test_bulk_purge_requires_ownership_for_every_entry(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    folder = await create_folder(client, owner_headers, "Purge")
    shared = await create_folder_entry(client, owner_headers, folder, "shared")
    await create_folder_entry(client, owner_headers, folder, "private")
    granted = await client.put(
        f"/passwords/{shared['id']}/shares/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert granted.status_code == 200, granted.text

    response = await _trash(client, owner_headers, "shared", "private")
    assert response.status_code == 200, response.text
    refs = await _refs(client, owner_headers)
    before = await db_snapshot()
    response = await client.post(
        "/vault/trash/purge",
        json={"entries": [refs["shared"], refs["private"]]},
        headers=member_headers,
    )
    assert response.status_code == 403, response.text
    assert await db_snapshot() == before


async def test_bulk_move_and_undo_recheck_acl_and_current_folder(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    source = await create_folder(client, owner_headers, "Source")
    target = await create_folder(client, owner_headers, "Target")
    changed = await create_folder_entry(client, owner_headers, source, "changed")
    blocked = await create_folder_entry(client, owner_headers, source, "blocked")

    response = await client.put(
        f"/folders/{target['id']}/grants/users/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert response.status_code == 200, response.text
    for entry_row, permission in ((changed, "write"), (blocked, "read")):
        response = await client.put(
            f"/passwords/{entry_row['id']}/shares/{member['id']}",
            json={"permission": permission},
            headers=owner_headers,
        )
        assert response.status_code == 200, response.text

    before = await db_snapshot()
    response = await _move(client, member_headers, target["id"], changed, blocked)
    assert response.status_code == 403, response.text
    assert await db_snapshot() == before

    response = await client.put(
        f"/passwords/{blocked['id']}/shares/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert response.status_code == 200, response.text
    response = await _move(client, member_headers, target["id"], changed, blocked)
    assert response.status_code == 200, response.text
    assert response.json() == {"count": 2, "detail": "2 entries moved."}
    moved = {
        item["id"]: item
        for item in (await client.get("/passwords", headers=member_headers)).json()
    }
    assert {moved[changed["id"]]["folder_id"], moved[blocked["id"]]["folder_id"]} == {
        target["id"]
    }

    response = await client.put(
        f"/folders/{source['id']}/grants/users/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert response.status_code == 200, response.text
    undo = await client.post(
        "/vault/entries/move/undo",
        json={
            "entries": [
                {
                    "entry_id": entry_row["id"],
                    "folder_id": source["id"],
                    "moved_to_folder_id": target["id"],
                }
                for entry_row in (changed, blocked)
            ]
        },
        headers=member_headers,
    )
    assert undo.status_code == 200, undo.text
    assert undo.json() == {"count": 2, "detail": "2 entries moved."}

    moved_again = await _move(client, member_headers, None, changed)
    assert moved_again.status_code == 200, moved_again.text
    before = await db_snapshot()
    stale_undo = await client.post(
        "/vault/entries/move/undo",
        json={
            "entries": [
                {
                    "entry_id": changed["id"],
                    "folder_id": source["id"],
                    "moved_to_folder_id": target["id"],
                }
            ]
        },
        headers=member_headers,
    )
    assert stale_undo.status_code == 400, stale_undo.text
    assert await db_snapshot() == before


async def test_bulk_move_validates_stable_ids_and_owner_compatible_target(
    client: httpx.AsyncClient,
) -> None:
    _owner, owner_headers = await bootstrap(client)
    member = await create_user(client, owner_headers, "member")
    _, member_headers = await login(client, "member")
    source = await create_folder(client, owner_headers, "Source")
    entry_row = await create_folder_entry(client, owner_headers, source, "shared")
    foreign = await create_folder(client, member_headers, "Foreign")
    response = await client.put(
        f"/passwords/{entry_row['id']}/shares/{member['id']}",
        json={"permission": "write"},
        headers=owner_headers,
    )
    assert response.status_code == 200, response.text

    before = await db_snapshot()
    response = await _move(client, member_headers, foreign["id"], entry_row)
    assert response.status_code == 400, response.text
    assert await db_snapshot() == before
    for body in (
        {"entries": [], "folder_id": None},
        {"entries": [{"entry_id": entry_row["id"]}] * 2, "folder_id": None},
        {"entries": [{"entry_id": entry_row["id"]}], "folder_id": "wrong"},
    ):
        response = await client.post(
            "/vault/entries/move", json=body, headers=member_headers
        )
        assert response.status_code == 422, response.text
    assert BulkMovePayload.model_validate(
        {
            "entries": [{"entry_id": index + 1} for index in range(MAX_BULK_ENTRIES)],
            "folder_id": None,
        }
    )
    assert await db_snapshot() == before
