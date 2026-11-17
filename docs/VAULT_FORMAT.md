# Nedra vault format 3 and backup format 3

This is the specification of how Nedra stores a vault on disk (vault format 3, SQLite schema 10) and how it writes an encrypted portable backup (backup format 3 with payload version 3, `.nedrabackup`). It is written for reviewers and for anyone implementing a second reader. The desktop core runs this same Python code; cryptographic vectors remain in `testdata/vectors/vault-v3.json` and `backup-v3.json`.

The reference implementation is `backend/helpers.py` (primitives and associated data), `backend/crud/auth.py` (accounts, login and credential rewrapping), `backend/crud/access.py` (authorization), `backend/crud/password.py` and `backend/crud/attachment.py` (records), `backend/crud/backup.py` (backups) and `backend/storage.py` (file identity and exact-schema validation).


## 1. Threat model

**Protected against (the vault file, a snapshot, a backup or a copy of any of them in the wrong hands, without a valid account credential):**

- Reading any entry content: names, usernames, descriptions, passwords and note bodies, URLs, 2FA secrets, tags, folders, custom fields, password history, favorites, the login/note type, attachment names, types and bytes.
- Guessing a human password or service token faster than one Argon2id evaluation (64 MiB, 3 passes) per guess. There is no second, cheaper verifier.

**Detected (someone who can write the file but does not know a valid account credential):**

- Altering any ciphertext, nonce or tag: authenticated decryption fails, the request stops with "the vault file is damaged", nothing is shown or overwritten.
- Moving a ciphertext to another entry, attachment or role (an entry document into another row, attachment bytes onto another entry, an attachment's name into its content): every ciphertext is bound by its associated data to the random id of its own row (and an attachment also to its entry's id) and to its role.
- Changing an entry's name index so that a lookup lands on another entry: every read recomputes the index from the decrypted name and refuses a mismatch.
- Changing the stored KDF parameters, salt or format version: they are associated data of the wrapped vault key, and the password commitment depends on them.
- Planting a crafted wrapped key that decrypts under many candidate passwords (an AES-GCM "partitioning oracle"): unlock checks a password commitment before decrypting anything, so each unlock tests exactly one password.

**Not detected (documented limits):**

- **Rollback.** Replacing the whole file with an older copy, or one row with an older version of the same row, or one attachment with an older version of itself, looks valid. Detecting this needs a counter kept outside the file (the desktop app could keep one in the OS keychain later).
- **Deletion.** Removing rows (entries, attachments, history inside a rolled-back document) is not detected.
- Plaintext columns. The columns listed in section 4 are not authenticated: someone with write access can alter account names, roles, active state, ownership and grants; mark an entry as trashed or restore it; flip `backed_up`; change timestamps; or change the settings row.

**Out of scope, as before:** an attacker who can read the server process's memory or run code as its user, a malicious client that holds a valid session (it can do anything the user can), a compromised browser or renderer, keyloggers. Python cannot erase keys from memory. Old plaintext or old-key ciphertext left in free pages, a WAL file, SSD blocks, filesystem snapshots or backups made before a change is not reachable by Nedra (see section 7).

## 2. Primitives

All from `cryptography` (OpenSSL), nothing hand-written:

| Use | Primitive |
|---|---|
| Password to key | Argon2id, version 0x13, no secret, no associated data, 32-byte output |
| Key separation | HKDF-SHA256 (RFC 5869), no salt, one fixed `info` label per key |
| Encryption | AES-256-GCM, random 96-bit nonce, 128-bit tag |
| Name index | HMAC-SHA256 |
| Comparisons | `hmac.compare_digest` |
| Randomness | `os.urandom` |

Default KDF parameters (OWASP 2024 interactive profile): memory 65536 KiB, 3 iterations, 4 lanes, 16-byte random salt. The parameters are stored with the vault and with every backup, so they can be raised later without a format change. A reader accepts memory 19456 to 262144 KiB, 1 to 10 iterations and 1 to 8 lanes and refuses anything else before running the KDF, so a hostile file cannot make it allocate gigabytes.

**Credential input.** Leading and trailing Unicode `White_Space` is stripped from human passwords (the API's `str_strip_whitespace`), then UTF-8. No Unicode normalization. Service tokens are generated random URL-safe strings and are not accepted by the human login API.

**Nonce budget.** Random 96-bit nonces under one key are safe for 2^32 encryptions. One vault key encrypts one document per entry write and two values per attachment. A vault would need billions of writes to approach the bound.

## 3. Key hierarchy

```
account credential ──Argon2id(account salt, params)──▶ D (32 bytes, never stored)
   D ──HKDF "nedra/v3/password-commitment"──▶ password_check   (stored)
   D ──HKDF "nedra/v3/key-wrapping"────────▶ KEK               (never stored)

vault key VK (32 random bytes, never stored in clear)
   wrapped_key = 0x02 ‖ nonce ‖ AES-256-GCM(KEK, nonce, VK, AD_wrap)   (stored)
   VK ──HKDF "nedra/v3/record-encryption"──▶ K_rec   (entries and attachments)
   VK ──HKDF "nedra/v3/name-index"─────────▶ K_idx   (name index)
   VK ──HKDF "nedra/v3/key-check"──────────▶ key_check (stored)
```

`AD_wrap` = `"nedra/v3/wrapped-vault-key"` ‖ u16 format version ‖ u32 memory KiB ‖ u32 iterations ‖ u32 lanes ‖ salt (all integers big-endian).

**Create.** The first administrator chooses a username and password. Nedra creates random VK and account salt, derives D, and stores the administrator account wrapper plus the vault root material in one transaction. Every later human or service account receives its own salt, commitment and wrapper for the same VK. Until at least one account exists the vault is "not set up".

**Login.** Read the selected active human account and end the transaction, run Argon2id, compare `password_check` in constant time, decrypt `wrapped_key`, and compare `key_check`. Unknown usernames perform the same Argon2id path. The account and singleton vault are read again before a session is opened; concurrent disable, reset or token rotation wins. Service tokens use the same account material but authenticate only the MCP endpoint.

**Sessions.** The server keeps VK (with its derived keys) in memory behind an opaque token bound to one human account. Clients only hold that token. Every vault request rechecks that the account is active and that the session key matches the singleton vault. Password changes, resets, deactivation and explicit revocation remove affected sessions after commit.

**Password change or administrative reset:** verify the current account password when applicable, derive fresh account material, and rewrap the same VK. Entry ciphertext and name indexes do not change. Sessions for that account end after commit; other accounts continue to work. If the account owns the vault root material, that root wrapper is updated in the same transaction.

**Why a separate commitment and not only GCM?** AES-GCM is not key-committing: one ciphertext can be built to decrypt under many keys. Unlock compares `password_check` first, so whatever is planted in `wrapped_key`, each unlock tests one password. The commitment costs an attacker exactly what testing the wrapped key would: one Argon2id per guess.

## 4. SQLite layout (schema 10)

`PRAGMA application_id` = `0x4E454452` ("NEDR"), `PRAGMA user_version` = 10. The SQLite settings (WAL, `synchronous=FULL`, `secure_delete=ON`, `foreign_keys=ON`, ...) are listed in `backend/storage.py`.

**`vault`** (at most one row, `id = 1`): `owner_user_id`, format version 3, KDF parameters, salt, commitment, wrapped key and key check, with timestamps.

**`users`**: plaintext `username`, `role` (`admin`, `member` or `service`), active and required-password-change flags, optional `service_owner_id`, SHA-256 service-token digest, and `service_operations` bitmask. New services receive only `list` and `get`; an administrator explicitly authorizes every additional operation. Every MCP tool checks this mask and the entry/folder ACL. Per-account KDF parameters, salt, commitment, wrapped VK and key check are stored with timestamps. Human passwords and service tokens are never stored.

**`user_security_keys`**: each voluntarily enrolled user hardware factor stores its credential ID, public key, relying-party ID, PRF salt, factor-key wrapper, signature counter and timestamps. Credential material is scoped to that user; it is not part of a portable backup.

**`user_device_unlock_policies`** and **`user_device_unlocks`**: a user-owned password-confirmation interval and up to eight device-bound WebAuthn/PRF key wrappers, respectively. Device records carry public credential metadata, PRF salt, factor requirement, signature counter and timestamps. They are local account state, not portable-backup content.

**`user_native_device_unlocks`**: macOS Secure Enclave device records. Each row stores its user, random UID, display name, public material, wrapped vault key, optional factor requirement and timestamps. The private key stays in the Secure Enclave; this table is local account state and is excluded from portable backups.

**`entries`**: `id` (integer, autoincrement, never reused), `uid` (16 random bytes, unique), plaintext `owner_id`, optional plaintext `folder_id`, `name_index` (32 bytes), `document` (sealed entry document), `backed_up`, `created`, `updated`, `deleted`. A partial unique index on `name_index WHERE deleted IS NULL` keeps active names unique across the shared vault; trashed entries may share a name. `folder_id` is authoritative; the encrypted document's folder name is redundant display data protected with the rest of the document.

**`entry_access`**: plaintext composite key (`entry_id`, `user_id`), permission (`read` or `write`), optional expiry and `granted_by`, and creation time. Missing or expired row means denied. Owners do not need a grant row.

**`folders`**: stable random `uid`, plaintext `owner_id`, owner-scoped HMAC `name_index`, sealed name document, and timestamps. Folder names are not stored in clear. An entry cannot reference a deleted folder (`ON DELETE RESTRICT`).

**`groups`** and **`group_members`**: a group has a stable random `uid`, global scoped-HMAC `name_index`, sealed name document and timestamps. Membership is plaintext metadata managed by administrators.

**`folder_user_access`** and **`folder_group_access`**: direct user and group grants with `read`/`write`, optional expiry, grantor and creation time. Active entry, folder-user and folder-group grants are combined; the strongest permission wins (`write` over `read`). Administrator role alone is not a read grant.

**`access_audit`**: append-only application audit events for folder/group lifecycle, grants, revocations, membership and entry-folder changes. It contains actor/target/resource identifiers, permission and expiry transitions, and timestamps; it contains no secret values.

**`attachments`**: `id` (integer, autoincrement), `uid` (16 random bytes, unique), `entry_id` (foreign key, `ON DELETE CASCADE`), `size_bytes`, `meta` (sealed name and type), `content` (sealed bytes), `created`.

**`settings`**: the timing settings and the update-check switch, in clear.

**Sealed value** = `0x02` ‖ nonce (12) ‖ AES-256-GCM(K_rec, nonce, plaintext, AD) (ciphertext ‖ 16-byte tag).

**Associated data** = `0x02` ‖ `"nedra/v3"` ‖ for each part: u32 length ‖ bytes:

| Value | Parts |
|---|---|
| Entry document | `"entry"`, entry `uid` |
| Folder document | `"folder"`, folder `uid`, owner id as u64 |
| Group document | `"group"`, group `uid` |
| Attachment metadata | `"attachment-metadata"`, attachment `uid`, entry `uid` |
| Attachment content | `"attachment-content"`, attachment `uid`, entry `uid` |

**Entry document**: UTF-8 JSON object with exactly these keys, padded with trailing spaces to a multiple of 64 bytes before sealing (hides exact lengths):

```json
{"name": "...", "kind": "login|note", "username": null, "value": "...", "url": null,
 "totp_secret": null, "description": null, "tags": [], "custom_fields": [{"label": "", "value": "", "hidden": false}],
 "folder": null, "favorite": false, "history": [{"value": "...", "changed_at": "ISO-8601"}]}
```

A note keeps its body in `value`. Readers refuse unknown or missing keys and wrong types.

**Attachment metadata**: `{"filename": "...", "content_type": null}`, padded the same way. **Attachment content**: the raw bytes, not padded; a reader refuses content whose length differs from `size_bytes`.

**Name index** = HMAC-SHA256(K_idx, UTF-8 name), the exact name (no case folding or normalization, like the API). The API keeps addressing entries by name: a lookup computes the index and selects `name_index = ? AND deleted IS NULL`, then checks that the decrypted name is the requested one.

**Residual plaintext** (what the file still shows without an account credential):

- That it is a Nedra vault, its schema and format version, the KDF parameters and salt.
- The number of entries and attachments, which entries are in the trash, and which attachments belong to which entry.
- Usernames, roles, active/required-change flags, service ownership, entry/folder ownership, folder membership links, group membership, the grant graph and access-audit metadata. Folder and group names, service tokens and human passwords are not present.
- Row ids (creation order), `created`, `updated` and `deleted` timestamps, the `backed_up` flag.
- Which entries share a name (equal `name_index`), in practice an entry and its trashed copies; nothing else about names.
- Each entry document's length rounded up to 64 bytes, each attachment's exact size.
- The settings row (timeouts in milliseconds, update check on or off).
- Account and primary-wrapper update times, and how many users, entries, folders, groups and attachments were ever created, purged ones included (SQLite's id counters).
- Across two copies of the file (two snapshots, or a snapshot and the live vault): which entries changed, were renamed (their name index changed) or were trashed in between.

This is field-level encryption inside an ordinary SQLite file, not whole-file encryption: table names, the schema and the items above are visible to anyone who opens the file.

## 5. Backup format 3 (`.nedrabackup`), payload version 3

A backup is the portable, password-protected export of entries visible to the current human account: active and trashed entries with every field, stable folder identity, history, favorite and timestamps, attachments byte for byte, and the settings. Users, roles, ownership, groups, grants and audit events are deliberately not included: restoring a portable backup never recreates another installation's authorization graph. A raw `nedra-admin snapshot` preserves all installation state.

```
header (75 bytes)
  magic        8   "NEDRABKP"
  version      2   u16 = 3
  kdf          1   u8 = 1 (Argon2id v1.3)
  memory_kib   4   u32
  iterations   4   u32
  lanes        4   u32
  salt        16
  frames       4   u32, at least 1
  commitment  32   HKDF(B, "nedra/backup/v3/key-commitment")
frame × frames (nothing may follow the last one)
  length       4   u32, ciphertext length including the tag
  nonce       12
  ciphertext  length   AES-256-GCM(K_frame, nonce, plaintext, header ‖ u32 index ‖ u8 last)
```

`B` = Argon2id(password, salt, parameters), `K_frame` = HKDF(B, `"nedra/backup/v3/frame-encryption"`). The password is the current human account's password (verified before the backup is written); the salt is new for every backup. `last` is 1 for the final frame and 0 otherwise.

Frame 0 is a small UTF-8 JSON envelope (at most 64 MiB). Readers require payload version 3 with folder names inside this already encrypted backup payload:

```json
{"format": "nedra-backup", "version": 3, "exported_at": "ISO-8601", "app_version": "x.y.z", "entries_count": 2,
 "folders": [{"uid": "32 lowercase hex characters", "name": "Work"}],
 "settings": {"inactivity_ms": 120000, "warn_before_ms": 60000, "hidden_ms": 60000, "debounce_ms": 1000,
              "clipboard_clear_ms": 30000, "update_check_enabled": true}}
```

The next `entries_count` frames are entry documents (one JSON object each, at most 64 MiB). Each is followed immediately by the frames for its attachments (raw bytes, at most 5 MiB each), in the order listed in that entry:

```json
{"name": "...", "kind": "login", "username": null, "value": "...", "url": null, "totp_secret": null,
 "description": null, "tags": [], "custom_fields": [], "folder": "Work", "folder_uid": "32 lowercase hex characters", "favorite": false,
 "history": [], "created": "...", "updated": "...", "deleted": null,
 "attachments": [{"filename": "...", "content_type": null, "size": 1, "sha256": "hex", "created": "..."}]}
```

This layout keeps many-entry vaults from accumulating into one large JSON allocation. The maximum is 1,000,001 total frames (one envelope plus at most 1,000,000 entry and attachment frames) and 1 GiB for the complete `.nedrabackup` file. A vault entry's encoded document is limited to 64 MiB minus 32 KiB of framing/metadata allowance; each attachment's encoded metadata is limited to 2 KiB. Before each write commits, the vault checks `sum(length(entry document)) + 32 KiB per entry + sum(length(attachment metadata) + length(attachment content)) + 256 bytes per attachment + 4 KiB fixed overhead` against the 1 GiB cap, and enforces the frame-count limit. Supported operations therefore stop before the data can outgrow the complete-backup capacity. Restore rejects a frame over its limit before allocating it.

**Reading** (frame authentication is sequential; database writes are in one transaction and any later failure rolls them all back):

1. Parse the header; refuse a wrong magic or version, unknown KDF, parameters outside the accepted range, a frame count above the limit.
2. Run Argon2id, compare the commitment in constant time: a mismatch is "wrong password".
3. Decrypt frame 0 with its index and `last` flag; parse the envelope strictly. Then parse each entry frame strictly, checking types, timestamps, attachment counts and active-name uniqueness.
4. Validate every folder UID/name pair and every entry `folder_uid`, creating or reusing an encrypted folder owned by the importing account. An entry with a folder name but no matching stable folder identity is rejected.
5. For each entry, decrypt its attachment frames in order, check their length and SHA-256 against that entry's metadata, re-encrypt them under the vault key and store them. A frame that fails authentication, a missing frame (truncation), a frame after the last one or trailing bytes aborts the transaction: the vault is left exactly as it was.

Wrong password, tampering, truncation, reordering, a frame from another backup and a malformed envelope or entry all fail cleanly with nothing committed. Memory use is bounded by one entry frame and one attachment, plus bounded row identifiers and lookup indexes; the uploaded backup itself is ciphertext and may be spooled to a temporary file by the server.

**Restoring into a vault.** Entries are added with their timestamps and history; an active entry whose name already exists is skipped or, with "overwrite", the existing one is moved to the Trash (with its history and attachments) and the backup's version takes its place, so nothing is lost. CSV imports overwrite the same way. A trashed entry is skipped if the vault already has a trashed entry with the same name and deletion time (restoring one backup twice adds nothing). Settings are restored only into a vault that has no entries yet. Restored entries count as backed up.

## 6. Versioning

Three independent identifiers are accepted only at the exact Nedra 5 values:

- SQLite `application_id`: `0x4E454452`; `user_version`: schema 10.
- `vault.format_version`: cryptographic layout 3.
- Backup magic `NEDRABKP`, header version 3, encrypted payload version 3.

A file with another identity, schema or format is refused at startup before anything is written. So is a write-ahead log or rollback journal next to a missing or empty vault file. An empty file gets schema 10 in one transaction; until a master password is set, the vault is reported as not set up, and a vault is never created over entries that have no key record.

## 6a. Damaged rows

A value that fails authentication or its format check is never shown and never overwritten. Listings leave that entry or attachment out (and log its row id); `GET /api/vault/damaged` lists damaged rows visible to the account, and `DELETE /api/vault/damaged/{entries|attachments}/{id}` removes an owned row only after checking, under the write lock, that it really cannot be read. Backups refuse damaged visible rows rather than silently dropping them. Account password changes only rewrap VK and therefore do not read entry rows. Restoring a snapshot from before the damage is the alternative that keeps everything.

## 7. What changes do not erase

A password change replaces that account's wrapper in the live file, and SQLite's `secure_delete` overwrites freed pages, but copies made earlier keep the old wrapper. Anyone who has such a copy and the old password can still unwrap its VK. Portable backups keep the password used when they were created.

## 8. Incompatible input

The runtime contains no decoder or fallback for another application id, schema, cryptographic format, backup header, backup payload, browser storage name, extension identity, or native-host protocol. A one-time offline operator conversion may rewrite an authorized snapshot into these exact Nedra 5 contracts; that converter is not part of the runtime and rollback always restores the untouched source snapshot together with its exact source runtime.
