import asyncio
import os

import pytest

from helpers import (
    DecryptionFailed,
    DeviceUnlockSlot,
    create_key_material,
    unwrap_device_unlock_key,
    wrap_device_unlock_key,
)
from tests.support import auth, create_vault, db_execute, unlock


def _slot(*, requires_factor: bool = False) -> DeviceUnlockSlot:
    return DeviceUnlockSlot(
        user_id=9,
        uid=os.urandom(16),
        credential_id=b"device-credential",
        public_key=b"device-public-key",
        rp_id="localhost",
        prf_salt=os.urandom(32),
        requires_factor=requires_factor,
    )


@pytest.mark.anyio
async def test_device_unlock_wrap_is_bound_to_device_and_factor_policy_async():
    _, vault_key = await create_key_material("Moth-Test-Vault-2026!")
    device_secret = os.urandom(32)
    factor_key = os.urandom(32)
    slot = _slot(requires_factor=True)
    sealed = wrap_device_unlock_key(device_secret, vault_key, slot, factor_key)

    assert unwrap_device_unlock_key(device_secret, sealed, slot, factor_key).matches(
        vault_key.check
    )
    with pytest.raises(DecryptionFailed):
        unwrap_device_unlock_key(device_secret, sealed, slot)
    with pytest.raises(DecryptionFailed):
        unwrap_device_unlock_key(
            device_secret,
            sealed,
            DeviceUnlockSlot(
                slot.user_id,
                slot.uid,
                slot.credential_id,
                slot.public_key,
                slot.rp_id,
                slot.prf_salt,
                False,
            ),
            factor_key,
        )


@pytest.mark.anyio
async def test_device_unlock_status_is_per_user_and_requires_a_session(client):
    assert (await client.get("/security/device-unlock")).status_code == 401
    token = await create_vault(client)
    status = await client.get("/security/device-unlock", headers=auth(token))
    assert status.status_code == 200, status.text
    assert status.json() == {
        "enabled": False,
        "devices": [],
        "password_interval_days": 14,
    }


@pytest.mark.anyio
async def test_password_login_refreshes_device_unlock_reminder_after_responding(client):
    await create_vault(client)
    await db_execute(
        """
        INSERT INTO user_device_unlock_policies (user_id, last_password_at)
        VALUES (1, datetime('now', '-15 days'))
        """
    )

    logged_in = await client.post(
        "/auth/login", json={"username": "admin", "password": "Moth-Test-Vault-2026!"}
    )

    assert logged_in.status_code == 200, logged_in.text
    refreshed = 0
    for _ in range(50):
        [(refreshed,)] = await db_execute(
            "SELECT last_password_at > datetime('now', '-1 minute') "
            "FROM user_device_unlock_policies WHERE user_id = 1"
        )
        if refreshed:
            break
        await asyncio.sleep(0.01)
    assert refreshed == 1


@pytest.mark.anyio
async def test_revoking_a_device_unlock_ends_the_users_sessions(client):
    token = await create_vault(client)
    other = await unlock(client)
    [(device_id,)] = await db_execute(
        """
        INSERT INTO user_device_unlocks
            (user_id, uid, name, credential_id, public_key, rp_id, prf_salt,
             wrapped_key, requires_factor, sign_count)
        VALUES (1, randomblob(16), 'session device', randomblob(16), x'01',
                'localhost', randomblob(32), x'01', 0, 0)
        RETURNING id
        """
    )

    revoked = await client.delete(
        f"/security/device-unlock/{device_id}", headers=auth(token)
    )

    assert revoked.status_code == 200, revoked.text
    for session in (token, other):
        assert (await client.get("/auth/me", headers=auth(session))).status_code == 401
