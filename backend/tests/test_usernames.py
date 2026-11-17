"""Normalize account names before validation without changing passwords."""

import httpx
import pytest
from pydantic import TypeAdapter, ValidationError

from schemas import Username
from tests.support import auth


@pytest.mark.parametrize(
    "username", ["a", "a" * 65, ".user", "user name", "кириллица", None, 42]
)
def test_username_still_rejects_invalid_input(username: object) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(Username).validate_python(username)


@pytest.mark.asyncio
async def test_mixed_case_names_work_for_bootstrap_create_and_login(
    client: httpx.AsyncClient,
) -> None:
    password = "Mixed-Case-Password-2026!"
    bootstrap = await client.post(
        "/auth/bootstrap", json={"username": " Owner.Admin ", "password": password}
    )
    assert bootstrap.status_code == 200
    assert bootstrap.json()["user"]["username"] == "owner.admin"
    headers = auth(bootstrap.json()["session_token"])
    for role, name in [("member", "MarkusMakEvil"), ("service", "Service.Bot")]:
        payload = {"username": name, "role": role}
        if role == "member":
            payload["temporary_password"] = password
        else:
            payload["current_password"] = password
        created = await client.post("/users", json=payload, headers=headers)
        assert created.status_code == 200
        assert created.json()["username"] == name.lower()
        duplicate = await client.post(
            "/users", json={**payload, "username": name.lower()}, headers=headers
        )
        assert duplicate.status_code == 400
        assert "username" in duplicate.json()["detail"].lower()
    for username in ["MarkusMakEvil", "markusmakevil", " MARKUSMAKEVIL "]:
        login = await client.post(
            "/auth/login", json={"username": username, "password": password}
        )
        assert login.status_code == 200
        assert login.json()["valid"] is True
        assert login.json()["user"]["username"] == "markusmakevil"
    wrong_password = await client.post(
        "/auth/login", json={"username": "MarkusMakEvil", "password": password.lower()}
    )
    assert wrong_password.json()["valid"] is False
    invalid = await client.post(
        "/users",
        json={
            "username": "invalid user",
            "role": "member",
            "temporary_password": password,
        },
        headers=headers,
    )
    assert invalid.status_code == 422
    assert invalid.json()["detail"][0]["loc"] == ["body", "username"]
