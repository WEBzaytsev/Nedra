import os
import tempfile
from collections.abc import AsyncIterator

import httpx
import pytest

from api.body_limit import (
    ATTACHMENT_MAX_BODY_BYTES,
    BACKUP_IMPORT_MAX_BODY_BYTES,
    CSV_IMPORT_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
    body_limit_for,
)
from tests.support import (
    MASTER_PASSWORD,
    Headers,
    auth,
    create_vault,
    db_execute,
    entry,
)

MIB = 1024 * 1024
OLD_SPOOL_THRESHOLD = 1 * MIB
ATTACHMENT_CAP = 5 * MIB
IMPORT_CAP = 10 * MIB


@pytest.fixture
def disk_spills(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    spills: list[str] = []
    real_temporary = tempfile.TemporaryFile
    real_named = tempfile.NamedTemporaryFile

    def temporary(*args, **kwargs):
        spills.append("TemporaryFile")
        return real_temporary(*args, **kwargs)

    def named(*args, **kwargs):
        spills.append("NamedTemporaryFile")
        return real_named(*args, **kwargs)

    monkeypatch.setattr(tempfile, "TemporaryFile", temporary)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", named)
    return spills


async def _vault_with_entry(client: httpx.AsyncClient) -> Headers:
    key = await create_vault(client)
    resp = await client.post("/passwords/create", json=entry("box"), headers=auth(key))
    assert resp.status_code == 200
    return auth(key)


def _binary(size: int) -> bytes:
    return (b"\xff\xfe\x00\x80" + os.urandom(size))[:size]


async def _attachment_rows() -> int:
    return len(await db_execute("SELECT id FROM attachments"))


@pytest.mark.parametrize(
    "size",
    [OLD_SPOOL_THRESHOLD + 1, 3 * MIB, ATTACHMENT_CAP],
    ids=["just-over-old-threshold", "3MiB", "exactly-at-cap"],
)
async def test_binary_attachment_round_trips_without_touching_disk(
    client: httpx.AsyncClient, disk_spills: list[str], size: int
) -> None:
    headers = await _vault_with_entry(client)
    blob = _binary(size)

    resp = await client.post(
        "/passwords/box/attachments",
        files={"file": ("blob.bin", blob, "application/octet-stream")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["size_bytes"] == size
    assert disk_spills == []

    stored = await db_execute("SELECT content FROM attachments")
    assert blob not in stored[0][0]
    download = await client.get(
        f"/passwords/box/attachments/{resp.json()['id']}", headers=headers
    )
    assert download.status_code == 200
    assert download.content == blob


async def test_attachment_over_cap_is_rejected_without_touching_disk(
    client: httpx.AsyncClient, disk_spills: list[str]
) -> None:
    headers = await _vault_with_entry(client)
    resp = await client.post(
        "/passwords/box/attachments",
        files={"file": ("big.bin", _binary(ATTACHMENT_CAP + 1), "x/y")},
        headers=headers,
    )
    assert resp.status_code == 400
    assert disk_spills == []
    assert await _attachment_rows() == 0


async def test_oversized_request_is_refused_before_parsing(
    client: httpx.AsyncClient, disk_spills: list[str]
) -> None:
    headers = await _vault_with_entry(client)
    resp = await client.post(
        "/passwords/box/attachments",
        files={"file": ("huge.bin", _binary(ATTACHMENT_MAX_BODY_BYTES + 1), "x/y")},
        headers=headers,
    )
    assert resp.status_code == 413
    assert resp.json()["detail"]
    assert disk_spills == []
    assert await _attachment_rows() == 0


async def test_oversized_chunked_request_is_refused(
    client: httpx.AsyncClient, disk_spills: list[str]
) -> None:
    headers = await _vault_with_entry(client)
    boundary = "user-boundary"
    body = (
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="huge.bin"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        + _binary(ATTACHMENT_MAX_BODY_BYTES + MIB)
        + f"\r\n--{boundary}--\r\n".encode()
    )

    async def chunks() -> AsyncIterator[bytes]:
        for start in range(0, len(body), MIB):
            yield body[start : start + MIB]

    resp = await client.post(
        "/passwords/box/attachments",
        content=chunks(),
        headers=[
            *headers,
            (b"content-type", f"multipart/form-data; boundary={boundary}".encode()),
        ],
    )
    assert resp.status_code == 413
    assert disk_spills == []
    assert await _attachment_rows() == 0


async def test_oversized_json_body_is_refused(client: httpx.AsyncClient) -> None:
    headers = await _vault_with_entry(client)
    huge = "x" * (DEFAULT_MAX_BODY_BYTES + 1)
    resp = await client.post(
        "/passwords/create", json=entry("huge-note", huge), headers=headers
    )
    assert resp.status_code == 413
    assert len(await db_execute("SELECT id FROM entries")) == 1


async def test_large_secure_note_below_the_limit_still_works(
    client: httpx.AsyncClient,
) -> None:
    headers = await _vault_with_entry(client)
    body = "line of a long note\n" * (2 * MIB // 20)
    resp = await client.post(
        "/passwords/create", json=entry("long", body, kind="note"), headers=headers
    )
    assert resp.status_code == 200, resp.text
    resp = await client.get("/passwords/long", headers=headers)
    assert resp.json()["password_value"] == body


async def test_csv_import_above_old_threshold_stays_in_memory(
    client: httpx.AsyncClient, disk_spills: list[str]
) -> None:
    headers = await _vault_with_entry(client)
    filler = "p" * (100 * 1024)
    rows = ["name,username,password,notes"] + [
        f"site-{i},user{i},Pass-{i}-{filler},note {i}" for i in range(25)
    ]
    csv_bytes = ("\n".join(rows) + "\n").encode()
    assert len(csv_bytes) > 2 * MIB

    resp = await client.post(
        "/passwords/import/csv",
        data={"on_conflict": "skip"},
        files={"file": ("export.csv", csv_bytes, "text/csv")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 25
    assert disk_spills == []
    resp = await client.get("/passwords/site-3", headers=headers)
    assert resp.json()["password_value"] == f"Pass-3-{filler}"


async def test_csv_import_over_cap_is_rejected(
    client: httpx.AsyncClient, disk_spills: list[str]
) -> None:
    headers = await _vault_with_entry(client)
    csv_bytes = b"name,password\n" + b"a" * IMPORT_CAP
    resp = await client.post(
        "/passwords/import/csv",
        files={"file": ("export.csv", csv_bytes, "text/csv")},
        headers=headers,
    )
    assert resp.status_code == 400
    assert disk_spills == []
    assert len(await db_execute("SELECT id FROM entries")) == 1


def test_route_limits() -> None:
    assert body_limit_for("POST", "/api/passwords/box/attachments") == (
        ATTACHMENT_MAX_BODY_BYTES
    )
    assert body_limit_for("POST", "/api/passwords/import") == (
        BACKUP_IMPORT_MAX_BODY_BYTES
    )
    assert body_limit_for("POST", "/api/passwords/import/csv") == (
        CSV_IMPORT_MAX_BODY_BYTES
    )
    assert body_limit_for("POST", "/api/passwords/create") == DEFAULT_MAX_BODY_BYTES
    assert body_limit_for("PATCH", "/api/passwords/update") == DEFAULT_MAX_BODY_BYTES
    assert ATTACHMENT_MAX_BODY_BYTES > ATTACHMENT_CAP
    assert CSV_IMPORT_MAX_BODY_BYTES > IMPORT_CAP
    assert BACKUP_IMPORT_MAX_BODY_BYTES > 1024 * MIB


def _csv_of_exact_size(size: int) -> bytes:
    header = b"name,username,password\n"
    rows = [header]
    total = len(header)
    i = 0
    while total < size:
        row = f"site-{i:05d},user,".encode()
        room = size - total - len(row) - 1
        value = b"p" * max(1, min(10_000, room))
        line = row + value + b"\n"
        rows.append(line)
        total += len(line)
        i += 1
    data = b"".join(rows)
    return data[:size] if len(data) > size else data


async def test_largest_csv_v145_accepted_still_imports(
    client: httpx.AsyncClient, disk_spills: list[str]
) -> None:
    headers = await _vault_with_entry(client)
    csv_bytes = _csv_of_exact_size(IMPORT_CAP)
    assert len(csv_bytes) == IMPORT_CAP

    resp = await client.post(
        "/passwords/import/csv",
        data={"on_conflict": "skip"},
        files={"file": ("export.csv", csv_bytes, "text/csv")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] > 1000
    assert disk_spills == []


async def test_oversized_csv_and_malformed_large_backup_are_rejected(
    client: httpx.AsyncClient,
) -> None:
    headers = await _vault_with_entry(client)
    resp = await client.post(
        "/passwords/import/csv",
        files={"file": ("f", b"x" * (IMPORT_CAP + 1), "application/octet-stream")},
        headers=headers,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "File too large. Maximum allowed size is 10 MB."
    resp = await client.post(
        "/passwords/import",
        data={"master_password": MASTER_PASSWORD},
        files={"file": ("f.zip", b"PK\x03\x04" + b"x" * IMPORT_CAP, "x/y")},
        headers=headers,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "The file is not a Nedra backup."


async def test_imports_over_the_route_limit_are_refused(
    client: httpx.AsyncClient, disk_spills: list[str]
) -> None:
    headers = await _vault_with_entry(client)
    resp = await client.post(
        "/passwords/import/csv",
        files={"file": ("f.csv", b"x" * CSV_IMPORT_MAX_BODY_BYTES, "text/csv")},
        headers=headers,
    )
    assert resp.status_code == 413
    assert "11 MB" in resp.json()["detail"]
    assert disk_spills == []


async def test_attachment_between_cap_and_limit_keeps_the_old_error(
    client: httpx.AsyncClient,
) -> None:
    headers = await _vault_with_entry(client)
    resp = await client.post(
        "/passwords/box/attachments",
        files={"file": ("big.bin", _binary(ATTACHMENT_CAP + MIB // 2), "x/y")},
        headers=headers,
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Attachment too large. Maximum size is 5 MB."


async def test_editing_a_large_existing_note_still_works(
    client: httpx.AsyncClient,
) -> None:
    headers = await _vault_with_entry(client)
    body = "n" * (6 * MIB)
    note = entry("big-note", body, kind="note")
    resp = await client.post("/passwords/create", json=note, headers=headers)
    assert resp.status_code == 200
    edited = {**note, "password_value": body + "!"}
    resp = await client.patch(
        "/passwords/update",
        json={"password": note, "new_password": edited},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    resp = await client.get("/passwords/big-note", headers=headers)
    assert resp.json()["password_value"] == body + "!"
