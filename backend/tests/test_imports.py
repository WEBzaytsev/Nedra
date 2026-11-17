import csv
import io
from pathlib import Path

import httpx
import pytest
from hypothesis import given
from hypothesis import strategies as st

from tests.support import (
    MASTER_PASSWORD,
    Headers,
    auth,
    create_vault,
    db_execute,
    db_snapshot,
    entry,
    legacy_backup_zip,
    name_index,
    plant_entry,
)

KIB = 1024


def _csv(rows: list[list[str]]) -> bytes:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue().encode()


async def _import_csv(
    client: httpx.AsyncClient,
    headers: Headers,
    data: bytes,
    on_conflict: str = "skip",
) -> httpx.Response:
    return await client.post(
        "/passwords/import/csv",
        data={"on_conflict": on_conflict},
        files={"file": ("export.csv", data, "text/csv")},
        headers=headers,
    )


async def _import_zip(
    client: httpx.AsyncClient,
    headers: Headers,
    entries: list,
    on_conflict: str = "skip",
) -> httpx.Response:
    archive = legacy_backup_zip(entries, MASTER_PASSWORD)
    return await client.post(
        "/passwords/import",
        data={"master_password": MASTER_PASSWORD, "on_conflict": on_conflict},
        files={"file": ("backup.zip", archive, "application/zip")},
        headers=headers,
    )


async def _keep_only_existing() -> None:
    await db_execute(
        "DELETE FROM entries WHERE name_index <> :index",
        index=await name_index("existing"),
    )


@pytest.fixture
async def vault(client: httpx.AsyncClient) -> Headers:
    headers = auth(await create_vault(client))
    resp = await client.post(
        "/passwords/create",
        json=entry("existing", "existing-Pass-1", description="keep me"),
        headers=headers,
    )
    assert resp.status_code == 200
    return headers


async def _listing(client: httpx.AsyncClient, headers: Headers) -> list[dict]:
    resp = await client.get("/passwords", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.parametrize("size", [128 * KIB + 1, 512 * KIB, 4 * 1024 * KIB])
async def test_csv_cells_larger_than_the_csv_module_default_import(
    client: httpx.AsyncClient, vault: Headers, size: int
) -> None:
    value = "v" * size
    resp = await _import_csv(
        client, vault, _csv([["name", "password"], ["big", value]])
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 1
    got = await client.get("/passwords/big", headers=vault)
    assert got.json()["password_value"] == value


@pytest.mark.parametrize(
    ("column", "field", "limit"),
    [
        ("title", "password_name", 255),
        ("username", "username", 255),
        ("url", "url", 2048),
        ("notes", "description", 10_000),
        ("folder", "folder", 200),
    ],
)
async def test_csv_values_over_the_schema_limits_are_refused_and_nothing_is_written(
    client: httpx.AsyncClient, vault: Headers, column: str, field: str, limit: int
) -> None:
    header = ["title", "password", "username", "url", "notes", "folder"]
    good = ["fine", "fine-Pass-1", "u", "https://x.test", "n", "F"]
    bad = ["bad", "bad-Pass-1", "u", "https://x.test", "n", "F"]
    bad[header.index(column)] = "x" * (limit + 1)
    before = await db_snapshot()

    resp = await _import_csv(client, vault, _csv([header, good, bad]))

    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "row 3" in detail
    assert column in detail
    assert str(limit) in detail
    assert "x" * 50 not in detail
    assert await db_snapshot() == before
    assert [p["password_name"] for p in await _listing(client, vault)] == ["existing"]


async def test_csv_values_at_the_schema_limits_import_and_read_back(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    row = {
        "title": "n" * 255,
        "password": "p" * 10_000,
        "username": "u" * 255,
        "url": "h" * 2048,
        "notes": "d" * 10_000,
        "folder": "f" * 200,
    }
    resp = await _import_csv(client, vault, _csv([list(row), list(row.values())]))

    assert resp.status_code == 200, resp.text
    [imported] = [p for p in await _listing(client, vault) if p["username"]]
    assert imported["password_name"] == row["title"]
    assert imported["password_value"] == row["password"]
    assert imported["url"] == row["url"]
    assert imported["description"] == row["notes"]
    assert imported["folder"] == row["folder"]


async def test_a_failed_csv_import_does_not_overwrite_existing_entries(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    before = await db_snapshot()
    rows = [
        ["name", "password", "notes"],
        ["existing", "overwritten-Pass-2", "changed"],
        ["new", "new-Pass-1", "x" * 10_001],
    ]

    resp = await _import_csv(client, vault, _csv(rows), on_conflict="overwrite")

    assert resp.status_code == 400
    assert await db_snapshot() == before


async def test_unparseable_csv_gets_a_clear_error(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    before = await db_snapshot()
    for data in (b"\xff\xfe\x00bad", b"", b"just,a,header\n", b"name\nonly-names\n"):
        resp = await _import_csv(client, vault, data)
        assert resp.status_code == 400, (data, resp.text)
        assert resp.json()["detail"]
    assert await db_snapshot() == before


@pytest.mark.parametrize(
    ("bad_entry", "where"),
    [
        ({"name": "a", "value": "v", "tags": "not-a-list"}, "tags"),
        ({"name": "a", "value": 12345}, "value"),
        ({"name": ["a"], "value": "v"}, "name"),
        ({"name": "a", "value": "v", "username": {"nested": True}}, "username"),
        ({"name": "a", "value": "v", "url": 7}, "url"),
        ({"name": "a\x00b", "value": "v"}, "name"),
        ({"name": "a", "value": "v", "description": "x\x00y"}, "description"),
    ],
)
async def test_backup_entries_the_vault_cannot_store_are_refused(
    client: httpx.AsyncClient, vault: Headers, bad_entry: dict, where: str
) -> None:
    before = await db_snapshot()
    entries = [{"name": "fine", "value": "fine-Pass-1"}, bad_entry]

    resp = await _import_zip(client, vault, entries)

    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "entry 2" in detail
    assert where in detail
    assert await db_snapshot() == before
    assert len(await _listing(client, vault)) == 1


LEGACY_ENTRIES = [
    {"name": "n" * 300, "value": "long-name-Value"},
    {"name": "long notes", "value": "v", "description": "d" * 20_000},
    {"name": "long username", "value": "v", "username": "u" * 300},
    {"name": "long url", "value": "v", "url": "h" * 3000},
    {"name": "long folder", "value": "v", "folder": "f" * 300},
    {
        "name": "many tags",
        "value": "v",
        "tags": [f"t{i}" + "x" * 50 for i in range(25)],
    },
    {"name": "bad totp", "value": "v", "totp_secret": "steam://NOTBASE32!"},
    {
        "name": "uri totp",
        "value": "v",
        "totp_secret": "otpauth://totp/x?secret=jbswy3dpehpk3pxp",
    },
    {
        "name": "big fields",
        "value": "v",
        "custom_fields": [
            {"label": "l" * 150, "value": "x" * 5000, "hidden": True},
            *({"label": f"f{i}", "value": "x"} for i in range(35)),
        ],
    },
    {"name": "foo", "value": "plain"},
    {"name": ".", "value": "dot"},
    {"name": "trash", "value": "reserved now"},
    {"name": "foo ", "value": "trailing space"},
    {"name": "  spaced  ", "value": "  keep surrounding spaces  ", "kind": "note"},
    {
        "name": "untrimmed",
        "value": "v",
        "tags": [" a ", "a"],
        "custom_fields": [{"label": " pin ", "value": " 1234 ", "hidden": True}],
        "folder": "",
    },
]


async def test_backups_restore_exactly_what_the_vault_held(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await _import_zip(client, vault, LEGACY_ENTRIES)

    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == len(LEGACY_ENTRIES)
    by_name = {p["password_name"]: p for p in await _listing(client, vault)}
    for item in LEGACY_ENTRIES:
        got = by_name[item["name"]]
        assert got["password_value"] == item["value"]
        for field in ("username", "url", "description"):
            assert got[field] == item.get(field), (item["name"], field)
        if "tags" in item:
            assert got["tags"] == item["tags"]
        if "custom_fields" in item:
            assert len(got["custom_fields"]) == len(item["custom_fields"])
    assert by_name["bad totp"]["totp_secret"] == "steam://NOTBASE32!"
    assert by_name["uri totp"]["totp_secret"] == "JBSWY3DPEHPK3PXP"
    assert by_name["long folder"]["folder"] == "f" * 300
    assert by_name["untrimmed"]["folder"] is None
    assert by_name["untrimmed"]["custom_fields"] == [
        {"label": " pin ", "value": " 1234 ", "hidden": True}
    ]
    assert by_name["  spaced  "]["kind"] == "note"


async def test_a_backup_of_a_vault_with_legacy_values_restores_completely(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await _import_zip(client, vault, LEGACY_ENTRIES)
    assert resp.status_code == 200, resp.text
    original = await _listing(client, vault)
    backup = await client.post(
        "/passwords/backup", json={"master_password": MASTER_PASSWORD}, headers=vault
    )
    assert backup.status_code == 200
    await db_execute("DELETE FROM entries")

    resp = await client.post(
        "/passwords/import",
        data={"master_password": MASTER_PASSWORD},
        files={"file": ("backup.zip", backup.content, "application/zip")},
        headers=vault,
    )

    assert resp.status_code == 200, resp.text
    fields = ("password_name", "kind", "username", "password_value", "url")
    fields += ("totp_secret", "description", "tags", "custom_fields", "folder")
    assert [{f: p[f] for f in fields} for p in await _listing(client, vault)] == [
        {f: p[f] for f in fields} for p in original
    ]


async def test_editing_a_restored_entry_applies_the_normal_limits(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    await _import_zip(client, vault, LEGACY_ENTRIES)
    resp = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "long username"},
            "new_password": entry("long username", "v2", username="u" * 300),
        },
        headers=vault,
    )
    assert resp.status_code == 422
    resp = await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "long username"},
            "new_password": entry("long username", "v2", username="fixed"),
        },
        headers=vault,
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.parametrize("name", [".", "..", "trash"])
async def test_unaddressable_names_cannot_be_created(
    client: httpx.AsyncClient, vault: Headers, name: str
) -> None:
    resp = await client.post("/passwords/create", json=entry(name), headers=vault)
    assert resp.status_code == 422
    resp = await _import_csv(client, vault, _csv([["name", "password"], [name, "v"]]))
    assert resp.status_code == 400


async def test_backup_entries_without_a_name_or_value_are_reported(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await _import_zip(
        client,
        vault,
        [
            {"name": "", "value": "v"},
            {"name": "no-value", "value": ""},
            {"value": "v"},
            "not an object",
            None,
            {"name": "kept", "value": "kept-Pass-1"},
        ],
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert (result["imported"], result["total"], result["ignored"]) == (1, 1, 5)
    assert result["ignored_rows"] == [
        {"where": "entry 1", "name": None, "reason": "no name"},
        {"where": "entry 2", "name": "no-value", "reason": "no password or note text"},
        {"where": "entry 3", "name": None, "reason": "no name"},
        {"where": "entry 4", "name": None, "reason": "not an entry"},
        {"where": "entry 5", "name": None, "reason": "not an entry"},
    ]


async def test_csv_rows_that_hold_nothing_importable_are_reported_not_dropped(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    rows = [
        ["type", "name", "password", "notes"],
        ["login", "kept", "kept-Pass-1", ""],
        ["login", "", "orphan-Pass-1", ""],
        ["login", "no password", "", "only a note"],
        ["note", "empty note", "", "   "],
        ["note", "", "", "body without a name"],
        ["identity", "Me", "", ""],
        ["", "", "", ""],
        ["note", "recovery", "", "  code-1\ncode-2\n"],
    ]

    resp = await _import_csv(client, vault, _csv(rows))

    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert (result["imported"], result["ignored"]) == (2, 5)
    assert [(r["where"], r["reason"]) for r in result["ignored_rows"]] == [
        ("row 3", "no name"),
        ("row 4", "no password"),
        ("row 5", "secure note without text"),
        ("row 6", "secure note without a name"),
        ("row 7", "'identity' items can't be imported"),
    ]
    note = (await client.get("/passwords/recovery", headers=vault)).json()
    assert note["kind"] == "note"
    assert note["password_value"] == "  code-1\ncode-2\n"
    assert note["description"] is None


async def test_the_ignored_report_is_bounded(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    rows = [["name", "password"]] + [[f"n{i}", ""] for i in range(250)]
    resp = await _import_csv(client, vault, _csv(rows))
    assert resp.json()["ignored"] == 250
    assert len(resp.json()["ignored_rows"]) == 100


async def test_a_vault_poisoned_by_an_older_import_can_be_read_and_repaired(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    long_name = "n" * 300
    await plant_entry(
        long_name,
        "poisoned-Pass-1",
        username="u" * 300,
        description="d" * 2000,
        totp_secret="not base32!",
        tags=["1", "ok", "t" * 60],
        custom_fields=[{"label": "l" * 150, "value": "v" * 5000, "hidden": False}],
        folder="f" * 300,
    )

    listing = await _listing(client, vault)
    poisoned = next(p for p in listing if p["password_name"] == long_name)
    assert poisoned["description"] == "d" * 2000
    assert poisoned["password_value"] == "poisoned-Pass-1"
    assert poisoned["totp_secret"] == "not base32!"
    assert poisoned["tags"] == ["1", "ok", "t" * 60]
    assert poisoned["custom_fields"][0]["value"] == "v" * 5000

    resp = await client.patch(
        "/passwords/update",
        json={
            "password": poisoned,
            "new_password": entry("repaired", "poisoned-Pass-1", description="ok"),
        },
        headers=vault,
    )
    assert resp.status_code == 200, resp.text
    names = [p["password_name"] for p in await _listing(client, vault)]
    assert names == ["existing", "repaired"]


CSV_DIR = Path(__file__).resolve().parents[2] / "testdata" / "csv"

THIRD_PARTY_EXPORTS = {
    "chrome.csv": {
        "example.com": {
            "username": "moth@example.com",
            "password_value": "Chr0me-Pass!",
            "url": "https://example.com/login",
            "description": None,
        },
        "bank.test": {
            "username": "moth",
            "password_value": 'pa,ss"word ',
            "url": "https://bank.test/",
            "description": "Branch 12",
        },
    },
    "bitwarden.csv": {
        "GitHub": {
            "username": "moth",
            "password_value": "Bw-Pass-1",
            "url": "https://github.com",
            "description": "multi\nline note",
            "folder": "Work",
            "totp_secret": "JBSWY3DPEHPK3PXP",
        },
        "Mail ✉": {
            "username": "moth@example.com",
            "password_value": "Bw-Pass-2",
            "folder": "Personal",
            "totp_secret": None,
        },
        "Secure note": {
            "kind": "note",
            "password_value": "note body",
            "description": None,
            "username": None,
        },
    },
    "keepassxc.csv": {
        "Mail": {
            "username": "moth",
            "password_value": "Kp-Pass-1",
            "url": "https://mail.test",
            "description": None,
            "folder": "Root/Email",
            "totp_secret": "JBSWY3DPEHPK3PXP",
        },
        "Router": {
            "username": "admin",
            "password_value": "Kp-Pass-2 with spaces ",
            "url": "http://192.168.1.1",
            "description": 'Garage "B"',
            "folder": "Root",
        },
    },
    "protonpass.csv": {
        "Proton": {
            "username": "moth@proton.me",
            "password_value": "Pr-Pass-1",
            "url": "https://account.proton.me",
            "totp_secret": "JBSWY3DPEHPK3PXP",
            "folder": None,
        },
        "Forum": {
            "username": "mothman",
            "password_value": "Pr-Pass-2",
            "description": "hello",
        },
        "Shopping list": {"kind": "note", "password_value": "eggs"},
    },
}


THIRD_PARTY_IGNORED = {
    "bitwarden.csv": [
        {
            "where": "row 5",
            "name": "Visa ending 4242",
            "reason": "'card' items can't be imported",
        }
    ],
    "protonpass.csv": [
        {
            "where": "row 5",
            "name": "Shop alias",
            "reason": "'alias' items can't be imported",
        }
    ],
}


@pytest.mark.parametrize("export", sorted(THIRD_PARTY_EXPORTS))
async def test_supported_third_party_exports_import(
    client: httpx.AsyncClient, vault: Headers, export: str
) -> None:
    expected = THIRD_PARTY_EXPORTS[export]
    resp = await _import_csv(client, vault, (CSV_DIR / export).read_bytes())

    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result["imported"] == len(expected)
    ignored = THIRD_PARTY_IGNORED.get(export, [])
    assert result["ignored"] == len(ignored)
    assert result["ignored_rows"] == ignored
    by_name = {p["password_name"]: p for p in await _listing(client, vault)}
    for name, fields in expected.items():
        got = by_name[name]
        assert got["kind"] == fields.get("kind", "login")
        for field, value in fields.items():
            assert got[field] == value, (name, field)


async def test_csv_with_old_mac_line_endings_imports(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await _import_csv(client, vault, b"name,password\rcr-only,cr-Pass-1\r")
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 1


_CELL = st.text(
    alphabet=st.characters(blacklist_categories=("Cs",)), min_size=0, max_size=40
)


@st.composite
def _csv_rows(draw: st.DrawFn) -> tuple[list[dict[str, str]], str | None]:
    rows = []
    for index in range(draw(st.integers(min_value=1, max_value=6))):
        rows.append(
            {
                "name": f"r{index}-" + draw(_CELL),
                "username": draw(_CELL),
                "password": draw(_CELL.filter(bool)),
                "url": draw(_CELL),
                "notes": draw(_CELL),
                "folder": draw(_CELL),
            }
        )
    defect = draw(st.sampled_from([None, None, "long-notes", "nul-name"]))
    if defect == "long-notes":
        rows[-1]["notes"] = "n" * 10_001
    elif defect == "nul-name":
        rows[-1]["name"] += "\x00"
    return rows, defect


def _expected_csv_value(cell: str) -> str | None:
    return cell.strip() or None


@given(case=_csv_rows())
async def test_csv_import_property(
    client: httpx.AsyncClient, vault: Headers, case: tuple[list[dict], str | None]
) -> None:
    rows, defect = case
    await _keep_only_existing()
    header = ["name", "username", "password", "url", "notes", "folder"]
    before = await db_snapshot()

    resp = await _import_csv(
        client, vault, _csv([header, *([row[h] for h in header] for row in rows)])
    )

    if defect or any(
        "\x00" in row["name"] + row["username"] + row["notes"] for row in rows
    ):
        assert resp.status_code == 400, resp.text
        assert await db_snapshot() == before
        return
    assert resp.status_code == 200, resp.text
    by_name = {p["password_name"]: p for p in await _listing(client, vault)}
    for row in rows:
        got = by_name[row["name"].strip()]
        assert got["password_value"] == row["password"]
        assert got["username"] == _expected_csv_value(row["username"])
        assert got["url"] == _expected_csv_value(row["url"])
        assert got["description"] == _expected_csv_value(row["notes"])
        assert got["folder"] == _expected_csv_value(row["folder"])


@given(data=st.binary(max_size=2048))
async def test_arbitrary_csv_bytes_never_break_the_vault(
    client: httpx.AsyncClient, vault: Headers, data: bytes
) -> None:
    await _keep_only_existing()
    resp = await _import_csv(client, vault, b"name,password,notes\n" + data)
    assert resp.status_code in (200, 400), resp.text
    await _listing(client, vault)


_JSON = st.recursive(
    st.none()
    | st.booleans()
    | st.integers()
    | st.floats(allow_nan=False)
    | st.text(alphabet=st.characters(blacklist_categories=("Cs",)), max_size=30),
    lambda children: (
        st.lists(children, max_size=4)
        | st.dictionaries(st.text(max_size=8), children, max_size=4)
    ),
    max_leaves=10,
)
_BACKUP_KEYS = st.sampled_from(
    [
        "name",
        "value",
        "kind",
        "username",
        "url",
        "totp_secret",
        "description",
        "tags",
        "custom_fields",
        "folder",
        "favorite",
    ]
)


@given(
    entries=st.lists(
        st.dictionaries(_BACKUP_KEYS, _JSON).map(
            lambda d: {"name": "fuzz", "value": "fuzz-Value-1", **d}
        )
        | _JSON,
        max_size=4,
    )
)
async def test_arbitrary_backup_entries_never_break_the_vault(
    client: httpx.AsyncClient, vault: Headers, entries: list
) -> None:
    await _keep_only_existing()
    before = await db_snapshot()

    resp = await _import_zip(client, vault, entries, on_conflict="overwrite")

    assert resp.status_code in (200, 400), resp.text
    if resp.status_code == 400:
        assert await db_snapshot() == before
    listing = await _listing(client, vault)
    assert "existing" in [p["password_name"] for p in listing]


async def test_secrets_stored_by_older_imports_still_produce_codes(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    await plant_entry(
        "legacy uri",
        "v",
        totp_secret="otpauth://totp/x?secret=jbsw y3dp ehpk 3pxp",
        folder="",
    )
    [got] = [
        p for p in await _listing(client, vault) if p["password_name"] == "legacy uri"
    ]
    assert got["totp_secret"] == "JBSWY3DPEHPK3PXP"
    assert got["folder"] is None


async def test_accounts_sharing_a_name_in_one_file_are_all_imported(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    rows = [
        ["name", "url", "username", "password"],
        ["accounts.google.com", "https://accounts.google.com", "alice", "alice-Pass-1"],
        ["accounts.google.com", "https://accounts.google.com", "bob", "bob-Pass-2"],
        [
            "accounts.google.com ",
            "https://accounts.google.com",
            "carol",
            "carol-Pass-3",
        ],
    ]

    resp = await _import_csv(client, vault, _csv(rows))

    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert (result["imported"], result["skipped"], result["renamed"]) == (3, 0, 2)
    assert [(r["where"], r["name"]) for r in result["renamed_rows"]] == [
        ("row 3", "accounts.google.com"),
        ("row 4", "accounts.google.com"),
    ]
    assert "accounts.google.com (2)" in result["renamed_rows"][0]["reason"]
    by_name = {p["password_name"]: p for p in await _listing(client, vault)}
    assert by_name["accounts.google.com"]["username"] == "alice"
    assert by_name["accounts.google.com (2)"]["username"] == "bob"
    assert by_name["accounts.google.com (3)"]["username"] == "carol"


async def test_renamed_rows_never_collide_with_existing_entries(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    for name in ("site", "site (2)"):
        resp = await client.post("/passwords/create", json=entry(name), headers=vault)
        assert resp.status_code == 200
    rows = [["name", "password"], ["site", "first"], ["site", "second"]]

    resp = await _import_csv(client, vault, _csv(rows), on_conflict="overwrite")

    result = resp.json()
    assert (result["overwritten"], result["imported"], result["renamed"]) == (1, 1, 1)
    by_name = {p["password_name"]: p for p in await _listing(client, vault)}
    assert by_name["site"]["password_value"] == "first"
    assert by_name["site (2)"]["password_value"] == "s3cret-Value!"
    assert by_name["site (3)"]["password_value"] == "second"


async def test_renamed_long_names_stay_within_the_name_limit(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    name = "n" * 255
    rows = [["name", "password"], [name, "a"], [name, "b"]]
    resp = await _import_csv(client, vault, _csv(rows))
    assert resp.json()["renamed"] == 1
    names = [p["password_name"] for p in await _listing(client, vault)]
    assert "n" * 251 + " (2)" in names
    assert max(len(n) for n in names) == 255


@pytest.mark.parametrize(
    ("item_type", "password", "outcome"),
    [
        ("password", "p-1", "imported"),
        ("Login", "p-1", "imported"),
        ("website", "p-1", "imported"),
        ("password", "", "no password"),
        ("creditCard", "", "'creditCard' items can't be imported"),
        ("sshKey", "", "'sshKey' items can't be imported"),
    ],
)
async def test_csv_item_types_other_than_known_non_logins_import_as_logins(
    client: httpx.AsyncClient,
    vault: Headers,
    item_type: str,
    password: str,
    outcome: str,
) -> None:
    rows = [["type", "name", "password"], [item_type, "item", password]]
    resp = await _import_csv(client, vault, _csv(rows))
    result = resp.json()
    if outcome == "imported":
        assert result["imported"] == 1, result
    else:
        assert result["imported"] == 0
        assert result["ignored_rows"][0]["reason"] == outcome


async def test_backup_tags_that_are_not_strings_restore_as_text(
    client: httpx.AsyncClient, vault: Headers
) -> None:
    resp = await _import_zip(
        client, vault, [{"name": "tagged", "value": "v", "tags": [1, None, "a", 2.5]}]
    )
    assert resp.status_code == 200, resp.text
    got = (await client.get("/passwords/tagged", headers=vault)).json()
    assert got["tags"] == ["1", "a", "2.5"]


@pytest.mark.parametrize("source", ["legacy-zip", "csv"])
async def test_an_overwriting_import_moves_the_replaced_entry_to_the_trash(
    client: httpx.AsyncClient, vault: Headers, source: str
) -> None:
    current = entry("existing", "first-Pass-1", username="me", description="keep me")
    await client.patch(
        "/passwords/update",
        json={
            "password": {"password_name": "existing"},
            "new_password": {**current, "password_value": "current-Pass-2"},
        },
        headers=vault,
    )
    await client.post(
        "/passwords/existing/attachments",
        files={"file": ("a.bin", b"attached", "x/y")},
        headers=vault,
    )
    if source == "csv":
        resp = await _import_csv(
            client,
            vault,
            _csv([["name", "password"], ["existing", "imported-Pass-3"]]),
            on_conflict="overwrite",
        )
    else:
        resp = await _import_zip(
            client,
            vault,
            [{"name": "existing", "value": "imported-Pass-3"}],
            on_conflict="overwrite",
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["overwritten"] == 1

    active = (await client.get("/passwords/existing", headers=vault)).json()
    assert active["password_value"] == "imported-Pass-3"
    [replaced] = (await client.get("/passwords/trash", headers=vault)).json()
    assert replaced["password_value"] == "current-Pass-2"
    assert replaced["username"] == "me"
    assert replaced["description"] == "keep me"
    assert [h["value"] for h in replaced["password_history"]] == ["existing-Pass-1"]
    assert replaced["attachment_count"] == 1
