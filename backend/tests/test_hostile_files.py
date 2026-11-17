import json
import sqlite3
from contextlib import closing
from pathlib import Path

import httpx
import pytest

from storage import VAULT_FILE
from tests.support import (
    MASTER_PASSWORD,
    Headers,
    api_server,
    auth,
    create_vault,
    db_execute,
    db_snapshot,
    entry,
)

MIB = 1024 * 1024


@pytest.fixture
async def vault(client: httpx.AsyncClient) -> Headers:
    headers = auth(await create_vault(client))
    for name in ("box", "other"):
        resp = await client.post("/passwords/create", json=entry(name), headers=headers)
        assert resp.status_code == 200
    return headers


async def _upload(
    client: httpx.AsyncClient,
    headers: Headers,
    filename: bytes | str,
    data: bytes = b"data",
    entry_name: str = "box",
) -> httpx.Response:
    raw_name = filename.encode() if isinstance(filename, str) else filename
    boundary = b"user-boundary"
    body = (
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="file"; filename="' + raw_name + b'"\r\n'
        b"Content-Type: application/octet-stream\r\n\r\n" + data + b"\r\n"
        b"--" + boundary + b"--\r\n"
    )
    return await client.post(
        f"/passwords/{entry_name}/attachments",
        content=body,
        headers=[
            *headers,
            (b"content-type", b"multipart/form-data; boundary=" + boundary),
        ],
    )


@pytest.mark.parametrize(
    "filename",
    [
        "../../etc/passwd",
        "C:\\Windows\\system32\\evil.dll",
        "name with spaces and ; semicolons.txt",
        'quote\\".txt',
        "Preț ✓ 🦋 名前.pdf",
        "x" * 1000 + ".bin",
        ".hidden",
        "esc\x1b[31mred\x07bell\ttab\x7f.txt",
    ],
)
async def test_unusual_attachment_filenames_round_trip_safely(
    client: httpx.AsyncClient, vault: Headers, filename: str
) -> None:
    resp = await _upload(client, vault, filename)
    assert resp.status_code == 200, resp.text
    attachment = resp.json()

    download = await client.get(
        f"/passwords/box/attachments/{attachment['id']}", headers=vault
    )

    assert download.status_code == 200
    assert download.content == b"data"
    disposition = download.headers["content-disposition"]
    assert disposition.startswith("attachment; ")
    assert "\r" not in disposition and "\n" not in disposition
    assert disposition.count('"') == 2
    assert all(c.isprintable() for c in disposition)


@pytest.mark.parametrize(
    "raw_name",
    [b"bad\xff\xfe.bin", b"\xed\xa0\x80.txt", b"line\r\nSet-Cookie: x=y.txt"],
)
async def test_hostile_filename_bytes_never_cause_a_500_or_header_injection(
    client: httpx.AsyncClient, vault: Headers, raw_name: bytes
) -> None:
    resp = await _upload(client, vault, raw_name)
    assert resp.status_code in (200, 400, 422), resp.text
    if resp.status_code != 200:
        return
    download = await client.get(
        f"/passwords/box/attachments/{resp.json()['id']}", headers=vault
    )
    assert download.status_code == 200
    assert "set-cookie" not in download.headers


async def test_attachment_caps_hold_exactly_at_their_limits(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    for i in range(4):
        resp = await _upload(client, vault, f"big{i}.bin", b"\x00" * (5 * MIB))
        assert resp.status_code == 200, resp.text
    resp = await _upload(client, vault, "fill.bin", b"\x01" * (5 * MIB))
    assert resp.status_code == 200, resp.text
    resp = await _upload(client, vault, "one-byte-over.bin", b"\x02")
    assert resp.status_code == 400
    assert "25 MB" in resp.json()["detail"]

    for i in range(20):
        resp = await _upload(client, vault, f"small{i}.bin", b"s", entry_name="other")
        assert resp.status_code == 200, resp.text
    resp = await _upload(client, vault, "twenty-first.bin", b"s", entry_name="other")
    assert resp.status_code == 400
    assert "20" in resp.json()["detail"]


async def test_attachments_are_scoped_to_their_entry(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await _upload(client, vault, "secret.bin", b"only for box")
    attachment_id = resp.json()["id"]

    for method in ("GET", "DELETE"):
        resp = await client.request(
            method, f"/passwords/other/attachments/{attachment_id}", headers=vault
        )
        assert resp.status_code == 404
    assert (
        await client.get(f"/passwords/box/attachments/{attachment_id}", headers=vault)
    ).content == b"only for box"


async def test_attachments_of_trashed_entries_are_hidden_kept_and_purged(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    attachment_id = (await _upload(client, vault, "kept.bin", b"kept")).json()["id"]
    assert (await client.delete("/passwords/box", headers=vault)).status_code == 200

    resp = await client.get(
        f"/passwords/box/attachments/{attachment_id}", headers=vault
    )
    assert resp.status_code == 404
    resp = await _upload(client, vault, "into-trash.bin")
    assert resp.status_code == 404
    assert await db_execute("SELECT count(*) FROM attachments") == [(1,)]

    assert (await client.post("/passwords/box/restore", headers=vault)).is_success
    resp = await client.get(
        f"/passwords/box/attachments/{attachment_id}", headers=vault
    )
    assert resp.content == b"kept"

    await client.delete("/passwords/box", headers=vault)
    await client.delete("/passwords/box/purge", headers=vault)
    assert await db_execute("SELECT count(*) FROM attachments") == [(0,)]


async def test_renaming_onto_an_existing_name_is_refused(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    before = await db_snapshot()
    resp = await client.patch(
        "/passwords/update",
        json={"password": entry("box"), "new_password": entry("other")},
        headers=vault,
    )
    assert resp.status_code == 400
    assert await db_snapshot() == before


async def test_names_differing_only_in_case_or_surrounding_space_are_distinct_or_merged(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await client.post("/passwords/create", json=entry("BOX"), headers=vault)
    assert resp.status_code == 200
    resp = await client.post("/passwords/create", json=entry("  box  "), headers=vault)
    assert resp.status_code == 400
    names = [
        p["password_name"]
        for p in (await client.get("/passwords", headers=vault)).json()
    ]
    assert names.count("box") == 1 and "BOX" in names
    assert json.dumps(names)


def test_a_value_sqlite_cannot_decode_never_wedges_the_vault(tmp_path: Path) -> None:
    folder = tmp_path / "data"
    with api_server(tmp_path / "server.log", folder) as server:
        api = server.base_url
        created = httpx.post(
            f"{api}/master_password/create", json={"master_password": MASTER_PASSWORD}
        )
        headers = {"x-nedra-session": created.json()["session_token"]}
        resp = httpx.post(f"{api}/passwords/create", json=entry("one"), headers=headers)
        assert resp.status_code == 200
        with closing(sqlite3.connect(folder / VAULT_FILE)) as connection:
            connection.execute("UPDATE entries SET document = x'02' || randomblob(60)")
            connection.commit()
        for _ in range(3):
            resp = httpx.get(f"{api}/passwords", headers=headers)
            assert resp.status_code == 200
            assert resp.json() == []
            resp = httpx.get(f"{api}/vault/damaged", headers=headers)
            assert resp.json()["entries"] == [1]
        for _ in range(3):
            resp = httpx.delete(f"{api}/passwords/one", headers=headers)
            assert resp.status_code == 500
            assert resp.json()["code"] == "vault_damaged"
            with closing(
                sqlite3.connect(folder / VAULT_FILE, timeout=0.5, isolation_level=None)
            ) as other_writer:
                other_writer.execute("BEGIN IMMEDIATE")
                other_writer.execute("ROLLBACK")
        with closing(sqlite3.connect(folder / VAULT_FILE)) as connection:
            connection.execute("DELETE FROM entries")
            connection.commit()

        for index in range(12):
            resp = httpx.post(
                f"{api}/passwords/create",
                json=entry(f"after-{index}"),
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
