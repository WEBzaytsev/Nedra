"""Scan only an isolated synthetic QA data tree for plaintext/key canaries."""

import base64
import sqlite3
import struct
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

root = Path(sys.argv[1]).resolve()
password = "Desktop-GUI-Canary-2026!"
with sqlite3.connect(f"file:{root / 'data/vault.db'}?mode=ro", uri=True) as db:
    memory, iterations, lanes, salt, wrapped = db.execute(
        "SELECT kdf_memory_kib,kdf_iterations,kdf_lanes,kdf_salt,wrapped_key FROM vault"
    ).fetchone()
derived = Argon2id(
    salt=salt, length=32, iterations=iterations, lanes=lanes, memory_cost=memory
).derive(password.encode())
kek = HKDF(
    algorithm=hashes.SHA256(), length=32, salt=None, info=b"ciphermoth/v2/key-wrapping"
).derive(derived)
key = AESGCM(kek).decrypt(
    wrapped[1:13],
    wrapped[13:],
    b"ciphermoth/v2/wrapped-vault-key"
    + struct.pack(">HIII", 2, memory, iterations, lanes)
    + salt,
)
canaries = [key, base64.urlsafe_b64encode(key)]
for text in [password, "Native-GUI-password-canary!", "Native GUI entry"]:
    canaries.extend([text.encode(), text.encode("utf-16-le")])
files = 0
for path in root.rglob("*"):
    if not path.is_file():
        continue
    data = path.read_bytes()
    assert not any(canary in data for canary in canaries), (
        f"Canary found in {path.relative_to(root)}"
    )
    files += 1
print(
    f"Scanned {files} isolated QA files: no password, entry-name, or raw-key canaries."
)
