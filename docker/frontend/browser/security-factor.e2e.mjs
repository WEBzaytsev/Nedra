import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const uv = process.env.UV ?? "uv";
const password = "Moth-Test-Vault-2026!";
const memberPassword = "Member-Test-Vault-2026!";

const port = async () =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });

const start = (command, args, options) => {
    const child = spawn(command, args, {
        detached: globalThis.process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk;
    });
    child.stderr.on("data", (chunk) => {
        output += chunk;
    });
    return { process: child, output: () => output };
};

const settleWithin = (promise, timeout = 5_000) =>
    Promise.race([
        Promise.resolve(promise).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, timeout)),
    ]);

const stop = async (child) => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
        if (globalThis.process.platform === "win32") child.kill("SIGTERM");
        else globalThis.process.kill(-child.pid, "SIGTERM");
    } catch {}
    if (await settleWithin(exited)) return;
    try {
        if (globalThis.process.platform === "win32") child.kill("SIGKILL");
        else globalThis.process.kill(-child.pid, "SIGKILL");
    } catch {}
    await settleWithin(exited);
    child.stdout.destroy();
    child.stderr.destroy();
};

const waitFor = async (url, child) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(url)).ok) return;
        } catch {}
        if (child.process.exitCode !== null) throw new Error(child.output());
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${url}: ${child.output()}`);
};

const b64 = (size = 32) => "A".repeat(Math.ceil((size * 4) / 3)).slice(0, 43);

const dataDir = await mkdtemp(join(tmpdir(), "ciphermoth-webauthn-e2e-"));
const apiPort = await port();
const frontendPort = await port();
const api = `http://127.0.0.1:${apiPort}/api`;
const frontend = `http://localhost:${frontendPort}`;
let backend;
let vite;
let browser;
let context;
let cdp;
try {
    backend = start(
        uv,
        [
            "run",
            "--project",
            join(root, "backend"),
            "python",
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            String(apiPort),
        ],
        {
            cwd: join(root, "backend"),
            env: {
                ...process.env,
                CIPHERMOTH_DATA_DIR: dataDir,
                CORS_ORIGINS: JSON.stringify([frontend]),
            },
        },
    );
    await waitFor(`${api}/health`, backend);
    vite = start(
        "npm",
        [
            "exec",
            "vite",
            "--",
            "--host",
            "127.0.0.1",
            "--port",
            String(frontendPort),
        ],
        {
            cwd: join(root, "frontend"),
            env: { ...process.env, VITE_API_URL: api },
        },
    );
    await waitFor(frontend, vite);

    const request = async (
        path,
        { method = "GET", body, token, headers = {} } = {},
    ) => {
        const response = await fetch(`${api}${path}`, {
            method,
            headers: {
                ...headers,
                ...(body ? { "content-type": "application/json" } : {}),
                ...(token ? { "x-ciphermoth-session": token } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            json = text;
        }
        return { status: response.status, json, text, bytes };
    };
    const ok = async (path, options) => {
        const response = await request(path, options);
        assert(
            response.status >= 200 && response.status < 300,
            `${path}: ${response.status} ${response.text}`,
        );
        return response.json;
    };

    const bootstrap = await ok("/auth/bootstrap", {
        method: "POST",
        body: { username: "owner", password },
    });
    const oldOwnerSession = bootstrap.session_token;
    const member = await ok("/users", {
        method: "POST",
        token: oldOwnerSession,
        body: {
            username: "member",
            role: "member",
            temporary_password: password,
        },
    });
    const service = await ok("/users", {
        method: "POST",
        token: oldOwnerSession,
        body: {
            username: "service",
            role: "service",
            current_password: password,
        },
    });
    const secondOwnerSession = (
        await ok("/auth/login", {
            method: "POST",
            body: { username: "owner", password },
        })
    ).session_token;

    browser = await chromium.launch();
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(frontend);
    cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const firstAuthenticator = await cdp.send(
        "WebAuthn.addVirtualAuthenticator",
        {
            options: {
                protocol: "ctap2",
                ctap2Version: "ctap2_1",
                transport: "internal",
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
                hasPrf: true,
            },
        },
    );
    const register = (options) =>
        page.evaluate(async (options) => {
            const { registerSecurityKey } =
                await import("/src/lib/securityKey.js");
            return registerSecurityKey(options);
        }, options);
    const assertWithKey = (options) =>
        page.evaluate(async (options) => {
            const { securityKeyAssertion } =
                await import("/src/lib/securityKey.js");
            return securityKeyAssertion(options);
        }, options);
    const stepUp = async (token, action, fields) => {
        const context = createHmac("sha256", token)
            .update(
                `nedra/security-step-up-context/v1\0${action}\0${JSON.stringify(fields)}`,
            )
            .digest("base64url");
        const options = await ok("/security/step-up/options", {
            method: "POST",
            token,
            body: { action, context },
        });
        assert.equal(options.required, true);
        return assertWithKey(options.challenge);
    };

    const registrationOptions = await ok("/security/keys/options", {
        method: "POST",
        token: secondOwnerSession,
    });
    const untrustedRp = await request("/security/keys/options", {
        method: "POST",
        token: secondOwnerSession,
        body: { current_password: password, rp_id: "vault.example" },
    });
    assert.equal(untrustedRp.status, 403);
    assert.match(untrustedRp.text, /WEBAUTHN_RP_IDS/);
    const crossOriginRp = await page.evaluate(async () => {
        try {
            await navigator.credentials.get({
                publicKey: {
                    challenge: crypto.getRandomValues(new Uint8Array(32)),
                    rpId: "vault.example",
                    timeout: 100,
                },
            });
            return "resolved";
        } catch (error) {
            return error.name;
        }
    });
    assert.notEqual(crossOriginRp, "resolved");
    assert(["SecurityError", "NotAllowedError"].includes(crossOriginRp));
    const ceremony = await register(registrationOptions);
    assert.equal(ceremony.assertion.prf_output.length, 43);
    const enrolled = await ok("/security/keys", {
        method: "POST",
        token: secondOwnerSession,
        body: {
            name: "virtual PRF key",
            current_password: password,
            registration_rp_id: registrationOptions.rp_id,
            ...ceremony,
        },
    });
    assert.equal(enrolled.enabled, true);
    assert.equal(enrolled.security_keys.length, 1);

    for (const stale of [oldOwnerSession, secondOwnerSession]) {
        assert.equal((await request("/auth/me", { token: stale })).status, 401);
    }
    assert.equal(
        (
            await request("/security/keys/options", {
                method: "POST",
                token: oldOwnerSession,
            })
        ).status,
        401,
    );

    const passwordOnly = await request("/auth/login", {
        method: "POST",
        body: { username: "owner", password },
    });
    assert.equal(passwordOnly.status, 200);
    assert.equal(passwordOnly.json.valid, false);
    assert.equal(passwordOnly.json.security_key_required, true);

    const cancelled = await page.evaluate(async (challenge) => {
        const abort = new AbortController();
        abort.abort();
        try {
            await navigator.credentials.get({
                publicKey: {
                    challenge: Uint8Array.from(
                        atob(
                            challenge
                                .replace(/-/g, "+")
                                .replace(/_/g, "/")
                                .padEnd(
                                    Math.ceil(challenge.length / 4) * 4,
                                    "=",
                                ),
                        ),
                        (part) => part.charCodeAt(0),
                    ),
                    rpId: location.hostname,
                    signal: abort.signal,
                },
            });
            return "resolved";
        } catch (error) {
            return error.name;
        }
    }, passwordOnly.json.security_key_challenge.challenge);
    assert(["AbortError", "NotAllowedError"].includes(cancelled), cancelled);

    const badPrf = {
        ...(await assertWithKey(passwordOnly.json.security_key_challenge)),
        prf_output: b64(),
    };
    const rejectedPrf = await request("/auth/login/security-key", {
        method: "POST",
        body: { username: "owner", password, assertion: badPrf },
    });
    assert.equal(rejectedPrf.status, 403);

    const factorLogin = await ok("/auth/login", {
        method: "POST",
        body: { username: "owner", password },
    });
    const ownerAssertion = await assertWithKey(
        factorLogin.security_key_challenge,
    );
    const directFactorSession = (
        await ok("/auth/login/security-key", {
            method: "POST",
            body: { username: "owner", password, assertion: ownerAssertion },
        })
    ).session_token;
    assert.equal(
        (await request("/auth/me", { token: directFactorSession })).status,
        200,
    );

    await page.reload();
    await page.getByLabel("Username", { exact: true }).fill("owner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page
        .getByRole("button", { name: "Unlock vault", exact: true })
        .click();
    await page.waitForURL("**/passwords");
    let factorSession = await page.evaluate(() =>
        sessionStorage.getItem("ciphermothSession"),
    );
    assert(
        factorSession,
        "the browser login must retain the factor-authenticated session",
    );
    assert.equal(
        (await request("/auth/me", { token: factorSession })).status,
        200,
    );

    assert.equal(
        (
            await request("/auth/password", {
                method: "PUT",
                token: factorSession,
                body: {
                    current_password: password,
                    new_password: "Changed-Password-2026!",
                },
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await request("/auth/recovery", {
                method: "POST",
                token: factorSession,
                body: { current_password: password },
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await request(`/users/${service.id}/service-operations`, {
                method: "PUT",
                token: factorSession,
                body: {
                    operations: ["list", "get", "create"],
                    current_password: password,
                },
            })
        ).status,
        403,
    );

    const recoveryAssertion = await stepUp(factorSession, "recovery-create", {
        current_password: password,
    });
    const ownerRecovery = await ok("/auth/recovery", {
        method: "POST",
        token: factorSession,
        body: {
            current_password: password,
            security_key_assertion: recoveryAssertion,
        },
    });
    assert(ownerRecovery.recovery_code);
    assert.equal(
        (
            await request("/auth/recovery", {
                method: "POST",
                token: factorSession,
                body: {
                    current_password: password,
                    security_key_assertion: recoveryAssertion,
                },
            })
        ).status,
        403,
    );

    const serviceAssertion = await stepUp(factorSession, "service-operations", {
        current_password: password,
        operations: ["list", "get", "create"],
        target_user_id: service.id,
    });
    await ok(`/users/${service.id}/service-operations`, {
        method: "PUT",
        token: factorSession,
        body: {
            operations: ["list", "get", "create"],
            current_password: password,
            security_key_assertion: serviceAssertion,
        },
    });

    const passwordAssertion = await stepUp(factorSession, "password-change", {
        current_password: password,
        new_password: "Changed-Password-2026!",
    });
    const changed = await ok("/auth/password", {
        method: "PUT",
        token: factorSession,
        body: {
            current_password: password,
            new_password: "Changed-Password-2026!",
            security_key_assertion: passwordAssertion,
        },
    });
    factorSession = changed.session_token;
    assert(factorSession);

    await ok("/passwords/create", {
        method: "POST",
        token: factorSession,
        body: { password_name: "shared", password_value: "secret" },
    });
    const created = (await ok("/passwords", { token: factorSession })).find(
        (entry) => entry.password_name === "shared",
    );
    assert(created, "owner can read the shared entry after factor login");
    await ok("/passwords/create", {
        method: "POST",
        token: factorSession,
        body: { password_name: "factor-backup", password_value: "restorable" },
    });
    const wrongBackupAssertion = await stepUp(factorSession, "backup", {
        master_password: "wrong password",
    });
    assert.equal(
        (
            await request("/passwords/backup", {
                method: "POST",
                token: factorSession,
                body: {
                    master_password: "Changed-Password-2026!",
                    security_key_assertion: wrongBackupAssertion,
                },
            })
        ).status,
        403,
    );
    const backupAssertion = await stepUp(factorSession, "backup", {
        master_password: "Changed-Password-2026!",
    });
    const factorBackup = await request("/passwords/backup", {
        method: "POST",
        token: factorSession,
        body: {
            master_password: "Changed-Password-2026!",
            security_key_assertion: backupAssertion,
        },
    });
    assert.equal(factorBackup.status, 200, factorBackup.text);
    assert.equal(
        new TextDecoder().decode(factorBackup.bytes.subarray(0, 8)),
        "CMBACKUP",
    );
    for (const path of [
        "/passwords/factor-backup",
        "/passwords/factor-backup/purge",
    ]) {
        await ok(path, {
            method: "DELETE",
            token: factorSession,
            body: undefined,
            headers: { "x-ciphermoth-entry": "factor-backup" },
        });
    }
    const restoreForm = new FormData();
    restoreForm.set("master_password", "Changed-Password-2026!");
    restoreForm.set("on_conflict", "skip");
    restoreForm.set("file", new Blob([factorBackup.bytes]), "factor.cmbackup");
    const restoredBackup = await fetch(`${api}/passwords/import`, {
        method: "POST",
        headers: { "x-ciphermoth-session": factorSession },
        body: restoreForm,
    });
    assert.equal(restoredBackup.status, 200, await restoredBackup.text());
    assert(
        (await ok("/passwords", { token: factorSession })).some(
            (entry) => entry.password_name === "factor-backup",
        ),
        "factor backup restore must restore its entry",
    );
    await ok(`/passwords/${created.id}/shares/${member.id}`, {
        method: "PUT",
        token: factorSession,
        body: { permission: "read" },
    });
    const memberLogin = await ok("/auth/login", {
        method: "POST",
        body: { username: "member", password },
    });
    assert.equal(memberLogin.user.must_change_password, true);
    const memberSession = (
        await ok("/auth/password", {
            method: "PUT",
            token: memberLogin.session_token,
            body: { current_password: password, new_password: memberPassword },
        })
    ).session_token;
    const visible = await ok("/passwords", { token: memberSession });
    assert.equal(visible.length, 1);
    assert.equal(visible[0].password_name, "shared");
    const recovery = await ok("/auth/recovery", {
        method: "POST",
        token: memberSession,
        body: { current_password: memberPassword },
    });
    await ok(`/users/${member.id}/password`, {
        method: "PUT",
        token: factorSession,
        body: { temporary_password: password },
    });
    assert.equal(
        (await request("/auth/me", { token: memberSession })).status,
        401,
    );
    const recovered = await ok("/auth/recover", {
        method: "POST",
        body: {
            username: "member",
            recovery_code: recovery.recovery_code,
            new_password: password,
        },
    });
    assert.equal(recovered.valid, false);

    const secondKeyAuthorization = await stepUp(
        factorSession,
        "security-key-add",
        {
            current_password: "Changed-Password-2026!",
            rp_id: registrationOptions.rp_id,
        },
    );
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
            protocol: "ctap2",
            ctap2Version: "ctap2_1",
            transport: "usb",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
            hasPrf: true,
        },
    });
    await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId: firstAuthenticator.authenticatorId,
    });
    const secondKeyOptions = await ok("/security/keys/options", {
        method: "POST",
        token: factorSession,
        body: {
            current_password: "Changed-Password-2026!",
            rp_id: registrationOptions.rp_id,
            security_key_assertion: secondKeyAuthorization,
        },
    });
    const secondKeyCeremony = await register(secondKeyOptions);
    const twoKeys = await ok("/security/keys", {
        method: "POST",
        token: factorSession,
        body: {
            name: "virtual PRF backup key",
            current_password: "Changed-Password-2026!",
            registration_rp_id: secondKeyOptions.rp_id,
            ...secondKeyCeremony,
        },
    });
    assert.equal(twoKeys.security_keys.length, 2);
    assert.equal(
        (await request("/auth/me", { token: factorSession })).status,
        401,
    );
    const secondFactorLogin = await ok("/auth/login", {
        method: "POST",
        body: { username: "owner", password: "Changed-Password-2026!" },
    });
    factorSession = (
        await ok("/auth/login/security-key", {
            method: "POST",
            body: {
                username: "owner",
                password: "Changed-Password-2026!",
                assertion: await assertWithKey(
                    secondFactorLogin.security_key_challenge,
                ),
            },
        })
    ).session_token;
    const deviceAuthorization = await stepUp(factorSession, "device-unlock-enroll", {
        current_password: "Changed-Password-2026!",
        rp_id: registrationOptions.rp_id,
    });
    const deviceOptions = await ok("/security/device-unlock/options", {
        method: "POST",
        token: factorSession,
        body: {
            current_password: "Changed-Password-2026!",
            rp_id: registrationOptions.rp_id,
            security_key_assertion: deviceAuthorization,
        },
    });
    const deviceCeremony = await register(deviceOptions);
    const enrolledDevice = await ok("/security/device-unlock", {
        method: "POST",
        token: factorSession,
        body: {
            name: "virtual device unlock",
            current_password: "Changed-Password-2026!",
            registration_rp_id: deviceOptions.rp_id,
            ...deviceCeremony,
        },
    });
    assert.equal(enrolledDevice.enabled, true);
    assert.equal(enrolledDevice.devices.length, 1);
    const deviceLoginOptions = await ok("/auth/login/device-unlock/options", {
        method: "POST",
        body: { username: "owner" },
    });
    assert.equal(deviceLoginOptions.password_required, false);
    assert(deviceLoginOptions.challenge);
    assert(deviceLoginOptions.security_key_challenge);
    const deviceWithoutFactor = await request("/auth/login/device-unlock", {
        method: "POST",
        body: {
            username: "owner",
            assertion: await assertWithKey(deviceLoginOptions.challenge),
        },
    });
    assert.equal(deviceWithoutFactor.status, 200);
    assert.equal(deviceWithoutFactor.json.valid, false);
    const deviceLoginWithFactor = await ok("/auth/login/device-unlock/options", {
        method: "POST",
        body: { username: "owner" },
    });
    const deviceSession = (
        await ok("/auth/login/device-unlock", {
            method: "POST",
            body: {
                username: "owner",
                assertion: await assertWithKey(deviceLoginWithFactor.challenge),
                security_key_assertion: await assertWithKey(
                    deviceLoginWithFactor.security_key_challenge,
                ),
            },
        })
    ).session_token;
    assert.equal((await request("/auth/me", { token: deviceSession })).status, 200);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${frontend}/login`);
    await page.getByLabel("Username", { exact: true }).fill("owner");
    await page
        .getByRole("button", { name: "Device unlock", exact: true })
        .click();
    await page.waitForURL("**/passwords");
    const browserDeviceSession = await page.evaluate(() =>
        sessionStorage.getItem("ciphermothSession"),
    );
    assert(browserDeviceSession, "the browser device login must retain a session");
    assert.equal(
        (await request("/auth/me", { token: browserDeviceSession })).status,
        200,
    );
    const revokedDevice = await ok(
        `/security/device-unlock/${enrolledDevice.devices[0].id}`,
        { method: "DELETE", token: factorSession },
    );
    assert.equal(revokedDevice.devices.length, 0);
    for (const session of [deviceSession, browserDeviceSession, factorSession]) {
        assert.equal((await request("/auth/me", { token: session })).status, 401);
    }
    const afterDeviceRevoke = await ok("/auth/login", {
        method: "POST",
        body: { username: "owner", password: "Changed-Password-2026!" },
    });
    factorSession = (
        await ok("/auth/login/security-key", {
            method: "POST",
            body: {
                username: "owner",
                password: "Changed-Password-2026!",
                assertion: await assertWithKey(
                    afterDeviceRevoke.security_key_challenge,
                ),
            },
        })
    ).session_token;
    const removedKey = twoKeys.security_keys[0];
    const removeAssertion = await stepUp(factorSession, "security-key-remove", {
        current_password: "Changed-Password-2026!",
        target_key_id: removedKey.id,
    });
    const oneKey = await ok(`/security/keys/${removedKey.id}`, {
        method: "DELETE",
        token: factorSession,
        body: {
            current_password: "Changed-Password-2026!",
            security_key_assertion: removeAssertion,
        },
    });
    assert.equal(oneKey.security_keys.length, 1);
    const lastFactorLogin = await ok("/auth/login", {
        method: "POST",
        body: { username: "owner", password: "Changed-Password-2026!" },
    });
    factorSession = (
        await ok("/auth/login/security-key", {
            method: "POST",
            body: {
                username: "owner",
                password: "Changed-Password-2026!",
                assertion: await assertWithKey(
                    lastFactorLogin.security_key_challenge,
                ),
            },
        })
    ).session_token;
    const lastKeyAssertion = await stepUp(
        factorSession,
        "security-key-remove",
        {
            current_password: "Changed-Password-2026!",
            target_key_id: oneKey.security_keys[0].id,
        },
    );
    assert.equal(
        (
            await request(`/security/keys/${oneKey.security_keys[0].id}`, {
                method: "DELETE",
                token: factorSession,
                body: {
                    current_password: "Changed-Password-2026!",
                    security_key_assertion: lastKeyAssertion,
                },
            })
        ).status,
        403,
    );

    const repeat = await request("/security/keys/options", {
        method: "POST",
        token: factorSession,
    });
    assert.equal(repeat.status, 403);
    const disableAssertion = await stepUp(
        factorSession,
        "security-factor-disable",
        {
            current_password: "Changed-Password-2026!",
        },
    );
    assert.equal(
        (
            await request("/security/keys", {
                method: "DELETE",
                token: factorSession,
                body: { current_password: "Changed-Password-2026!" },
            })
        ).status,
        403,
    );
    const disabled = await ok("/security/keys", {
        method: "DELETE",
        token: factorSession,
        body: {
            current_password: "Changed-Password-2026!",
            security_key_assertion: disableAssertion,
        },
    });
    assert.equal(disabled.enabled, false);
    const deviceAfterDisable = await ok("/auth/login/device-unlock/options", {
        method: "POST",
        body: { username: "owner" },
    });
    assert.equal(deviceAfterDisable.challenge, null);
    assert.equal(deviceAfterDisable.security_key_challenge, null);
    assert.equal(
        (await request("/auth/me", { token: factorSession })).status,
        401,
    );
    const passwordLoginAfterDisable = await ok("/auth/login", {
        method: "POST",
        body: { username: "owner", password: "Changed-Password-2026!" },
    });
    assert.equal(passwordLoginAfterDisable.valid, true);
    console.log(
        "real WebAuthn PRF E2E: frontend login, action-bound step-up, replay rejection, recovery, MCP management, password change, self-disable and session revocation passed",
    );
} finally {
    await Promise.all(
        [
            cdp?.detach(),
            context?.close(),
            browser?.close(),
            stop(vite?.process),
            stop(backend?.process),
            rm(dataDir, { recursive: true, force: true }),
        ].map((task) => settleWithin(task)),
    );
}
