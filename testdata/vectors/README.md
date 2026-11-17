# Nedra cryptographic test vectors

Frozen known-answer vectors for every cryptographic construction a Nedra vault depends on. They exist so that any implementation (the Python backend today, a TypeScript, Rust or mobile core later) can prove it reads and writes the same vault format. All values are synthetic.

**Frozen means frozen.** A vector never changes within a supported format. This repository contains only vectors for the current format; incompatible releases replace the complete vector set together with the implementation.

The Python tests are in `backend/tests/test_vectors.py`; the frontend runs `totp.json` in `frontend/src/lib/totp.test.js`.

## Files

Every JSON file has `format` (`nedra-test-vectors/1`), `name` and `description`, then its vectors. Byte strings are lowercase hex (`*_hex`); keys and tokens are the ASCII strings as stored.

| File | Covers |
|---|---|
| `argon2id.json` | Argon2id with the default parameters, plus `api_input`: which characters the API strips from a master password before it reaches the KDF. The `key` values are base64url of the 32-byte output used by the current format |
| `vault-v3.json` | Vault format 3: key derivation, password commitment, wrapped vault key, derived keys, name index, sealed entries and attachments with their associated data, and sealed values that must be refused |
| `backup-v3.json` + `backup-v3.nedrabackup` | Backup format 3: a real file with fixed salt and nonces, its keys, header, envelope, entry frames and attachment frame |
| `totp.json` | RFC 6238 TOTP for stored secrets |

## The constructions

**Master password input.** The API strips leading and trailing Unicode `White_Space` (pydantic's `str_strip_whitespace`), then encodes UTF-8. No Unicode normalization: NFC and NFD forms of the same password are different passwords. Characters that are not `White_Space`, such as U+200B or U+001C, are kept even though Python's `str.strip()` would remove U+001C.

**Vault format 3 and backup format 3** are specified in [docs/VAULT_FORMAT.md](../../docs/VAULT_FORMAT.md); each JSON file's `description` repeats the construction it covers. In short: Argon2id (m=65536 KiB, t=3, p=4, 32 bytes) gives `derived`; HKDF-SHA256 with fixed labels gives the password commitment and the key-wrapping key; a random vault key is wrapped with AES-256-GCM; HKDF of the vault key gives the record key, the name-index key and the key check; records are `0x02 || nonce || AES-256-GCM(...)` with length-prefixed associated data naming the role and the record ids; the name index is HMAC-SHA256 of the UTF-8 name.

**TOTP.** RFC 6238 with HMAC-SHA1. Secrets are stored upper-case, unpadded base32 with no spaces; pad to a multiple of 8 before decoding.

## Regenerating
