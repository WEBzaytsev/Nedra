import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import en from "../../../frontend/src/i18n/en.js";
import ru from "../../../frontend/src/i18n/ru.js";
import { startFrontend, stopFrontend } from "./frontend.mjs";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

let frontend;
let browser;
before(async () => {
  browser = await chromium.launch();
  frontend = await startFrontend("/api");
});
after(async () => {
  await browser?.close();
  stopFrontend(frontend);
});

// Entirely synthetic sessions and intercepted API calls; never open a real vault.
async function openPage(
  width,
  language,
  path,
  authenticated = true,
  initialized = true,
  role = "admin",
  policy = { inactivity_ms: 3600000, hidden_ms: 3600000 }
) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    bypassCSP: true,
  });
  const page = await context.newPage();
  if (policy.clock) await page.clock.install();
  const errors = [];
  const writes = [];
  const user = {
    id: 1,
    username: "synthetic-user",
    role,
    active: true,
    must_change_password: policy.required ?? false,
  };
  let releaseStatus;
  const statusReady = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const t = language === "ru" ? ru : en;
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(
    ({ authenticated, user, language, theme }) => {
      if (authenticated && !sessionStorage.getItem("synthetic-fixture-initialized")) {
        sessionStorage.setItem("ciphermothSession", "synthetic-password-fields-session");
        sessionStorage.setItem("ciphermothUser", JSON.stringify(user));
      }
      sessionStorage.setItem("synthetic-fixture-initialized", "true");
      localStorage.setItem("ciphermoth-language", language);
      localStorage.setItem("ciphermoth-theme", theme);
    },
    { authenticated, user, language, theme: policy.theme ?? "dark" }
  );
  const data = {
    "/api/auth/status": { initialized },
    "/api/auth/me": user,
    "/api/auth/entry-draft-key": {
      user_id: user.id,
      key: Buffer.alloc(32, 7).toString("base64"),
    },
    "/api/meta": { version: "3.1.0", features: [] },
    "/api/users": [
      user,
      {
        id: 2,
        username: "synthetic-member",
        role: "member",
        active: true,
      },
    ],
    "/api/folders": [],
    "/api/groups": [],
    "/api/passwords": [
      {
        id: 1,
        password_name: "Synthetic entry",
        password_value: "synthetic-only",
        kind: "login",
        access: "owner",
        tags: [],
        custom_fields: [],
      },
    ],
    "/api/passwords/trash": [],
    "/api/vault/damaged": { entries: [], attachments: [] },
    "/api/settings": {
      update_check_enabled: false,
      inactivity_ms: policy.inactivity_ms,
      hidden_ms: policy.hidden_ms,
      warn_before_ms: 60000,
      debounce_ms: 1000,
      clipboard_clear_ms: 30000,
    },
    "/api/master_password/session": {
      idle_timeout_ms: policy.inactivity_ms,
      expires_in_ms: policy.remaining_ms ?? policy.inactivity_ms,
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/status" && policy.statusLoading) await statusReady;
    if (path === "/api/master_password/session") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data[path]),
      });
    }
    if (request.method() !== "GET") writes.push({ path, body: request.postDataJSON() });
    if (["/api/auth/login", "/api/auth/bootstrap"].includes(path)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          valid: true,
          session_token: "synthetic-login-session",
          user,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(request.method() === "GET" ? (data[path] ?? {}) : { id: 3 }),
    });
  });
  await page.goto(`${frontend.url}${path}`);
  return { context, page, t, errors, writes, releaseStatus };
}

for (const remaining of [900000, 30000]) {
  test(`initial server policy honors ${remaining}ms remaining without the bootstrap two-minute cap`, async () => {
    const { context, page, t, errors } = await openPage(
      375,
      "ru",
      "/passwords",
      true,
      true,
      "admin",
      {
        inactivity_ms: 900000,
        hidden_ms: 600000,
        remaining_ms: remaining,
        clock: true,
      }
    );
    try {
      await page.getByPlaceholder(t.vault.searchPlaceholder).waitFor();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.clock.fastForward(remaining - 1000);
      assert.equal(
        await page.evaluate(() => Boolean(sessionStorage.getItem("ciphermothSession"))),
        true
      );
      await page.clock.fastForward(2000);
      await page.waitForURL("**/login");
      assert.equal(await page.evaluate(() => sessionStorage.getItem("ciphermothSession")), null);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("hidden-tab policy honors ten minutes instead of the built-in one minute", async () => {
  const { context, page, t, errors } = await openPage(
    375,
    "ru",
    "/passwords",
    true,
    true,
    "admin",
    {
      inactivity_ms: 900000,
      hidden_ms: 600000,
      clock: true,
    }
  );
  try {
    await page.getByPlaceholder(t.vault.searchPlaceholder).waitFor();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    // Synthetic visibility transition, with real hook timers and browser clock.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(60001);
    assert.equal(
      await page.evaluate(() => Boolean(sessionStorage.getItem("ciphermothSession"))),
      true
    );
    await page.clock.fastForward(600001 - 60001);
    await page.waitForURL("**/login");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ciphermothSession")), null);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

function strong(password) {
  assert.equal(password.length, 16);
  for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/])
    assert.match(password, pattern);
}

const taskSurface = (page, options = {}) =>
  page
    .getByRole("dialog", options)
    .or(page.locator('[data-qa="task-page"]').and(page.getByRole("region", options)));

async function userCreate(page, width, t) {
  if (width < 576)
    await page.getByRole("button", { name: t.common.actions.add, exact: true }).click();
  return page.locator("form");
}

async function fits(page) {
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, window.scrollY));
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    outliers: [...document.querySelectorAll("body *")]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          className: typeof node.className === "string" ? node.className : "",
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      })
      .filter((item) => item.left < -1 || item.right > innerWidth + 1)
      .slice(-12),
    wide: [...document.querySelectorAll("body *")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({
        className: typeof node.className === "string" ? node.className : "",
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }))
      .slice(-12),
  }));
  assert.equal(geometry.scroll, geometry.width, JSON.stringify(geometry));
  const bad = await page
    .getByRole("button", {
      name: /^(Generate password|Сгенерировать пароль)$/,
    })
    .evaluateAll((buttons) =>
      buttons.flatMap((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44 || rect.left < 0 || rect.right > innerWidth
          ? [
              {
                width: rect.width,
                height: rect.height,
                left: rect.left,
                right: rect.right,
              },
            ]
          : [];
      })
    );
  assert.deepEqual(bad, [], "generator targets must fit and be at least 44px");
}

async function screenshot(page, name) {
  if (!process.env.CIPHERMOTH_SCREENSHOT_DIR) return;
  await mkdir(process.env.CIPHERMOTH_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(process.env.CIPHERMOTH_SCREENSHOT_DIR, name),
    fullPage: true,
  });
}

async function openMobileMenu(page, width, t) {
  if (width >= 1080) return;
  await page.getByRole("button", { name: t.navigation.more, exact: true }).click();
}

for (const [width, language] of [
  [320, "en"],
  [375, "ru"],
  [1440, "en"],
]) {
  test(`create/reset user password: opt-in generation and explicit submission at ${width}px`, async () => {
    const { context, page, t, errors, writes } = await openPage(width, language, "/users");
    try {
      const create = await userCreate(page, width, t);
      const password = create.getByLabel(t.users.temporaryPassword, {
        exact: false,
      });
      const generate = create.getByRole("button", {
        name: t.entry.actions.generatePassword,
        exact: true,
      });
      await generate.waitFor();
      await create.getByLabel(t.auth.username, { exact: false }).fill("synthetic-new");
      await generate.click();
      const first = await password.inputValue();
      strong(first);
      await generate.click();
      const generated = await password.inputValue();
      strong(generated);
      assert.notEqual(generated, first);
      assert.equal(await password.getAttribute("type"), "password");
      await create.locator('[data-qa="reveal-button"]').click();
      assert.equal(await password.getAttribute("type"), "text");
      assert.equal(await password.inputValue(), generated);
      assert.deepEqual(writes, [], "generation/show must not submit a form");
      await fits(page);
      // Do not include even synthetic generated passwords in screenshots.
      await create.locator('[data-qa="reveal-button"]').click();
      await screenshot(page, `users-password-generator-${width}-${language}.png`);
      let release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/api/users", async (route) => {
        if (route.request().method() === "POST") await pending;
        await route.fallback();
      });
      const request = page.waitForRequest(
        (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/users"
      );
      await (width < 576 ? page.locator('[data-qa="mobile-task-actions"]') : create)
        .getByRole("button", {
          name: t.common.actions.create,
          exact: true,
        })
        .click();
      assert.equal((await request).postDataJSON().temporary_password, generated);
      assert.equal(
        await generate.isDisabled(),
        true,
        "do not replace a password during submission"
      );
      release();
      await page.waitForFunction(
        () => document.querySelector('form input[autocomplete="new-password"]')?.value === ""
      );
      if (width < 576) await page.locator('[data-qa="task-back"]').click();

      await page
        .getByRole("button", {
          name: `${t.navigation.more}: synthetic-member`,
        })
        .click();
      await page
        .getByRole("menuitem", {
          name: t.users.resetPassword,
          exact: true,
        })
        .click();
      const reset = page.getByRole("dialog");
      await reset
        .getByRole("button", {
          name: t.entry.actions.generatePassword,
          exact: true,
        })
        .click();
      const resetPassword = await reset
        .getByLabel(t.users.temporaryPassword, { exact: false })
        .inputValue();
      strong(resetPassword);
      assert.equal(writes.length, 1);
      const resetRequest = page.waitForRequest(
        (r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/users/2/password"
      );
      await reset
        .getByRole("button", {
          name: t.users.resetPassword,
          exact: true,
        })
        .click();
      assert.equal((await resetRequest).postDataJSON().temporary_password, resetPassword);
      await reset.waitFor({ state: "hidden" });
      for (const toast of await page.locator('[data-toast="true"]').all()) {
        await toast.getByRole("button").click();
      }
      if (width < 576) await userCreate(page, width, t);
      await create.getByRole("combobox", { name: t.users.role, exact: true }).click();
      await page
        .getByRole("option", {
          name: t.users.roles.service,
          exact: true,
        })
        .click();
      assert.equal(
        await create
          .getByRole("button", {
            name: t.entry.actions.generatePassword,
            exact: true,
          })
          .count(),
        0
      );
      const servicePassword = create.getByLabel(t.auth.currentPassword, { exact: false });
      assert.equal(await servicePassword.count(), 1);
      assert.equal(await servicePassword.getAttribute("type"), "password");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test(`username validation identifies the field without losing the generated password at ${width}px`, async () => {
    const { context, page, t, errors } = await openPage(width, language, "/users");
    try {
      const create = await userCreate(page, width, t);
      await create.getByText(t.auth.usernameRules, { exact: true }).waitFor();
      const username = create.getByLabel(t.auth.username, {
        exact: false,
      });
      assert.equal(await username.getAttribute("autocapitalize"), "none");
      await username.fill("invalid user");
      await create
        .getByRole("button", {
          name: t.entry.actions.generatePassword,
          exact: true,
        })
        .click();
      const password = create.getByLabel(t.users.temporaryPassword, {
        exact: false,
      });
      const generated = await password.inputValue();
      await page.route("**/api/users", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            detail: [
              {
                type: "string_pattern_mismatch",
                loc: ["body", "username"],
                msg: "String should match pattern '^[a-z0-9][a-z0-9._@-]*$'",
              },
            ],
          }),
        });
      });
      await (width < 576 ? page.locator('[data-qa="mobile-task-actions"]') : create)
        .getByRole("button", {
          name: t.common.actions.create,
          exact: true,
        })
        .click();
      await page
        .getByText(`${t.auth.username}: ${t.auth.usernameRules}`, {
          exact: true,
        })
        .waitFor();
      assert.equal(await password.inputValue(), generated);
      assert.equal(await username.inputValue(), "invalid user");
      assert.equal(await password.getAttribute("type"), "password");
      await fits(page);
      await screenshot(page, `username-validation-${width}-${language}.png`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test(`password change generates only the new password at ${width}px`, async () => {
    const { context, page, t, errors, writes } = await openPage(width, language, "/users");
    try {
      await openMobileMenu(page, width, t);
      await page
        .getByRole("button", {
          name: t.auth.changePassword,
          exact: true,
        })
        .click();
      const dialog = taskSurface(page);
      const generate = dialog.getByRole("button", {
        name: t.entry.actions.generatePassword,
        exact: true,
      });
      await generate.waitFor();
      assert.equal(await generate.count(), 1);
      await generate.click();
      strong(await dialog.getByLabel(t.auth.newPassword, { exact: true }).inputValue());
      assert.equal(
        await dialog.getByLabel(t.auth.currentPassword, { exact: true }).inputValue(),
        ""
      );
      assert.equal(
        await dialog.getByLabel(t.auth.confirmNewPassword, { exact: true }).inputValue(),
        ""
      );
      await fits(page);
      await screenshot(page, `change-password-generator-${width}-${language}.png`);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  test(`bootstrap has generation, ordinary login does not at ${width}px`, async () => {
    for (const initialized of [false, true]) {
      const { context, page, t, errors, writes } = await openPage(
        width,
        language,
        "/login",
        false,
        initialized
      );
      try {
        const password = page
          .getByLabel(t.auth.masterPassword, { exact: false })
          .and(page.locator("input"))
          .first();
        await password.waitFor();
        const generate = page.getByRole("button", {
          name: t.entry.actions.generatePassword,
          exact: true,
        });
        assert.equal(await generate.count(), initialized ? 0 : 1);
        if (!initialized) {
          await generate.click();
          strong(await password.inputValue());
          assert.equal(
            await page
              .getByLabel(t.auth.confirmMasterPassword, {
                exact: false,
              })
              .inputValue(),
            ""
          );
          await fits(page);
        }
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });
}

test("existing vault generator stays singular; backup, restore and TOTP never generate", async () => {
  const { context, page, t, errors, writes } = await openPage(375, "ru", "/passwords");
  try {
    await page.locator('[data-qa="entry-list"]').getByRole("row").first().click();
    const detail = taskSurface(page, { name: "Synthetic entry" });
    await detail.getByRole("button", { name: t.common.actions.edit, exact: true }).click();
    const existingPassword = page.locator('input[autocomplete="new-password"]').last();
    await existingPassword.waitFor();
    const editForm = taskSurface(page).filter({ has: existingPassword });
    await editForm
      .getByRole("button", {
        name: t.entry.actions.generatePassword,
        exact: true,
      })
      .click();
    assert.equal(await existingPassword.inputValue(), "synthetic-only");
    await editForm
      .getByRole("button", {
        name: t.generator.regenerate,
        exact: true,
      })
      .click();
    strong(await existingPassword.inputValue());
    await editForm
      .getByRole("button", {
        name: t.generator.undoReplacement,
        exact: true,
      })
      .click();
    assert.equal(await existingPassword.inputValue(), "synthetic-only");
    await page
      .locator('[data-qa="mobile-task-actions"]')
      .getByRole("button", {
        name: t.common.actions.cancel,
        exact: true,
      })
      .click();
    await editForm.waitFor({ state: "hidden" });
    await page.locator('[data-qa="task-back"]').click();
    await detail.waitFor({ state: "hidden" });

    for (const [tool, label] of [
      ["backup", t.auth.masterPassword],
      ["import", t.importDialog.backupPassword],
    ]) {
      await page.getByRole("button", { name: t.navigation.more, exact: true }).click();
      await page.locator(`a[href="/passwords?tool=${tool}"]`).click();
      const field = page.getByRole("textbox", {
        name: label,
        exact: true,
      });
      await field.waitFor();
      const dialog = taskSurface(page).filter({ has: field });
      assert.equal(
        await dialog
          .getByRole("button", {
            name: t.entry.actions.generatePassword,
            exact: true,
          })
          .count(),
        0
      );
      await page
        .locator('[data-qa="mobile-task-actions"]')
        .getByRole("button", {
          name: t.common.actions.cancel,
          exact: true,
        })
        .click();
      await dialog.waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: t.common.actions.add, exact: true }).click();
    const editor = page.getByRole("region", {
      name: t.entry.title.addPassword,
    });
    const generate = editor.getByRole("button", {
      name: t.entry.actions.generatePassword,
      exact: true,
    });
    await generate.waitFor();
    assert.equal(await generate.count(), 1);
    await generate.click();
    await editor.getByRole("button", { name: t.generator.regenerate, exact: true }).click();
    strong(await editor.locator('input[autocomplete="new-password"]').inputValue());
    await editor
      .getByRole("button", {
        name: t.entry.labels.twoFactor,
        exact: false,
      })
      .click();
    const totp = editor.getByLabel(t.entry.labels.twoFactorSecret, {
      exact: false,
    });
    await totp.waitFor();
    assert.equal(await totp.inputValue(), "");
    assert.equal(
      await totp
        .locator("..")
        .getByRole("button", {
          name: t.entry.actions.generatePassword,
          exact: true,
        })
        .count(),
      0
    );
    await fits(page);
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const role of ["admin", "member"]) {
  test(`login restores deep-link query/hash only when ${role} has route access`, async () => {
    const requested = "/users?view=accounts#selected";
    const { context, page, t, errors, writes } = await openPage(
      375,
      "ru",
      requested,
      false,
      true,
      role
    );
    const userRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/users") userRequests.push(request.url());
    });
    try {
      await page.waitForURL(`${frontend.url}/login`);
      // React Router stores return intent in this history entry, including after refresh.
      await page.reload();
      await page.getByLabel(t.auth.username, { exact: false }).fill("synthetic-user");
      await page
        .getByLabel(t.auth.masterPassword, { exact: false })
        .and(page.locator("input"))
        .fill("synthetic-only");
      await page.getByRole("button", { name: t.auth.unlock, exact: true }).click();
      await page.waitForURL(`${frontend.url}${role === "admin" ? requested : "/passwords"}`);
      assert.ok(writes.some(({ path }) => path === "/api/auth/login"));
      if (role === "admin") {
        await page.getByRole("heading", { name: t.users.title, exact: true }).waitFor();
        const logo = page.locator('a[href="/passwords"]').first();
        const box = await logo.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44);
        await logo.focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(`${frontend.url}/passwords`);
      } else {
        await page.getByPlaceholder(t.vault.searchPlaceholder).waitFor();
        assert.deepEqual(userRequests, [], "a member must never mount the administrator page");
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const [width, authenticated] of [
  [375, true],
  [375, false],
  [1440, true],
]) {
  test(`theme toggle is reachable and touch-safe at ${width}px, auth=${authenticated}`, async () => {
    const { context, page, t, errors } = await openPage(
      width,
      "en",
      authenticated ? "/users" : "/login",
      authenticated
    );
    try {
      if (authenticated) await openMobileMenu(page, width, t);
      const protocol = await context.newCDPSession(page);
      await protocol.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 0, left: 0, bottom: 34, right: 20 },
      });
      const toggle = authenticated
        ? page
            .locator('[data-qa="navigation-preferences"]')
            .getByRole("button")
            .filter({ hasText: t.theme.label })
        : page.getByRole("button", {
            name: new RegExp(`${t.theme.switchToLight}$`),
          });
      await toggle.waitFor();
      const toggleHandle = await toggle.elementHandle();
      await toggle.scrollIntoViewIfNeeded();
      assert.ok(toggleHandle);
      await page.waitForFunction((button) => {
        const rect = button.getBoundingClientRect();
        return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      }, toggleHandle);
      const geometry = () =>
        toggle.evaluate((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return {
            position: style.position,
            bottom: parseFloat(style.bottom),
            right: parseFloat(style.right),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
          };
        });
      const before = await geometry();
      assert.ok(before.width >= 44 && before.height >= 44);
      assert.ok(before.x >= 0 && before.x + before.width <= before.viewportWidth);
      assert.ok(before.y >= 0 && before.y + before.height <= before.viewportHeight);
      await toggle.click();
      if (authenticated) {
        await page
          .getByRole("menuitemcheckbox", {
            name: t.theme.light,
            exact: true,
          })
          .click();
        await page
          .locator('[data-qa="navigation-preferences"]')
          .getByRole("button")
          .filter({ hasText: t.theme.light })
          .waitFor();
      } else {
        await page
          .getByRole("button", {
            name: new RegExp(`${t.theme.switchToDark}$`),
          })
          .waitFor();
      }
      assert.equal(await page.evaluate(() => localStorage.getItem("ciphermoth-theme")), "light");
      assert.match(
        await page.locator('meta[name="viewport"]').getAttribute("content"),
        /viewport-fit=cover/
      );
      await screenshot(page, `fixed-theme-${width}-${authenticated ? "vault" : "login"}.png`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const [width, language] of [
  [320, "en"],
  [375, "ru"],
  [1440, "en"],
]) {
  test(`service operation grants and token rotation retain secure dialog state at ${width}px`, async () => {
    const { context, page, t, errors } = await openPage(width, language, "/users");
    const service = {
      id: 3,
      username: "synthetic-service",
      role: "service",
      active: true,
      must_change_password: false,
      service_operations: ["list", "get"],
    };
    const users = [
      {
        id: 1,
        username: "synthetic-user",
        role: "admin",
        active: true,
        must_change_password: false,
      },
      service,
    ];
    const currentPassword = "Synthetic-current-password!2026";
    let operationWrites = 0;
    try {
      await page.route("**/api/users", (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(users) })
      );
      await page.route("**/api/users/3/service-operations", (route) => {
        assert.equal(route.request().method(), "PUT");
        const body = route.request().postDataJSON();
        assert.deepEqual(body.operations, ["list"]);
        assert.equal(body.current_password, currentPassword);
        operationWrites += 1;
        if (operationWrites === 1)
          return route.fulfill({
            status: 403,
            json: { detail: "Current password is incorrect." },
          });
        service.service_operations = body.operations;
        return route.fulfill({ json: service });
      });
      await page.route("**/api/users/3/service-token", (route) => {
        assert.equal(route.request().method(), "POST");
        assert.deepEqual(route.request().postDataJSON(), {
          current_password: currentPassword,
        });
        return route.fulfill({ json: { ...service, service_token: "Synthetic-rotated-token" } });
      });
      await page.reload();
      await page.getByText(service.username, { exact: true }).waitFor();

      const openConfig = async () => {
        await page
          .getByRole("button", { name: `${t.navigation.more}: ${service.username}` })
          .click();
        await page.getByRole("menuitem", { name: t.users.configureService, exact: true }).click();
        const dialog = page
          .getByRole("dialog")
          .filter({ has: page.getByText(t.users.serviceOperationsDescription, { exact: true }) });
        await dialog.waitFor();
        return dialog;
      };

      const operationControl = (surface, operation) =>
        surface
          .getByText(t.users.serviceOperations[operation], { exact: true })
          .locator("xpath=ancestor::label");

      let dialog = await openConfig();
      const getOperation = operationControl(dialog, "get");
      assert.equal(await getOperation.locator('input[type="checkbox"]').isChecked(), true);
      await getOperation.click();
      await dialog.getByLabel(t.auth.currentPassword, { exact: true }).fill(currentPassword);
      await dialog.getByRole("button", { name: t.common.actions.cancel, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(operationWrites, 0, "cancel must not issue a permission write");

      dialog = await openConfig();
      const reopenedGet = operationControl(dialog, "get");
      assert.equal(
        await reopenedGet.locator('input[type="checkbox"]').isChecked(),
        true,
        "cancel retains persisted grants"
      );
      const password = dialog.getByLabel(t.auth.currentPassword, { exact: true });
      assert.equal(await password.inputValue(), "", "cancel clears the confirmation password");
      await reopenedGet.click();
      await password.fill(currentPassword);
      await dialog.getByRole("button", { name: t.common.actions.save, exact: true }).click();
      await page.getByText("Current password is incorrect.", { exact: true }).waitFor();
      assert.equal(
        await reopenedGet.locator('input[type="checkbox"]').isChecked(),
        false,
        "rejection retains selected grants"
      );
      assert.equal(await password.inputValue(), currentPassword, "rejection permits retry");
      assert.equal(await password.getAttribute("type"), "password");
      assert.equal((await page.locator("body").textContent()).includes(currentPassword), false);

      await dialog.getByRole("button", { name: t.common.actions.save, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(operationWrites, 2);

      dialog = await openConfig();
      await dialog.getByLabel(t.auth.currentPassword, { exact: true }).fill(currentPassword);
      await dialog.getByRole("button", { name: t.users.rotateToken, exact: true }).click();
      await page.getByText(t.users.serviceTokenOnce, { exact: true }).waitFor();
      assert.equal((await page.locator("body").textContent()).includes(currentPassword), false);
      await fits(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

// Visual regression for the persistent labels and field-local error/focus fixes.
// Only intercepted API requests and synthetic credentials, never a real unlock.
if (process.env.CIPHERMOTH_LAYOUT_MATRIX) {
  for (const width of [320, 375, 768, 1440]) {
    for (const [language, theme] of [
      ["ru", "dark"],
      ["en", "light"],
    ]) {
      test(`auth matrix ${width} ${language} ${theme}`, async () => {
        const metrics = [];
        const capture = async (page, state) => {
          await page.evaluate(() => document.fonts.ready);
          await fits(page);
          await screenshot(page, `auth-${width}-${language}-${theme}-${state}.png`);
          await page.addScriptTag({ path: axePath });
          const violations = await page.evaluate(async () =>
            (
              await window.axe.run(document, {
                runOnly: {
                  type: "tag",
                  values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
                },
              })
            ).violations.map(({ id, nodes }) => ({
              id,
              targets: nodes.map((node) => node.target),
            }))
          );
          assert.deepEqual(violations, [], state);
          metrics.push({
            route: new URL(page.url()).pathname,
            state,
            width,
            language,
            theme,
          });
        };
        for (const initialized of [false, true]) {
          const fixture = await openPage(width, language, "/login", false, initialized, "admin", {
            theme,
            inactivity_ms: 3600000,
            hidden_ms: 3600000,
            statusLoading: true,
          });
          const { context, page, t, errors, releaseStatus } = fixture;
          const kind = initialized ? "login" : "bootstrap";
          const button = (name) => page.getByRole("button", { name, exact: true });
          try {
            await page.getByRole("status").waitFor();
            if (!initialized) await capture(page, "loading");
            releaseStatus();
            const username = page.locator('input[autocomplete="username"]');
            const password = page
              .locator(`input[autocomplete="${initialized ? "current-password" : "new-password"}"]`)
              .first();
            await username.waitFor();
            await capture(page, kind);
            if (!initialized) await page.getByRole("checkbox").check();
            const submit = button(initialized ? t.auth.unlock : t.auth.create);
            await submit.click();
            assert.equal(await username.getAttribute("aria-invalid"), "true");
            assert.equal(await username.evaluate((node) => document.activeElement === node), true);
            await capture(page, `${kind}-username-error`);
            await username.fill("synthetic-admin");
            await submit.click();
            await capture(page, `${kind}-password-error`);
            await password.fill("Synthetic-Only!Password-2026");
            if (!initialized) {
              await page
                .getByLabel(t.auth.confirmMasterPassword, {
                  exact: true,
                })
                .fill("Mismatch-only");
              await submit.click();
              await capture(page, "bootstrap-confirm-error");
              await page
                .getByLabel(t.auth.confirmMasterPassword, {
                  exact: true,
                })
                .fill("Synthetic-Only!Password-2026");
            }
            let release;
            const pending = new Promise((resolve) => {
              release = resolve;
            });
            await page.route(
              `**/api/auth/${initialized ? "login" : "bootstrap"}`,
              async (route) => {
                await pending;
                await route.fulfill({
                  status: 422,
                  json: {
                    detail: "Synthetic authentication rejected",
                  },
                });
              }
            );
            const request = page.waitForRequest((request) =>
              /\/auth\/(login|bootstrap)$/.test(new URL(request.url()).pathname)
            );
            await submit.click();
            await request;
            assert.equal(await submit.isDisabled(), true);
            await capture(page, `${kind}-busy`);
            release();
            await page
              .getByText("Synthetic authentication rejected", {
                exact: false,
              })
              .waitFor();
            await capture(page, `${kind}-server-error`);
            assert.deepEqual(errors, []);
          } finally {
            releaseStatus();
            await context.close();
          }
        }
        // The required-password modal has different navigation/dismissal rules.
        const { context, page, errors, t } = await openPage(
          width,
          language,
          "/passwords",
          true,
          true,
          "member",
          {
            theme,
            required: true,
            inactivity_ms: 3600000,
            hidden_ms: 3600000,
          }
        );
        try {
          const required = taskSurface(page, {
            name: t.auth.changeTemporaryPassword,
            exact: true,
          });
          await required.waitFor();
          await capture(page, "required-password-change");
          await page.keyboard.press("Escape");
          assert.equal(await required.count(), 1);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
        if (process.env.CIPHERMOTH_SCREENSHOT_DIR)
          await writeFile(
            resolve(
              process.env.CIPHERMOTH_SCREENSHOT_DIR,
              `auth-${width}-${language}-${theme}-metrics.json`
            ),
            JSON.stringify(metrics, null, 2)
          );
      });
    }
  }
}
