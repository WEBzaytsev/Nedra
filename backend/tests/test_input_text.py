import httpx
import pytest

from tests.support import (
    MASTER_PASSWORD,
    Headers,
    auth,
    create_vault,
    db_snapshot,
    entry,
)

JSON = (b"content-type", b"application/json")


@pytest.fixture
async def vault(client: httpx.AsyncClient) -> Headers:
    headers = auth(await create_vault(client))
    resp = await client.post("/passwords/create", json=entry("box"), headers=headers)
    assert resp.status_code == 200
    return headers


@pytest.mark.parametrize("field", ["password_name", "username", "description"])
async def test_nul_in_a_plaintext_column_is_a_validation_error(
    client: httpx.AsyncClient, vault: Headers, field: str
) -> None:
    before = await db_snapshot()
    body = {**entry("nul-test"), field: "before\x00after"}

    resp = await client.post("/passwords/create", json=body, headers=vault)

    assert resp.status_code == 422, resp.text
    assert "NUL" in resp.text
    assert await db_snapshot() == before


@pytest.mark.parametrize("field", ["password_value", "url", "folder"])
async def test_nul_in_an_encrypted_field_round_trips(
    client: httpx.AsyncClient, vault: Headers, field: str
) -> None:
    body = {**entry("nul-ok"), field: "before\x00after"}
    resp = await client.post("/passwords/create", json=body, headers=vault)
    assert resp.status_code == 200, resp.text
    got = await client.get("/passwords/nul-ok", headers=vault)
    assert got.json()[field] == "before\x00after"


@pytest.mark.parametrize(
    "body",
    [
        b'{"password_name": "a\\ud800", "password_value": "v"}',
        b'{"password_name": "a", "password_value": "\\udfff"}',
        b'{"password_name": "a", "password_value": "v", "url": "\\ud83d"}',
        b'{"password_name": "a", "password_value": "v", "tags": ["\\ud800"]}',
        b'{"password_name": "a", "password_value": "v", '
        b'"custom_fields": [{"label": "\\ud800", "value": "x"}]}',
    ],
)
async def test_unpaired_surrogates_are_a_validation_error(
    client: httpx.AsyncClient, vault: Headers, body: bytes
) -> None:
    before = await db_snapshot()
    resp = await client.post("/passwords/create", content=body, headers=[*vault, JSON])
    assert resp.status_code == 422, resp.text
    assert await db_snapshot() == before


async def test_paired_surrogate_escapes_are_ordinary_text(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    body = b'{"password_name": "moth \\ud83e\\udd8b", "password_value": "v"}'
    resp = await client.post("/passwords/create", content=body, headers=[*vault, JSON])
    assert resp.status_code == 200, resp.text
    listing = await client.get("/passwords", headers=vault)
    assert "moth \U0001f98b" in [p["password_name"] for p in listing.json()]


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/master_password/unlock", b'{"master_password": "Moth-\\ud800-Vault-2026"}'),
        ("/master_password/create", b'{"master_password": "Moth-\\ud800-Vault-2026"}'),
    ],
)
async def test_master_password_routes_reject_unpaired_surrogates(
    client: httpx.AsyncClient, path: str, body: bytes
) -> None:
    resp = await client.post(path, content=body, headers=[JSON])
    assert resp.status_code == 422, resp.text


async def test_master_password_change_rejects_unpaired_surrogates(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    before = await db_snapshot()
    body = (
        b'{"master_password": "' + MASTER_PASSWORD.encode() + b'", '
        b'"new_master_password": "New-\\ud800-Vault-2027"}'
    )
    resp = await client.patch(
        "/master_password/update", content=body, headers=[*vault, JSON]
    )
    assert resp.status_code == 422, resp.text
    assert await db_snapshot() == before


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("GET", ""),
        ("DELETE", ""),
        ("POST", "/restore"),
        ("DELETE", "/purge"),
        ("GET", "/attachments"),
    ],
)
async def test_entry_names_with_nul_in_the_path_are_refused(
    client: httpx.AsyncClient, vault: Headers, method: str, suffix: str
) -> None:
    before = await db_snapshot()
    resp = await client.request(method, f"/passwords/box%00{suffix}", headers=vault)
    assert resp.status_code == 400, resp.text
    assert await db_snapshot() == before


async def test_update_identifies_the_entry_by_name_only(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "box"},
            "new_password": entry("box", "changed-Value-2"),
        },
        headers=vault,
    )
    assert resp.status_code == 200, resp.text
    got = await client.get("/passwords/box", headers=vault)
    assert got.json()["password_value"] == "changed-Value-2"

    resp = await client.patch(
        "/passwords/update",
        json={"password": {"password_name": "a\x00b"}, "new_password": entry("x")},
        headers=vault,
    )
    assert resp.status_code == 422


async def test_validation_errors_do_not_echo_submitted_values(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    weak = "weakpassword"
    resp = await client.post("/master_password/create", json={"master_password": weak})
    assert resp.status_code in (403, 422)
    assert weak not in resp.text

    secret_note = "secret-note-canary " * 600
    resp = await client.post(
        "/passwords/create",
        json=entry("echo", "secret-value-canary", description=secret_note),
        headers=vault,
    )
    assert resp.status_code == 422
    assert "secret-note-canary" not in resp.text
    assert "secret-value-canary" not in resp.text
    [error] = resp.json()["detail"]
    assert error["loc"] == ["body", "description"]
    assert "10000" in error["msg"]

    resp = await client.patch(
        "/master_password/update",
        json={"master_password": MASTER_PASSWORD, "new_master_password": weak},
        headers=vault,
    )
    assert resp.status_code == 422
    assert weak not in resp.text
    assert MASTER_PASSWORD not in resp.text
