# Security

This is a password manager. Security isn't a feature here - it's the whole point. If you find something wrong, please don't open a public issue about it. Tell me privately first.

## Found something? Tell me here

Open a [GitHub Security Advisory](https://github.com/WEBzaytsev/Nedra/security/advisories/new) - it's private by default. Describe what you found, how to reproduce it, and what you think the impact is.

I'll acknowledge it within a few days. If it's real, I'll fix it and credit you in the release notes - unless you'd rather stay anonymous, which is also fine.

## What I actually care about

Things I want to know about:

- Anything that lets someone read passwords they shouldn't be able to
- Authentication or session bypass
- Encryption weaknesses or key leakage
- SQL injection, command injection, that whole family
- Anything that could expose the vault to an unauthorized party

Things that are out of scope:

- Attacks that require physical access to the machine running the instance - if someone has that, it's already over
- Vulnerabilities in third-party dependencies that don't directly affect Nedra - please report those upstream
- Self-XSS or anything only exploitable by someone already authenticated with their own master password

## What the Python core knows

So you can judge reports (and your own deployment) against what Nedra actually does:

- The master password itself is never stored. The vault key is random and stored only wrapped (AES-256-GCM) under a key derived from the master password with Argon2id. The vault also stores a password commitment derived the same way, which lets the server reject a wrong password; like the wrapped key, it can be used to test guesses offline, but only at the full cost of one Argon2id run per guess, so there is no second, cheaper verifier. The unwrapped key is never written to disk or logs. The format is specified in [docs/VAULT_FORMAT.md](docs/VAULT_FORMAT.md).
- When you unlock, the server keeps the keys derived from the vault key in its own memory and gives your browser (or the CLI) a random session token instead. Only a SHA-256 digest of the token is kept. Every request checks the session, then checks its key against a check value stored in the vault. Sessions end after the configured inactivity timeout (plus at most 5 seconds for request latency), after 12 hours at most, on logout, when the master password changes, and when the server restarts; nothing about them is written to disk or logs. The inactivity timeout is a vault setting, so anyone holding a session can raise it (to 60 minutes at most); the 12-hour limit cannot be changed. While you're using the vault, the server process sees your secrets in plaintext, and Python cannot reliably erase a key from memory after a session ends.
- Clients never receive the vault key and no route accepts it as a credential: a session token is the only way in. Unknown routes and headers have no compatibility behavior. The trusted server process still derives the key, holds it in memory for the session and decrypts entries while the vault is in use.
- If a stored value fails its integrity check, that entry or attachment is left out of every listing and reported (web UI banner, `nedra damaged`, `GET /api/vault/damaged`); backups and master password changes wait until it is removed or a snapshot is restored. Removing goes through `DELETE /api/vault/damaged/...`, which deletes a row only after checking that it really cannot be read.
- Everything in an entry is encrypted in the vault file with AES-256-GCM, names, usernames and descriptions included, and every encrypted value is bound to its own row and role, so moving one into another entry is detected. What remains readable is listed in [VAULT_FORMAT.md](docs/VAULT_FORMAT.md#4-sqlite-layout-schema-10): counts, trash membership, timestamps, sizes, which entries share a name, and the timeout settings. Someone who can write the file can still roll it (or a single entry) back to an older version, delete entries, or change those plaintext columns; that is not detected.
- Backups (`.nedrabackup`) use Nedra backup format 3 and are authenticated and encrypted with AES-256-GCM under Argon2id with their own salt and the account password current when they were made. Other headers and payload versions are refused.

## Where the web UI keeps its session, and why

The browser keeps the session token in `sessionStorage` and sends it in an `x-nedra-session` header. JavaScript running in the page can read it, so a cross-site scripting (XSS) bug could steal it. We considered an `HttpOnly`, `Secure`, `SameSite` cookie instead and decided against it for now:

- **It would not contain an XSS bug.** Injected script runs inside the unlocked UI, so it can call the API with the cookie and read every decrypted password directly. An `HttpOnly` cookie only stops it from copying the token for later use elsewhere, and a stolen token is already limited to the session's inactivity timeout and 12 hours.
- **It would break real deployments.** The UI and API are separate origins (ports 3000 and 8000 by default, often separate host names). Cookies across them need credentialed CORS. `Secure` cookies are dropped on the plain-`http` LAN addresses many people use. Browsers increasingly block cookies between unrelated sites.
- **It would add risks the header doesn't have.** Cookies are sent automatically, so every state-changing route would need cross-site request forgery (CSRF) protection; a custom header can't be sent cross-site without CORS approval. The CLI would still need the header, so there would be two authentication paths to keep correct.

What limits XSS instead:

- **A strict Content-Security-Policy.** No inline or remote scripts, no `eval`. Connections only to the UI's own origin, its API and GitHub's release address. Images only from the UI.
- **No HTML sinks.** The UI renders all text through React, and lint rules reject `innerHTML`, `dangerouslySetInnerHTML`, `eval` and similar sinks.
- **Little to steal.** The token is per tab, never in a URL, removed on logout and auto-lock, and useless after the session ends. API responses are `no-store`.

A policy cannot stop injected code from navigating the tab to another site with the token in the address, or from using WebRTC, and it ignores query strings on the allowed GitHub address; that is one more reason the UI accepts no HTML from anywhere.

Two session details worth knowing: closing a tab without logging out leaves its session open on the server until the inactivity timeout (a browser's "reopen closed tab" can restore it until then), and a duplicated tab shares the original's session, so logging out in one locks both.

## Encrypted new-entry drafts

The new-entry form keeps one encrypted draft per account in the tab's `sessionStorage`.
`GET /api/auth/entry-draft-key` requires a live account session and returns only a draft-specific
256-bit key, derived with HKDF-SHA256 from the vault key and the label
`nedra/browser-entry-draft/v1/{user_id}`. The key cannot decrypt vault entries or authenticate API calls.
The response is `no-store`; the UI keeps this draft key only in memory and never persists it.
Drafts use AES-256-GCM (`@noble/ciphers`) with a fresh 96-bit nonce for each write and the versioned
account storage name as authenticated data. Encryption and storage complete synchronously in the
input handler, before React renders the update; native locking never waits for renderer callbacks.
The same account can resume after unlocking; another account's key cannot decrypt the draft.
Creating the entry or cancelling removes it. Normal tab closure clears it, although browser session
recovery can retain `sessionStorage`. Clearing browser data, resetting the vault key, or losing the
tab can lose the draft. It is not a backup and does not preserve edits to existing entries. As with
decrypted entries, XSS in an unlocked page can read a draft; encryption protects its stored copy,
not a compromised client. Nonces use the platform CSPRNG (`crypto.getRandomValues`).

## Updates and the supply chain

Release images (`nedra-backend`, `nedra-frontend`) are signed with [cosign](https://github.com/sigstore/cosign) - keyless, via GitHub OIDC - so each image's digest is provably built by Nedra's own release workflow. Verify them before you start a new version; the command is in [docs/UPDATING.md](docs/UPDATING.md).

Desktop updates use the official Tauri 2 updater, a fixed HTTPS GitHub Releases endpoint and an embedded public verification key. The private key is restricted to trusted release jobs. Artifact signatures bind the version and native platform filename; modified, unsigned, mismatched and older artifacts are refused before installation. The renderer cannot choose a key, endpoint, source URL or installer arguments. The user confirms installation; Rust clears the session and stops the Python core before replacing application files. Linux `.deb` installations use manual package updates. These signatures are separate from OS publisher signing: there is no Apple notarization or Windows Authenticode certificate.

The desktop has no backend network listener. Python owns keys and sessions, communicating over private framed pipes; React holds only an opaque token in memory. Its CSP permits native IPC, not arbitrary network requests. The optional Rust update check sends no vault information. The Docker edition checks GitHub from the browser and updates manually; the old Docker-socket updater is retired. See [update instructions](docs/UPDATING.md).

## The vault file and its snapshots

The vault is one SQLite file, `vault.db`, in the data folder (`/data` in the backend container), created with mode `0600` in a `0700` folder. It holds what this page describes as encrypted, plus the plaintext metadata listed above and the wrapped vault key. SQLite runs with `secure_delete` on, so deleted rows are overwritten in the file, but copies can survive in the write-ahead log (`vault.db-wal`) until its frames are reused, in filesystem snapshots, on SSDs (wear levelling) and in any backup of the volume. The WAL has a 16 MiB post-checkpoint retention target, not a hard size cap: active readers and large transactions can make it larger. After a master password change, old ciphertext can likewise remain there and in every earlier snapshot.

Snapshots (`nedra-admin snapshot`) are raw copies of the vault file, with the same protection and the same metadata exposure. They open only with the master password that was current when they were taken, so a snapshot also keeps working with the master password that protected it when it was created: delete snapshots and backups you no longer need after changing a master password you believe was exposed.

## One thing worth knowing

Nedra is built to run on a machine you trust and control - your home server, a VPS behind a firewall, a Raspberry Pi in your closet. It is not built to sit directly on the open internet without a reverse proxy, HTTPS, and some thought about who can reach it. If you're deploying it that way, the README has guidance. If something goes wrong because it was exposed without those precautions, that's a configuration problem, not a vulnerability.
