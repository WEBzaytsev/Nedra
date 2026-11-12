"""
Every cryptographic construction of vault format 2 and backup format 2, in one
place so it can be reviewed as a whole. The specification is
docs/VAULT_FORMAT.md; the known-answer vectors are in testdata/vectors.

Primitives come from ``cryptography`` only: Argon2id, HKDF-SHA256,
AES-256-GCM and HMAC-SHA256.
"""

import asyncio
import base64
import hashlib
import hmac
import io
import os
import struct
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import pyzipper
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

FORMAT_VERSION = 2
KDF_NAME = "argon2id"
KEY_BYTES = 32
SALT_BYTES = 16
UID_BYTES = 16
NONCE_BYTES = 12
TAG_BYTES = 16
SEALED_OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES

_SEALED_VERSION = b"\x02"
_DOCUMENT_BLOCK = 64
_FORMAT_LABEL = b"ciphermoth/v2"
_WRAP_LABEL = b"ciphermoth/v2/wrapped-vault-key"
_PASSWORD_COMMITMENT = "ciphermoth/v2/password-commitment"
_KEY_WRAPPING = "ciphermoth/v2/key-wrapping"
_SECOND_FACTOR_WRAP_LABEL = b"ciphermoth/v2/wrapped-vault-key/second-factor"
_SECOND_FACTOR_COMMITMENT = "ciphermoth/v2/password-and-factor-commitment"
_SECOND_FACTOR_WRAPPING = "ciphermoth/v2/password-and-factor-key-wrapping"
_SECURITY_KEY_WRAPPING = "ciphermoth/v2/security-key-wrapping"
_DEVICE_UNLOCK_WRAPPING = "nedra/device-unlock/v1/key-wrapping"
_RECORD_ENCRYPTION = "ciphermoth/v2/record-encryption"
_NAME_INDEX = "ciphermoth/v2/name-index"
_KEY_CHECK = "ciphermoth/v2/key-check"
_BACKUP_COMMITMENT = "ciphermoth/backup/v2/key-commitment"
_BACKUP_FRAMES = "ciphermoth/backup/v2/frame-encryption"

_KDF_WORKERS = 2
_KDF_POOL = ThreadPoolExecutor(
    max_workers=_KDF_WORKERS, thread_name_prefix="ciphermoth-kdf"
)
_ARGON2_ALONE = threading.Lock()


class DecryptionFailed(Exception):
    """Authenticated decryption failed: the value was altered, moved to another
    record or role, truncated, or belongs to another key."""


class UnsupportedKdf(Exception):
    """KDF parameters outside the range this release accepts."""


@dataclass(frozen=True, slots=True)
class KdfParams:
    memory_kib: int = 65536
    iterations: int = 3
    lanes: int = 4

    MIN_MEMORY_KIB = 19456
    MAX_MEMORY_KIB = 262144
    MAX_ITERATIONS = 10
    MAX_LANES = 8

    def require_supported(self) -> None:
        """
        Refuse parameters before running the KDF, so a hostile vault or backup
        file cannot make the process allocate gigabytes or spin for minutes.
        """
        if not (
            all(
                type(value) is int
                for value in (self.memory_kib, self.iterations, self.lanes)
            )
            and self.MIN_MEMORY_KIB <= self.memory_kib <= self.MAX_MEMORY_KIB
            and 1 <= self.iterations <= self.MAX_ITERATIONS
            and 1 <= self.lanes <= self.MAX_LANES
            and self.memory_kib >= 8 * self.lanes
        ):
            raise UnsupportedKdf(
                "Unsupported key derivation parameters "
                f"(memory {self.memory_kib} KiB, {self.iterations} iterations, "
                f"{self.lanes} lanes)."
            )


DEFAULT_KDF = KdfParams()


def argon2id(password: str, salt: bytes, params: KdfParams = DEFAULT_KDF) -> bytes:
    params.require_supported()
    kdf = Argon2id(
        salt=salt,
        length=KEY_BYTES,
        iterations=params.iterations,
        lanes=params.lanes,
        memory_cost=params.memory_kib,
    )
    with _ARGON2_ALONE:
        return kdf.derive(password.encode())


async def _off_the_event_loop[T](function: Callable[..., T], *args: object) -> T:
    """
    Run a deliberately slow KDF in a small dedicated pool, so other requests
    keep being served while it runs. Argon2id derivations still run one at a
    time (``_ARGON2_ALONE``): two at once deadlocked inside OpenSSL on x86_64
    Linux, and one at a time also keeps their memory bounded however many
    unlocks arrive together.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_KDF_POOL, function, *args)


async def derive(password: str, salt: bytes, params: KdfParams = DEFAULT_KDF) -> bytes:
    return await _off_the_event_loop(argon2id, password, salt, params)


def _hkdf(key: bytes, label: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(), length=KEY_BYTES, salt=None, info=label.encode()
    ).derive(key)


def new_uid() -> bytes:
    return os.urandom(UID_BYTES)


def _associated_data(*parts: bytes) -> bytes:
    data = bytearray(_SEALED_VERSION + _FORMAT_LABEL)
    for part in parts:
        if not isinstance(part, bytes | bytearray | memoryview):
            raise DecryptionFailed
        part = bytes(part)
        data += struct.pack(">I", len(part)) + part
    return bytes(data)


def _seal(cipher: AESGCM, plaintext: bytes, associated_data: bytes) -> bytes:
    nonce = os.urandom(NONCE_BYTES)
    return _SEALED_VERSION + nonce + cipher.encrypt(nonce, plaintext, associated_data)


def _open(cipher: AESGCM, sealed: object, associated_data: bytes) -> bytes:
    if not isinstance(sealed, bytes | bytearray | memoryview):
        raise DecryptionFailed
    sealed = bytes(sealed)
    if len(sealed) < SEALED_OVERHEAD or sealed[:1] != _SEALED_VERSION:
        raise DecryptionFailed
    try:
        return cipher.decrypt(
            sealed[1 : 1 + NONCE_BYTES], sealed[1 + NONCE_BYTES :], associated_data
        )
    except InvalidTag:
        raise DecryptionFailed from None


def _padded(document: bytes) -> bytes:
    return document + b" " * (-len(document) % _DOCUMENT_BLOCK)


class VaultKey:
    """
    The keys derived from one vault key. The raw vault key remains private to
    this object so it can be wrapped for another explicitly provisioned account;
    callers can only encrypt, decrypt, index, wrap account material and prove
    which vault key it came from (``check``).
    """

    __slots__ = ("_raw", "_records", "_index", "check")

    def __init__(self, raw: bytes) -> None:
        if len(raw) != KEY_BYTES:
            raise ValueError("A vault key is 32 bytes.")
        self._raw = raw
        self._records = AESGCM(_hkdf(raw, _RECORD_ENCRYPTION))
        self._index = _hkdf(raw, _NAME_INDEX)
        self.check = _hkdf(raw, _KEY_CHECK)

    def __repr__(self) -> str:
        return "VaultKey(...)"

    def matches(self, key_check: bytes | None) -> bool:
        return isinstance(key_check, bytes) and hmac.compare_digest(
            self.check, key_check
        )

    def name_index(self, name: str) -> bytes:
        return hmac.new(self._index, name.encode(), hashlib.sha256).digest()

    def folder_name_index(self, owner_id: int, name: str) -> bytes:
        return hmac.new(
            self._index,
            f"folder\0{owner_id}\0{name}".encode(),
            hashlib.sha256,
        ).digest()

    def group_name_index(self, name: str) -> bytes:
        return hmac.new(self._index, f"group\0{name}".encode(), hashlib.sha256).digest()

    def entry_draft_key(self, user_id: int) -> bytes:
        """A browser-only draft key, separated from vault keys and other users."""
        return _hkdf(self._raw, f"ciphermoth/browser-entry-draft/v1/{user_id}")

    def seal_entry(self, uid: bytes, document: bytes) -> bytes:
        return _seal(self._records, _padded(document), _associated_data(b"entry", uid))

    def open_entry(self, uid: bytes, sealed: bytes) -> bytes:
        return _open(self._records, sealed, _associated_data(b"entry", uid))

    def seal_folder(self, uid: bytes, owner_id: int, document: bytes) -> bytes:
        return _seal(
            self._records,
            _padded(document),
            _associated_data(b"folder", uid, owner_id.to_bytes(8, "big")),
        )

    def open_folder(self, uid: bytes, owner_id: int, sealed: bytes) -> bytes:
        return _open(
            self._records,
            sealed,
            _associated_data(b"folder", uid, owner_id.to_bytes(8, "big")),
        )

    def seal_group(self, uid: bytes, document: bytes) -> bytes:
        return _seal(self._records, _padded(document), _associated_data(b"group", uid))

    def open_group(self, uid: bytes, sealed: bytes) -> bytes:
        return _open(self._records, sealed, _associated_data(b"group", uid))

    def seal_attachment_metadata(
        self, uid: bytes, entry_uid: bytes, document: bytes
    ) -> bytes:
        return _seal(
            self._records,
            _padded(document),
            _associated_data(b"attachment-metadata", uid, entry_uid),
        )

    def open_attachment_metadata(
        self, uid: bytes, entry_uid: bytes, sealed: bytes
    ) -> bytes:
        return _open(
            self._records,
            sealed,
            _associated_data(b"attachment-metadata", uid, entry_uid),
        )

    def seal_attachment_content(
        self, uid: bytes, entry_uid: bytes, content: bytes
    ) -> bytes:
        return _seal(
            self._records,
            content,
            _associated_data(b"attachment-content", uid, entry_uid),
        )

    def open_attachment_content(
        self, uid: bytes, entry_uid: bytes, sealed: bytes
    ) -> bytes:
        return _open(
            self._records,
            sealed,
            _associated_data(b"attachment-content", uid, entry_uid),
        )


@dataclass(frozen=True, slots=True)
class KeyMaterial:
    """What the vault row stores to turn a master password into the vault key."""

    params: KdfParams
    salt: bytes
    password_check: bytes
    wrapped_key: bytes = field(repr=False)
    key_check: bytes
    second_factor: bool = False


def _wrap_associated_data(
    params: KdfParams, salt: bytes, second_factor: bool = False
) -> bytes:
    return (
        (_SECOND_FACTOR_WRAP_LABEL if second_factor else _WRAP_LABEL)
        + struct.pack(
            ">HIII", FORMAT_VERSION, params.memory_kib, params.iterations, params.lanes
        )
        + salt
    )


def _password_keys(derived: bytes, factor_key: bytes | None) -> tuple[bytes, AESGCM]:
    if factor_key is None:
        return _hkdf(derived, _PASSWORD_COMMITMENT), AESGCM(
            _hkdf(derived, _KEY_WRAPPING)
        )
    if len(factor_key) != KEY_BYTES:
        raise DecryptionFailed
    combined = derived + factor_key
    return _hkdf(combined, _SECOND_FACTOR_COMMITMENT), AESGCM(
        _hkdf(combined, _SECOND_FACTOR_WRAPPING)
    )


def seal_key_material(
    derived: bytes,
    raw_key: bytes,
    params: KdfParams,
    salt: bytes,
    factor_key: bytes | None = None,
) -> KeyMaterial:
    second_factor = factor_key is not None
    commitment, cipher = _password_keys(derived, factor_key)
    wrapped = _seal(
        cipher,
        raw_key,
        _wrap_associated_data(params, salt, second_factor),
    )
    return KeyMaterial(
        params=params,
        salt=salt,
        password_check=commitment,
        wrapped_key=wrapped,
        key_check=VaultKey(raw_key).check,
        second_factor=second_factor,
    )


def open_key_material(
    derived: bytes, material: KeyMaterial, factor_key: bytes | None = None
) -> VaultKey | None:
    """
    The vault key, or None if ``derived`` comes from a wrong password. The
    password commitment is compared first, so a crafted wrapped key cannot
    turn one unlock into a test of many passwords (AES-GCM is not
    key-committing). A matching commitment with a wrapped key or key check
    that does not verify raises DecryptionFailed: the row is damaged.
    """
    if material.second_factor != (factor_key is not None):
        return None
    commitment, cipher = _password_keys(derived, factor_key)
    if not hmac.compare_digest(commitment, bytes(material.password_check)):
        return None
    raw = _open(
        cipher,
        material.wrapped_key,
        _wrap_associated_data(material.params, material.salt, material.second_factor),
    )
    if len(raw) != KEY_BYTES:
        raise DecryptionFailed
    key = VaultKey(raw)
    if not key.matches(material.key_check):
        raise DecryptionFailed
    return key


async def create_key_material(
    password: str, params: KdfParams = DEFAULT_KDF, factor_key: bytes | None = None
) -> tuple[KeyMaterial, VaultKey]:
    """A new random vault key and salt, wrapped under ``password``."""
    salt = os.urandom(SALT_BYTES)
    raw_key = os.urandom(KEY_BYTES)
    derived = await derive(password, salt, params)
    return seal_key_material(derived, raw_key, params, salt, factor_key), VaultKey(
        raw_key
    )


async def wrap_key_material(
    password: str,
    key: VaultKey,
    params: KdfParams = DEFAULT_KDF,
    factor_key: bytes | None = None,
) -> KeyMaterial:
    """Wrap an existing vault key for another account credential."""
    salt = os.urandom(SALT_BYTES)
    derived = await derive(password, salt, params)
    return seal_key_material(derived, key._raw, params, salt, factor_key)


async def unlock_key_material(
    password: str, material: KeyMaterial, factor_key: bytes | None = None
) -> VaultKey | None:
    derived = await derive(password, material.salt, material.params)
    return open_key_material(derived, material, factor_key)


@dataclass(frozen=True, slots=True)
class SecurityKeySlot:
    uid: bytes
    credential_id: bytes
    public_key: bytes
    rp_id: str
    prf_salt: bytes

    def associated_data(self) -> bytes:
        return _associated_data(
            b"security-key",
            self.uid,
            self.credential_id,
            self.public_key,
            self.rp_id.encode(),
            self.prf_salt,
        )


def new_factor_key() -> bytes:
    return os.urandom(KEY_BYTES)


def _security_key_cipher(prf_output: bytes) -> AESGCM:
    if len(prf_output) != KEY_BYTES:
        raise DecryptionFailed
    return AESGCM(_hkdf(prf_output, _SECURITY_KEY_WRAPPING))


def wrap_factor_key(
    prf_output: bytes, factor_key: bytes, slot: SecurityKeySlot
) -> bytes:
    return _seal(_security_key_cipher(prf_output), factor_key, slot.associated_data())


def unwrap_factor_key(
    prf_output: bytes, sealed: object, slot: SecurityKeySlot
) -> bytes:
    factor_key = _open(_security_key_cipher(prf_output), sealed, slot.associated_data())
    if len(factor_key) != KEY_BYTES:
        raise DecryptionFailed
    return factor_key


@dataclass(frozen=True, slots=True)
class DeviceUnlockSlot:
    user_id: int
    uid: bytes
    credential_id: bytes
    public_key: bytes
    rp_id: str
    prf_salt: bytes
    requires_factor: bool

    def associated_data(self) -> bytes:
        return _associated_data(
            b"device-unlock",
            self.user_id.to_bytes(8, "big"),
            self.uid,
            self.credential_id,
            self.public_key,
            self.rp_id.encode(),
            self.prf_salt,
            b"\x01" if self.requires_factor else b"\x00",
        )


def _device_unlock_cipher(device_secret: bytes, factor_key: bytes | None) -> AESGCM:
    if len(device_secret) != KEY_BYTES or (
        factor_key is not None and len(factor_key) != KEY_BYTES
    ):
        raise DecryptionFailed
    material = device_secret if factor_key is None else device_secret + factor_key
    return AESGCM(_hkdf(material, _DEVICE_UNLOCK_WRAPPING))


def wrap_device_unlock_key(
    device_secret: bytes,
    key: VaultKey,
    slot: DeviceUnlockSlot,
    factor_key: bytes | None = None,
) -> bytes:
    if slot.requires_factor != (factor_key is not None):
        raise DecryptionFailed
    return _seal(
        _device_unlock_cipher(device_secret, factor_key),
        key._raw,
        slot.associated_data(),
    )


def unwrap_device_unlock_key(
    device_secret: bytes,
    sealed: object,
    slot: DeviceUnlockSlot,
    factor_key: bytes | None = None,
) -> VaultKey:
    if slot.requires_factor != (factor_key is not None):
        raise DecryptionFailed
    raw = _open(
        _device_unlock_cipher(device_secret, factor_key), sealed, slot.associated_data()
    )
    if len(raw) != KEY_BYTES:
        raise DecryptionFailed
    return VaultKey(raw)


BACKUP_MAGIC = b"CMBACKUP"
BACKUP_VERSION = 2
BACKUP_KDF_ARGON2ID = 1
_BACKUP_HEADER = struct.Struct(">8sHBIII16sI32s")
BACKUP_HEADER_BYTES = _BACKUP_HEADER.size


class BackupFormatError(Exception):
    """A file that is not a backup this release can read."""


@dataclass(frozen=True, slots=True)
class BackupHeader:
    params: KdfParams
    salt: bytes
    frames: int
    commitment: bytes

    def pack(self) -> bytes:
        return _BACKUP_HEADER.pack(
            BACKUP_MAGIC,
            BACKUP_VERSION,
            BACKUP_KDF_ARGON2ID,
            self.params.memory_kib,
            self.params.iterations,
            self.params.lanes,
            self.salt,
            self.frames,
            self.commitment,
        )

    @classmethod
    def parse(cls, data: bytes) -> "BackupHeader":
        if len(data) != BACKUP_HEADER_BYTES:
            raise BackupFormatError("The file is too short to be a backup.")
        magic, version, kdf, memory, iterations, lanes, salt, frames, commitment = (
            _BACKUP_HEADER.unpack(data)
        )
        if magic != BACKUP_MAGIC:
            raise BackupFormatError("The file is not a CipherMoth backup.")
        if version != BACKUP_VERSION:
            raise BackupFormatError(
                f"The backup has version {version}; this release reads version "
                f"{BACKUP_VERSION}. Update CipherMoth."
            )
        if kdf != BACKUP_KDF_ARGON2ID:
            raise BackupFormatError("The backup uses an unknown key derivation.")
        params = KdfParams(memory, iterations, lanes)
        try:
            params.require_supported()
        except UnsupportedKdf as error:
            raise BackupFormatError(str(error)) from None
        if frames < 1:
            raise BackupFormatError("The backup has no content.")
        return cls(params, salt, frames, commitment)


class BackupKey:
    """The keys of one backup, derived from its password and its own salt."""

    __slots__ = ("_frames", "commitment")

    def __init__(self, derived: bytes) -> None:
        self._frames = AESGCM(_hkdf(derived, _BACKUP_FRAMES))
        self.commitment = _hkdf(derived, _BACKUP_COMMITMENT)

    def __repr__(self) -> str:
        return "BackupKey(...)"

    def matches(self, header: BackupHeader) -> bool:
        return hmac.compare_digest(self.commitment, header.commitment)

    @staticmethod
    def _frame_associated_data(header: bytes, index: int, last: bool) -> bytes:
        return header + struct.pack(">IB", index, 1 if last else 0)

    def seal_frame(
        self, header: bytes, index: int, last: bool, plaintext: bytes
    ) -> tuple[bytes, bytes]:
        nonce = os.urandom(NONCE_BYTES)
        return nonce, self._frames.encrypt(
            nonce, plaintext, self._frame_associated_data(header, index, last)
        )

    def open_frame(
        self, header: bytes, index: int, last: bool, nonce: bytes, ciphertext: bytes
    ) -> bytes:
        try:
            return self._frames.decrypt(
                nonce, ciphertext, self._frame_associated_data(header, index, last)
            )
        except InvalidTag:
            raise DecryptionFailed from None


async def new_backup_key(
    password: str, params: KdfParams = DEFAULT_KDF
) -> tuple[bytes, BackupKey]:
    salt = os.urandom(SALT_BYTES)
    return salt, BackupKey(await derive(password, salt, params))


async def backup_key_for(password: str, header: BackupHeader) -> BackupKey:
    return BackupKey(await derive(password, header.salt, header.params))


LEGACY_BACKUP_MEMBER = "ciphermoth_backup.json"


def read_legacy_backup(data: bytes, password: str, max_bytes: int) -> bytes:
    """
    The JSON of a backup ZIP written by CipherMoth 2.0.x or earlier (WinZip AES,
    PBKDF2-HMAC-SHA1 with 1000 iterations). Read-only: nothing writes this
    format any more. Raises DecryptionFailed for a wrong password or a damaged
    archive and BackupFormatError for anything else that is not such a backup.
    """
    try:
        with pyzipper.AESZipFile(io.BytesIO(data), "r") as archive:
            if LEGACY_BACKUP_MEMBER not in archive.namelist():
                raise BackupFormatError("The ZIP file is not a CipherMoth backup.")
            if not archive.getinfo(LEGACY_BACKUP_MEMBER).flag_bits & 0x1:
                raise BackupFormatError("The ZIP file is not encrypted.")
            archive.setpassword(password.encode())
            with archive.open(LEGACY_BACKUP_MEMBER) as member:
                content = member.read(max_bytes + 1)
    except BackupFormatError:
        raise
    except RuntimeError as error:
        raise DecryptionFailed from error
    except Exception as error:
        raise BackupFormatError("The ZIP file could not be read.") from error
    if len(content) > max_bytes:
        raise BackupFormatError("The backup content is too large.")
    return content


def generate_totp(
    secret: str, *, digits: int = 6, period: int = 30, now: int | None = None
) -> str:
    """
    Return the current TOTP code for a base32 secret (RFC 6238, HMAC-SHA1).

    Used by the CLI so `password get` can show the live code. The web UI has its
    own Web Crypto implementation; both stay small and dependency-free so the
    two-factor path is easy to audit.
    """
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    counter = (int(time.time()) if now is None else now) // period
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10**digits)).zfill(digits)
