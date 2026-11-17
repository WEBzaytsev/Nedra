from urllib.parse import quote

import httpx
import pytest

from tests.support import (
    Headers,
    auth,
    create_vault,
    db_execute,
    entry,
    plant_entry,
    vault_key,
)

HOSTILE_NAMES = [
    "a/b",
    "x/purge",
    "x/restore",
    "x/favorite",
    "x/attachments",
    "x/attachments/1",
    "../x",
    "x/..",
    "./x",
    "a/b/c",
    "/lead",
    "trail/",
    "x%2Fpurge",
    "%2F",
    "notes#2024?a=1&b",
    "名前/ü 🦋",
    "import",
]


def _path(name: str, suffix: str = "") -> str:
    return f"/passwords/{quote(name, safe='')}{suffix}"


@pytest.fixture
async def vault(client: httpx.AsyncClient) -> Headers:
    headers = auth(await create_vault(client))
    for step in (
        client.post("/passwords/create", json=entry("x", "trashed-x"), headers=headers),
        client.delete("/passwords/x", headers=headers),
        client.post("/passwords/create", json=entry("x", "active-x"), headers=headers),
        client.post(
            "/passwords/x/attachments",
            files={"file": ("x.bin", b"decoy attachment", "x/y")},
            headers=headers,
        ),
    ):
        assert (await step).status_code == 200
    return headers


async def _decoys() -> list[tuple]:
    return await db_execute(
        "SELECT e.id, e.name_index, e.document, e.backed_up, e.deleted, "
        "a.id, a.meta, a.content FROM entries e LEFT JOIN attachments a "
        "ON a.entry_id = e.id WHERE e.name_index = :index ORDER BY e.id, a.id",
        index=(await vault_key()).name_index("x"),
    )


@pytest.mark.parametrize("named", [False, True], ids=["path-only", "with-header"])
@pytest.mark.parametrize("name", HOSTILE_NAMES)
async def test_every_operation_reaches_exactly_the_named_entry(
    client: httpx.AsyncClient, vault: Headers, name: str, named: bool
) -> None:
    if named:
        vault = [*vault, (b"x-nedra-entry", quote(name, safe="").encode())]
    resp = await client.post(
        "/passwords/create", json=entry(name, "target-Value-1"), headers=vault
    )
    assert resp.status_code == 200, resp.text
    decoys = await _decoys()

    got = await client.get(_path(name), headers=vault)
    assert got.status_code == 200, got.text
    assert got.json()["password_name"] == name
    assert got.json()["password_value"] == "target-Value-1"

    resp = await client.patch(
        _path(name, "/favorite"), json={"favorite": True}, headers=vault
    )
    assert resp.status_code == 200, resp.text

    resp = await client.post(
        _path(name, "/attachments"),
        files={"file": ("t.bin", b"target attachment", "x/y")},
        headers=vault,
    )
    assert resp.status_code == 200, resp.text
    attachment = resp.json()["id"]
    listed = await client.get(_path(name, "/attachments"), headers=vault)
    assert [a["id"] for a in listed.json()] == [attachment]
    download = await client.get(
        _path(name, f"/attachments/{attachment}"), headers=vault
    )
    assert download.content == b"target attachment"
    resp = await client.delete(_path(name, f"/attachments/{attachment}"), headers=vault)
    assert resp.status_code == 200, resp.text

    assert (await client.delete(_path(name), headers=vault)).status_code == 200
    resp = await client.post(_path(name, "/restore"), headers=vault)
    assert resp.status_code == 200, resp.text
    assert (await client.delete(_path(name), headers=vault)).status_code == 200
    resp = await client.delete(_path(name, "/purge"), headers=vault)
    assert resp.status_code == 200, resp.text

    assert await _decoys() == decoys
    assert await db_execute(
        "SELECT count(*) FROM entries WHERE name_index = :index",
        index=(await vault_key()).name_index(name),
    ) == [(0,)]


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("DELETE", "/passwords/x%2Fpurge"),
        ("DELETE", "/passwords/x%2fattachments%2F1"),
        ("POST", "/passwords/x%2Frestore"),
        ("PATCH", "/passwords/x%2Ffavorite"),
        ("GET", "/passwords/..%2Fsettings"),
    ],
)
async def test_a_name_that_does_not_exist_never_falls_through_to_another_route(
    client: httpx.AsyncClient, vault: Headers, method: str, path: str
) -> None:
    decoys = await _decoys()

    resp = await client.request(
        method,
        path,
        json={"favorite": True} if method == "PATCH" else None,
        headers=vault,
    )

    assert resp.status_code in (404, 405), resp.text
    assert await _decoys() == decoys


async def test_a_literal_nul_in_the_path_is_refused(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    for path in ("/passwords/x%00", "/passwords/x%00purge/purge", "/passwords/%00"):
        resp = await client.get(path, headers=vault)
        assert resp.status_code == 400, (path, resp.text)


@pytest.mark.parametrize("name", [".", "..", "trash"])
async def test_legacy_unaddressable_names_are_readable_and_can_be_renamed(
    client: httpx.AsyncClient, vault: Headers, name: str
) -> None:
    await plant_entry(name, "legacy-Value-1")
    listing = (await client.get("/passwords", headers=vault)).json()
    assert name in [p["password_name"] for p in listing]

    resp = await client.patch(
        "/passwords/update",
        json={"password": {"password_name": name}, "new_password": entry(name)},
        headers=vault,
    )
    assert resp.status_code == 422
    resp = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": name},
            "new_password": entry("renamed", "legacy-Value-1"),
        },
        headers=vault,
    )
    assert resp.status_code == 200, resp.text
    got = await client.get("/passwords/renamed", headers=vault)
    assert got.json()["password_value"] == "legacy-Value-1"


async def test_meta_advertises_slash_routing(client: httpx.AsyncClient) -> None:
    features = (await client.get("/meta")).json()["features"]
    assert "entry-names-with-slash" in features


async def test_a_legacy_entry_named_trash_is_managed_without_touching_the_trash(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    await plant_entry("trash", "legacy-Value-1")
    decoys = await _decoys()

    resp = await client.patch(
        "/passwords/trash/favorite", json={"favorite": True}, headers=vault
    )
    assert resp.status_code == 200, resp.text
    assert (await client.delete("/passwords/trash", headers=vault)).status_code == 200
    trash = (await client.get("/passwords/trash", headers=vault)).json()
    assert sorted(p["password_name"] for p in trash) == ["trash", "x"]
    assert (await client.delete("/passwords/trash/purge", headers=vault)).is_success
    assert await _decoys() == decoys


@pytest.mark.parametrize("legacy", [" foo", "foo ", "  foo  "])
async def test_editing_a_name_with_surrounding_spaces_never_touches_another_entry(
    client: httpx.AsyncClient, vault: Headers, legacy: str
) -> None:
    await client.post(
        "/passwords/create",
        json=entry("foo", "real-foo", username="real"),
        headers=vault,
    )
    await plant_entry(legacy, "legacy-foo")
    real_before = (await client.get("/passwords/foo", headers=vault)).json()

    resp = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": legacy},
            "new_password": entry(legacy, "edited", username="edited"),
        },
        headers=vault,
    )
    assert resp.status_code == 400, resp.text
    assert (await client.get("/passwords/foo", headers=vault)).json() == real_before

    resp = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": legacy},
            "new_password": entry("foo renamed", "edited"),
        },
        headers=vault,
    )
    assert resp.status_code == 200, resp.text
    assert (await client.get("/passwords/foo", headers=vault)).json() == real_before
    renamed = (await client.get("/passwords/foo%20renamed", headers=vault)).json()
    assert renamed["password_value"] == "edited"
    assert [h["value"] for h in renamed["password_history"]] == ["legacy-foo"]


@pytest.mark.parametrize(
    ("method", "decoded_path", "intended"),
    [
        ("DELETE", "/passwords/x/purge", "x/purge"),
        ("DELETE", "/passwords/x/attachments/1", "x/attachments/1"),
        ("POST", "/passwords/x/restore", "x/restore"),
        ("PATCH", "/passwords/x/favorite", "x/favorite"),
        ("GET", "/passwords/x/attachments", "x/attachments"),
        ("DELETE", "/passwords/x", "x/"),
    ],
)
async def test_a_path_decoded_by_a_proxy_is_refused_when_the_client_names_the_entry(
    client: httpx.AsyncClient,
    vault: Headers,
    method: str,
    decoded_path: str,
    intended: str,
) -> None:
    decoys = await _decoys()

    resp = await client.request(
        method,
        decoded_path,
        json={"favorite": True} if method == "PATCH" else None,
        headers=[*vault, (b"x-nedra-entry", quote(intended, safe="").encode())],
    )

    assert resp.status_code == 400, resp.text
    assert "reverse proxy" in resp.json()["detail"]
    assert await _decoys() == decoys


async def test_the_entry_header_is_allowed_by_cors(client: httpx.AsyncClient) -> None:
    resp = await client.options(
        "/passwords/x",
        headers={
            "origin": "http://localhost:3000",
            "access-control-request-method": "DELETE",
            "access-control-request-headers": "x-nedra-entry",
        },
    )
    assert "x-nedra-entry" in resp.headers["access-control-allow-headers"].lower()
