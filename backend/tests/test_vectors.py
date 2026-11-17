import base64
import hashlib
import io
import json
import struct
from pathlib import Path

import httpx
import pytest
import pyzipper
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import helpers
from schemas import MasterPassword
from tests.support import auth, create_vault
from tests.tools import generate_vectors

VECTORS = Path(__file__).resolve().parents[2] / "testdata" / "vectors"


def load(name: str) -> dict:
    data = json.loads((VECTORS / name).read_text(encoding="utf-8"))
    # Frozen authenticated fixtures keep their original format identifier.
    assert data["format"] == "ciphermoth-test-vectors/1"
    return data


def _ids(vectors: list[dict]) -> list[str]:
    return [v.get("note") or v.get("source", "") for v in vectors]


def _note(vector: dict) -> str:
    return vector.get("note", "")


ARGON2 = load("argon2id.json")


@pytest.mark.parametrize("vector", ARGON2["vectors"], ids=_ids(ARGON2["vectors"]))
def test_argon2id_key_derivation(vector: dict) -> None:
    assert vector["password"].encode().hex() == vector["password_utf8_hex"]
    derived = helpers.argon2id(vector["password"], bytes.fromhex(vector["salt_hex"]))
    assert base64.urlsafe_b64encode(derived).decode() == vector["key"]


def test_argon2id_applies_no_unicode_normalization() -> None:
    keys = {v["note"].split(" ")[0]: v["key"] for v in ARGON2["vectors"]}
    assert keys["NFC"] != keys["NFD"]


@pytest.mark.parametrize("case", ARGON2["api_input"]["cases"])
def test_master_password_reaching_the_kdf(case: dict) -> None:
    submitted = MasterPassword.model_validate({"master_password": case["submitted"]})
    assert submitted.master_password == case["kdf_input"]


VAULT = load("vault-v2.json")


def _vault_material(vector: dict) -> helpers.KeyMaterial:
    return helpers.KeyMaterial(
        params=helpers.DEFAULT_KDF,
        salt=bytes.fromhex(vector["salt_hex"]),
        password_check=bytes.fromhex(vector["password_check_hex"]),
        wrapped_key=bytes.fromhex(vector["wrapped_key_hex"]),
        key_check=bytes.fromhex(vector["key_check_hex"]),
    )


@pytest.mark.parametrize("vector", VAULT["vaults"], ids=lambda v: v["password"])
def test_a_frozen_vault_key_record_unlocks(vector: dict) -> None:
    derived = helpers.argon2id(vector["password"], bytes.fromhex(vector["salt_hex"]))
    assert derived.hex() == vector["derived_hex"]
    key = helpers.open_key_material(derived, _vault_material(vector))
    assert key is not None
    assert key.check.hex() == vector["key_check_hex"]
    raw = bytes.fromhex(vector["vault_key_hex"])
    assert helpers.VaultKey(raw).check == key.check
    material = helpers.seal_key_material(
        derived, raw, helpers.DEFAULT_KDF, bytes.fromhex(vector["salt_hex"])
    )
    assert material.password_check.hex() == vector["password_check_hex"]
    assert material.key_check.hex() == vector["key_check_hex"]
    assert material.wrapped_key != bytes.fromhex(vector["wrapped_key_hex"])
    reopened = helpers.open_key_material(derived, material)
    assert reopened is not None and reopened.check == key.check


@pytest.mark.parametrize("wrong", VAULT["wrong_passwords"], ids=_note)
def test_a_wrong_password_never_opens_a_frozen_vault(wrong: dict) -> None:
    vector = VAULT["vaults"][wrong["vault"]]
    derived = helpers.argon2id(wrong["password"], bytes.fromhex(vector["salt_hex"]))
    assert helpers.open_key_material(derived, _vault_material(vector)) is None


def test_a_matching_commitment_with_a_damaged_wrapped_key_is_damage() -> None:
    vector = VAULT["vaults"][0]
    derived = bytes.fromhex(vector["derived_hex"])
    material = _vault_material(vector)
    wrapped = bytearray(material.wrapped_key)
    wrapped[-1] ^= 1
    for damaged in (
        helpers.KeyMaterial(
            material.params,
            material.salt,
            material.password_check,
            bytes(wrapped),
            material.key_check,
        ),
        helpers.KeyMaterial(
            helpers.KdfParams(65536, 4, 4),
            material.salt,
            material.password_check,
            material.wrapped_key,
            material.key_check,
        ),
        helpers.KeyMaterial(
            material.params,
            material.salt,
            material.password_check,
            material.wrapped_key,
            bytes(32),
        ),
    ):
        with pytest.raises(helpers.DecryptionFailed):
            helpers.open_key_material(derived, damaged)


def _frozen_key() -> helpers.VaultKey:
    return helpers.VaultKey(bytes.fromhex(VAULT["vaults"][0]["vault_key_hex"]))


@pytest.mark.parametrize("vector", VAULT["name_index"], ids=_note)
def test_name_index(vector: dict) -> None:
    assert _frozen_key().name_index(vector["name"]).hex() == vector["index_hex"]


def _open(key: helpers.VaultKey, sealed: bytes, parts: list[bytes]) -> bytes:
    role = parts[0]
    if role == b"entry":
        return key.open_entry(parts[1], sealed)
    if role == b"attachment-metadata":
        return key.open_attachment_metadata(parts[1], parts[2], sealed)
    assert role == b"attachment-content"
    return key.open_attachment_content(parts[1], parts[2], sealed)


@pytest.mark.parametrize("vector", VAULT["records"], ids=_note)
def test_frozen_records_open(vector: dict) -> None:
    parts = [bytes.fromhex(p) for p in vector["parts_hex"]]
    plaintext = _open(_frozen_key(), bytes.fromhex(vector["sealed_hex"]), parts)
    assert plaintext.hex() == vector["plaintext_hex"]


@pytest.mark.parametrize("vector", VAULT["rejected"], ids=_note)
def test_altered_or_moved_records_are_refused(vector: dict) -> None:
    parts = [bytes.fromhex(p) for p in vector["parts_hex"]]
    with pytest.raises(helpers.DecryptionFailed):
        _open(_frozen_key(), bytes.fromhex(vector["sealed_hex"]), parts)


def test_new_records_follow_the_specification() -> None:
    vector = VAULT["vaults"][0]
    key = _frozen_key()
    record_key = AESGCM(bytes.fromhex(vector["record_key_hex"]))
    uid, entry_uid = bytes(range(16)), bytes(range(16, 32))
    document = b'{"name": "x"}'
    sealed = key.seal_entry(uid, document)
    assert sealed[0] == 2 and len(sealed) == 1 + 12 + 64 + 16
    associated = b"\x02ciphermoth/v2" + b"".join(
        struct.pack(">I", len(p)) + p for p in (b"entry", uid)
    )
    plain = record_key.decrypt(sealed[1:13], sealed[13:], associated)
    assert plain == document + b" " * (64 - len(document))
    content = bytes(range(256))
    sealed = key.seal_attachment_content(uid, entry_uid, content)
    assert len(sealed) == 1 + 12 + len(content) + 16
    assert key.seal_entry(uid, document) != key.seal_entry(uid, document)


TOTP = load("totp.json")


@pytest.mark.parametrize("vector", TOTP["vectors"])
def test_totp(vector: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(helpers.time, "time", lambda: float(vector["time"]))
    code = helpers.generate_totp(
        vector["secret"], digits=vector["digits"], period=vector["period"]
    )
    assert code == vector["code"]


BACKUP = load("backup_zip.json")


def test_frozen_backup_zip_opens_with_its_password() -> None:
    archive = (VECTORS / BACKUP["file"]).read_bytes()
    with pyzipper.AESZipFile(io.BytesIO(archive)) as zf:
        assert zf.namelist() == [BACKUP["member"]]
        zf.setpassword(BACKUP["password"].encode())
        assert json.loads(zf.read(BACKUP["member"])) == BACKUP["json"]
    with (
        pytest.raises(RuntimeError),
        pyzipper.AESZipFile(io.BytesIO(archive)) as zf,
    ):
        zf.setpassword(b"wrong password")
        zf.read(BACKUP["member"])


async def test_frozen_backup_zip_restores_into_a_new_vault(
    client: httpx.AsyncClient,
) -> None:
    key = await create_vault(client, BACKUP["password"])
    resp = await client.post(
        "/passwords/import",
        data={"master_password": BACKUP["password"]},
        files={"file": ("b.zip", (VECTORS / BACKUP["file"]).read_bytes(), "x/y")},
        headers=auth(key),
    )
    assert resp.status_code == 200, resp.text
    restored = {
        p["password_name"]: p
        for p in (await client.get("/passwords", headers=auth(key))).json()
    }
    for item in BACKUP["json"]["passwords"]:
        got = restored[item["name"]]
        assert got["password_value"] == item["value"]
        for field in ("kind", "username", "url", "totp_secret", "description"):
            assert got[field] == item[field]
        assert got["tags"] == item["tags"]
        assert got["custom_fields"] == item["custom_fields"]
        assert got["folder"] == item["folder"]
        assert got["favorite"] == item["favorite"]


def test_the_reference_construction_still_reproduces_the_frozen_files() -> None:
    documents, binaries = generate_vectors.outputs()
    for name, content in documents.items():
        if name == "backup_zip.json":
            continue
        assert json.loads(json.dumps(content, ensure_ascii=False)) == load(name)
    assert (
        binaries["backup-v2.cmbackup"] == (VECTORS / "backup-v2.cmbackup").read_bytes()
    )


BACKUP_V2 = load("backup-v2.json")


def test_the_frozen_backup_reads_with_the_frame_reader() -> None:
    from backup_format import BackupReader

    data = (VECTORS / BACKUP_V2["file"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == BACKUP_V2["file_sha256"]
    reader = BackupReader(io.BytesIO(data))
    key = helpers.BackupKey(bytes.fromhex(BACKUP_V2["derived_hex"]))
    assert key.matches(reader.header)
    assert json.loads(reader.read(key, 1 << 20)) == BACKUP_V2["manifest"]
    first, second = BACKUP_V2["entries"]
    assert json.loads(reader.read(key, 1 << 20)) == first
    assert reader.read(key, 1 << 20).hex() == BACKUP_V2["attachment_hex"]
    assert json.loads(reader.read(key, 1 << 20)) == second
    reader.finish()
    derived = helpers.argon2id(BACKUP_V2["password"], reader.header.salt)
    assert derived.hex() == BACKUP_V2["derived_hex"]


async def test_the_frozen_backup_restores_completely_into_a_new_vault(
    client: httpx.AsyncClient,
) -> None:
    token = await create_vault(client)
    resp = await client.post(
        "/passwords/import",
        data={"master_password": BACKUP_V2["password"]},
        files={
            "file": ("b.cmbackup", (VECTORS / BACKUP_V2["file"]).read_bytes(), "x/y")
        },
        headers=auth(token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 1
    assert resp.json()["trashed"] == 1
    assert resp.json()["attachments"] == 1
    assert resp.json()["settings_restored"] is True
    [active] = (await client.get("/passwords", headers=auth(token))).json()
    expected = BACKUP_V2["entries"][0]
    assert active["password_value"] == expected["value"]
    assert active["password_history"][0]["value"] == expected["history"][0]["value"]
    assert active["updated"] == expected["updated"].removesuffix("+00:00")
    [attachment] = (
        await client.get("/passwords/GitHub/attachments", headers=auth(token))
    ).json()
    download = await client.get(
        f"/passwords/GitHub/attachments/{attachment['id']}", headers=auth(token)
    )
    assert download.content.hex() == BACKUP_V2["attachment_hex"]
    [trashed] = (await client.get("/passwords/trash", headers=auth(token))).json()
    assert trashed["deleted"] == "2025-12-24T18:00:00.123456"
    settings = (await client.get("/settings", headers=auth(token))).json()
    assert settings == BACKUP_V2["manifest"]["settings"]
