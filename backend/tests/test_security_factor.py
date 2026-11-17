import json
import os

import pytest

from helpers import (
    DecryptionFailed,
    SecurityKeySlot,
    create_key_material,
    new_factor_key,
    unlock_key_material,
    unwrap_factor_key,
    wrap_factor_key,
)
from tests.support import auth, create_vault
from webauthn import (
    Challenges,
    VerificationFailed,
    counter_advanced,
    registration_rp_id,
    verify_registration,
)


@pytest.mark.anyio
async def test_security_routes_require_a_session_and_issue_first_key_options(client):
    assert (await client.get("/security")).status_code == 401
    token = await create_vault(client)
    status = await client.get("/security", headers=auth(token))
    assert status.status_code == 200, status.text
    assert status.json() == {"enabled": False, "security_keys": []}
    options = await client.post("/security/keys/options", headers=auth(token))
    assert options.status_code == 200, options.text
    assert options.json()["timeout_ms"] == 120_000
    assert options.json()["algorithms"] == [-7, -8, -257]


@pytest.mark.anyio
async def test_factor_wrapped_material_fails_closed_without_the_factor():
    password = "Moth-Test-Vault-2026!"
    factor_key = new_factor_key()
    material, vault_key = await create_key_material(password, factor_key=factor_key)

    assert await unlock_key_material(password, material) is None
    assert await unlock_key_material(password, material, os.urandom(32)) is None
    unlocked = await unlock_key_material(password, material, factor_key)
    assert unlocked is not None
    assert unlocked.matches(vault_key.check)


def test_prf_factor_key_is_bound_to_the_registered_credential():
    prf = os.urandom(32)
    factor = new_factor_key()
    slot = SecurityKeySlot(
        os.urandom(16), b"credential", b"public-key", "localhost", os.urandom(32)
    )
    sealed = wrap_factor_key(prf, factor, slot)

    assert unwrap_factor_key(prf, sealed, slot) == factor
    with pytest.raises(DecryptionFailed):
        unwrap_factor_key(
            prf,
            sealed,
            SecurityKeySlot(
                os.urandom(16),
                b"credential",
                b"public-key",
                "localhost",
                slot.prf_salt,
            ),
        )


def test_challenges_are_bound_single_use_and_counter_checks_clones():
    challenges = Challenges()
    challenge = challenges.issue("login", b"user")
    assert challenges.consume(challenge, "login", b"user") == b""
    with pytest.raises(VerificationFailed):
        challenges.consume(challenge, "login", b"user")

    challenge = challenges.issue("login", b"user")
    with pytest.raises(VerificationFailed):
        challenges.consume(challenge, "login", b"another-user")

    assert counter_advanced(0, 0)
    assert counter_advanced(3, 4)
    assert not counter_advanced(3, 3)
    assert not counter_advanced(3, 0)


def test_malformed_webauthn_registration_is_rejected():
    with pytest.raises(VerificationFailed):
        verify_registration("localhost", os.urandom(32), b"not json", b"not cbor")


def test_registration_refuses_a_different_rp_origin():
    client_data = json.dumps(
        {
            "type": "webauthn.create",
            "challenge": "AA",
            "origin": "https://vault.example",
        }
    ).encode()

    assert registration_rp_id(client_data, "vault.example") == "vault.example"
    with pytest.raises(VerificationFailed, match="different relying party"):
        registration_rp_id(client_data, "localhost")
