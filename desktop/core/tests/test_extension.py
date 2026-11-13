"""The desktop core's extension sessions (native frames from the shell)."""

import json

import pytest
from core_client import REQUEST, Core, frame
from test_desktop import PASSWORD, api, create, entry

CLIENT = "AAAAAAAAAAAAAAAAAAAAAA"


@pytest.fixture
def core(tmp_path):
    instance = Core(tmp_path / "data", tmp_path / "core.log")
    yield instance
    instance.kill()


def native(core, header):
    request_id = core.next_id
    core.next_id += 1
    core.send(frame(REQUEST, request_id, header, b""))
    reply = core.wait(request_id, timeout=60)
    return reply


def extension(core, operation, **fields):
    reply = native(core, {"native": operation, **fields})
    assert reply.kind == 2, reply
    return reply.header["status"], json.loads(reply.body)


def test_a_paired_browser_gets_an_extension_session_only_while_unlocked(core):
    assert extension(core, "extension_status") == (200, {"unlocked": False})
    status, body = extension(core, "extension_open", browser="Chrome", client=CLIENT)
    assert (status, body["code"]) == (401, "locked")
    token = create(core)
    entry(core, token, url="https://github.com", username="moth")
    assert extension(core, "extension_status") == (200, {"unlocked": True})
    status, body = extension(core, "extension_open", browser="Chrome", client=CLIENT)
    assert status == 200 and len(body["session_token"]) == 43
    ext = body["session_token"]
    found = api(
        core, "POST", "/extension/matches", {"origin": "https://github.com"}, ext
    )
    assert found[0] == 200 and found[1]["logins"][0]["username"] == "moth"
    # It is an extension session: the vault itself refuses it.
    assert api(core, "GET", "/passwords", token=ext)[0] == 403
    # Reading the status is not activity and never needs the token.
    assert api(core, "GET", "/passwords", token=token)[0] == 200
    # The same pairing replaces its previous session.
    _, again = extension(core, "extension_open", browser="Chrome", client=CLIENT)
    assert api(core, "POST", "/extension/session", {}, ext)[0] == 401
    assert api(core, "POST", "/extension/session", {}, again["session_token"])[0] == 200
    assert extension(core, "extension_end") == (200, {"ended": 1})
    assert api(core, "POST", "/extension/session", {}, again["session_token"])[0] == 401
    # Locking the window's session locks the browsers out too.
    assert api(core, "POST", "/master_password/lock", token=token)[0] == 200
    assert extension(core, "extension_status") == (200, {"unlocked": False})
    assert extension(core, "extension_open", browser="Chrome", client=CLIENT)[0] == 401
    assert (
        api(core, "POST", "/master_password/unlock", {"master_password": PASSWORD})[0]
        == 200
    )


def test_cached_desktop_extension_token_dies_when_another_user_logs_in(core):
    """The native link may cache a token, but it is bound to one desktop user."""
    owner = create(core)
    created = api(
        core,
        "POST",
        "/users",
        {
            "username": "second",
            "role": "member",
            "temporary_password": "Second-Pass-2026!",
        },
        owner,
    )
    assert created[0] == 200
    entry(core, owner, url="https://github.com", username="owner-only")
    _, opened = extension(core, "extension_open", browser="Chrome", client=CLIENT)
    cached = opened["session_token"]
    status, signed_in = api(
        core,
        "POST",
        "/auth/login",
        {"username": "second", "password": "Second-Pass-2026!"},
    )
    assert status == 200 and signed_in["user"]["must_change_password"]
    status, changed = api(
        core,
        "PUT",
        "/auth/password",
        {
            "current_password": "Second-Pass-2026!",
            "new_password": "Second-Changed-Password-2026!",
        },
        signed_in["session_token"],
    )
    assert status == 200 and changed["session_token"]
    # A second full session makes the desktop principal ambiguous. The cached
    # token must be revoked at the extension authority boundary, not reused.
    assert api(core, "POST", "/extension/session", {}, cached)[0] == 401
    assert api(core, "POST", "/extension/session", {}, cached)[0] == 401
    # The new current user may open a new token, but cannot inherit A's entry.
    _, current = extension(core, "extension_open", browser="Chrome", client=CLIENT)
    matches = api(
        core,
        "POST",
        "/extension/matches",
        {"origin": "https://github.com"},
        current["session_token"],
    )
    assert matches == (200, {"logins": [], "truncated": False})


@pytest.mark.parametrize(
    "fields",
    [
        {"browser": "Netscape", "client": CLIENT},
        {"browser": "Chrome", "client": "short"},
        {"browser": "Chrome", "client": CLIENT, "extra": 1},
        {"browser": "Chrome"},
    ],
)
def test_malformed_requests_open_nothing(core, fields):
    create(core)
    reply = native(core, {"native": "extension_open", **fields})
    assert reply.kind != 2 or reply.header["status"] != 200
    assert extension(core, "extension_end") == (200, {"ended": 0})


def test_the_renderer_bridge_cannot_reach_these_operations(core):
    # A normal API request with a native-looking path is just a 404.
    token = create(core)
    assert api(core, "POST", "/extension_open", {}, token)[0] == 404
