import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startFrontend, stopFrontend } from "./frontend.mjs";
import { registerBottomActionChecks } from "./bottom-actions.mjs";
const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
import enText from "../../../frontend/src/i18n/en.js";
import ruText from "../../../frontend/src/i18n/ru.js";
// Synthetic records only. Exercise the shipped bundle without a real vault/session.
const entries = [
  {
    id: 1,
    created: "2026-01-01T12:00:00Z",
    updated: "2026-10-24T12:00:00Z",
    password_name: "GitHub",
    username: "nikita@example.test",
    password_value: "Synthetic-secret!2026",
    kind: "login",
    access: "owner",
    favorite: true,
    folder: "Work",
    folder_id: 1,
    tags: ["development"],
    url: "github.com",
    description: "Primary development login",
    totp_secret: "JBSWY3DPEHPK3PXP",
    custom_fields: [
      {
        label: "Recovery code",
        value: "Synthetic-recovery",
        hidden: true,
      },
    ],
    password_history: [],
    attachment_count: 0,
  },
  {
    id: 2,
    created: "2026-03-31T23:30:00Z",
    password_name: "Read-only account",
    username: "reader@example.test",
    password_value: "Synthetic-read-only",
    kind: "login",
    access: "read",
    favorite: false,
    folder: "Shared",
    folder_id: 2,
    attachment_count: 1,
    tags: [],
    custom_fields: [],
  },
  {
    id: 3,
    created: "2026-04-01T01:00:00+03:00",
    password_name: "Recovery notes",
    password_value: "Synthetic private note\nSecond line",
    kind: "note",
    access: "write",
    folder: "Personal",
    folder_id: 3,
    tags: [],
    custom_fields: [],
  },
  {
    id: 4,
    created: "2026-03-31T23:00:00Z",
    password_name: "Very long entry name / ".repeat(8),
    username: "long".repeat(40),
    password_value: "Long-secret-".repeat(40),
    kind: "login",
    access: "owner",
    favorite: false,
    folder: "Work",
    folder_id: 1,
    tags: ["long-tag".repeat(30)],
    custom_fields: [],
  },
];
let frontend;
let browser;
let origin;

before(async () => {
  browser = await chromium.launch();
  frontend = await startFrontend("/api");
  origin = frontend.url;
});
after(async () => {
  await browser?.close();
  stopFrontend(frontend);
});

async function vault(width, language = "en", theme = "dark", records = entries, options = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 812 : 900 },
    hasTouch: options.touch ?? false,
    bypassCSP: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  if (options.clock) await page.clock.install();
  const errors = [];
  const userFolderAccess = structuredClone(options.userFolderAccess ?? []);
  if (options.updateAvailable) {
    await page.route("https://api.github.com/**", (route) =>
      route.fulfill({
        json: {
          tag_name: "v3.2.0",
          html_url: "https://github.com/krolbot/ciphermoth/releases/tag/v3.2.0",
        },
      })
    );
  }
  const folderGrants = structuredClone(options.folderGrants ?? []);
  const folderAudit = structuredClone(options.folderAudit ?? []);
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(
    ({ language, theme, role }) => {
      if (!sessionStorage.getItem("synthetic-fixture-initialized")) {
        sessionStorage.setItem("synthetic-fixture-initialized", "true");
        sessionStorage.setItem("ciphermothSession", "synthetic-browser-session");
        sessionStorage.setItem(
          "ciphermothUser",
          JSON.stringify({ id: 1, username: "synthetic", role })
        );
      }
      localStorage.setItem("ciphermoth-language", language);
      localStorage.setItem("ciphermoth-theme", theme);
    },
    { language, theme, role: options.role ?? "member" }
  );
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const grantMatch = path.match(/^\/api\/folders\/(\d+)\/grants\/(users|groups)\/(\d+)$/);
    let data = {};
    if (path === "/api/vault/entries/trash" && method === "POST") {
      const body = request.postDataJSON();
      data = {
        count: body.entries.length,
        detail: "entries moved to trash",
        entries: body.entries.map((entry) => ({
          ...entry,
          deleted_at: "2026-11-11T12:00:00",
        })),
      };
    } else if (path === "/api/vault/entries/trash/undo" && method === "POST") {
      const body = request.postDataJSON();
      data = { count: body.entries.length, detail: "entries restored" };
    } else if (grantMatch && method === "PUT") {
      const [, folderIdText, targetTypePlural, targetIdText] = grantMatch;
      const folderId = Number(folderIdText);
      const targetId = Number(targetIdText);
      const targetType = targetTypePlural === "users" ? "user" : "group";
      const body = request.postDataJSON();
      const target =
        targetType === "user"
          ? (options.users ?? []).find((item) => item.id === targetId)
          : (options.groups ?? []).find((item) => item.id === targetId);
      const grant = {
        target_type: targetType,
        target_id: targetId,
        target_name: target?.username ?? target?.name ?? String(targetId),
        permission: body.permission,
        expires_at: body.expires_at,
        expired: false,
      };
      const grantIndex = folderGrants.findIndex(
        (item) => item.target_type === targetType && item.target_id === targetId
      );
      if (grantIndex === -1) folderGrants.push(grant);
      else folderGrants[grantIndex] = grant;
      if (targetType === "user") {
        const access = userFolderAccess.find((item) => item.folder.id === folderId);
        if (access) {
          access.direct_permission = body.permission;
          access.direct_expires_at = body.expires_at;
          access.effective_permission = body.permission;
          access.sources = [
            {
              source: "direct",
              source_id: targetId,
              name: target?.username ?? "",
              permission: body.permission,
              expires_at: body.expires_at,
              expired: false,
            },
          ];
        }
      }
      folderAudit.unshift({
        id: Math.max(0, ...folderAudit.map((item) => item.id)) + 1,
        created: "2026-10-27T12:01:00",
        actor_user_id: 1,
        actor_username: "synthetic",
        action: `folder_${targetType}_grant_created`,
        resource_type: "folder",
        resource_id: folderId,
        target_user_id: targetType === "user" ? targetId : null,
        target_username: targetType === "user" ? grant.target_name : null,
        target_group_id: targetType === "group" ? targetId : null,
        target_group_name: targetType === "group" ? grant.target_name : null,
      });
      data = grant;
    } else if (path === "/api/passwords") data = records;
    else if (path === "/api/users")
      data = options.users ?? [
        {
          id: 1,
          username: "synthetic",
          role: options.role ?? "member",
          active: true,
        },
      ];
    else if (/^\/api\/users\/\d+\/folder-access$/.test(path)) data = userFolderAccess;
    else if (path === "/api/folders")
      data = [
        {
          id: 1,
          name: "Work",
          owner_id: 1,
          owner_username: "synthetic",
          access: "owner",
          can_manage: true,
        },
        {
          id: 2,
          name: "Shared",
          owner_id: 2,
          owner_username: "owner",
          access: "read",
          can_manage: false,
        },
        {
          id: 3,
          name: "Personal",
          owner_id: 2,
          owner_username: "owner",
          access: "write",
          can_manage: false,
        },
      ];
    else if (path === "/api/groups") data = options.groups ?? [];
    else if (/^\/api\/groups\/\d+\/members$/.test(path)) data = options.groupMembers ?? [];
    else if (/^\/api\/groups\/\d+\/audit$/.test(path)) data = options.groupAudit ?? [];
    else if (/^\/api\/folders\/\d+\/grants$/.test(path)) data = folderGrants;
    else if (/^\/api\/folders\/\d+\/audit$/.test(path)) data = folderAudit;
    else if (path === "/api/passwords/trash")
      data = options.trash ?? [
        {
          id: 11,
          password_name: "Deleted / account",
          username: "old@example.test",
          deleted: "2026-10-20T12:00:00Z",
        },
      ];
    else if (path === "/api/vault/damaged") data = { entries: [], attachments: [] };
    else if (path === "/api/settings")
      data = {
        update_check_enabled: options.updateAvailable ?? false,
        inactivity_ms: options.clock ? 30000 : 3600000,
        hidden_ms: options.clock ? 10000 : 3600000,
        warn_before_ms: options.clock ? 5000 : 60000,
        debounce_ms: 1000,
        clipboard_clear_ms: 30000,
      };
    else if (path === "/api/master_password/session")
      data = {
        idle_timeout_ms: options.clock ? 30000 : 3600000,
        expires_in_ms: options.clock ? 30000 : 3600000,
      };
    else if (path === "/api/auth/status") data = { initialized: true };
    else if (path === "/api/auth/login")
      data = {
        valid: true,
        session_token: "synthetic-unlocked-session",
        user: {
          id: 1,
          username: "synthetic",
          role: "member",
          active: true,
        },
        idle_timeout_ms: 30000,
      };
    else if (path.endsWith("/attachments"))
      data = [{ id: 8, filename: "Readme.txt", size_bytes: 100 }];
    else if (path.endsWith("/shares")) data = options.shares ?? [];
    else if (path === "/api/users/share-targets") data = options.shareTargets ?? [];
    else if (path === "/api/auth/me")
      data = {
        id: 1,
        username: "synthetic",
        role: options.role ?? "member",
      };
    else if (path === "/api/auth/entry-draft-key")
      data = { user_id: 1, key: Buffer.alloc(32, 7).toString("base64") };
    else if (path === "/api/meta") data = { version: "3.1.0", features: [] };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  try {
    await page.goto(`${origin}/passwords`);
  } catch (error) {
    // Docker can briefly notify Chromium of a network change on first navigation.
    if (!error.message.includes("net::ERR_NETWORK_CHANGED")) throw error;
    await page.goto(`${origin}/passwords`);
  }
  await page.getByPlaceholder(language === "ru" ? "Поиск записей…" : "Search entries…").waitFor();
  await page.getByText("GitHub", { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
  return { context, page, errors };
}

async function fits(page) {
  await page.waitForTimeout(300);
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    outliers: [...document.querySelectorAll("body *")]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          className: typeof node.className === "string" ? node.className : "",
          parentClass:
            typeof node.parentElement?.className === "string" ? node.parentElement.className : "",
          parentHtml: node.parentElement?.outerHTML.slice(0, 180) ?? "",
          transform: getComputedStyle(node).transform,
          position: getComputedStyle(node).position,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      })
      .filter((item) => item.left < -1 || item.right > innerWidth + 1)
      .slice(-12),
  }));
  assert.equal(geometry.scroll, geometry.width, JSON.stringify(geometry));
  const overflowing = await page
    .locator('[role="dialog"], [role="list"], section')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => ({
          name: node.getAttribute("aria-label") || node.tagName,
          className: node.className,
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          children: [...node.children].map((child) => ({
            className: child.className,
            width: child.getBoundingClientRect().width,
            scrollWidth: child.scrollWidth,
          })),
        }))
    );
  assert.deepEqual(overflowing, []);
  const invalidActions = await page
    .locator('[data-qa="entry-list"]')
    .locator("button")
    .evaluateAll((buttons) =>
      buttons.flatMap((button) => {
        if (button.offsetParent === null) return [];
        const rect = button.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44 || rect.left < 0 || rect.right > innerWidth
          ? [
              {
                name: button.getAttribute("aria-label"),
                width: rect.width,
                height: rect.height,
              },
            ]
          : [];
      })
    );
  assert.deepEqual(invalidActions, [], "list actions stay touch-sized and within the viewport");
}

async function settleAnimations(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined))
    );
  });
}

function taskSurface(page, options = {}) {
  return page
    .getByRole("dialog", options)
    .or(page.locator('[data-qa="task-page"]').and(page.getByRole("region", options)));
}

function taskAction(page, surface, name) {
  // Phone task controls now live in the shell, not the scrolling region.
  const root =
    page.viewportSize().width < 576 ? page.locator('[data-qa="mobile-task-actions"]') : surface;
  return root.getByRole("button", { name, exact: true });
}

async function leaveSurface(page) {
  if (await page.getByRole("dialog").count()) {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  } else if (await page.locator('[data-qa="mobile-task-actions"] button').count()) {
    const dock = page.locator('[data-qa="mobile-task-actions"]');
    const cancel = dock.getByRole("button", {
      name: /^(Cancel|Отмена)$/,
      exact: true,
    });
    if (await cancel.count()) await cancel.click();
    else
      await dock
        .getByRole("button", {
          name: /^(Back|Назад|Close|Закрыть|Done|Готово)$/,
          exact: true,
        })
        .click();
    await page.waitForTimeout(100);
  } else if (await page.locator('[data-qa="task-back"]').count()) {
    await page.locator('[data-qa="task-back"]').click();
    await page.waitForTimeout(100);
  } else {
    await page.keyboard.press("Escape");
  }
}

async function axe(page) {
  await settleAnimations(page);
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () =>
    // Floating UI focus sentinels intentionally redirect Tab and are
    // aria-hidden. Audit product controls, not these library guards.
    (
      await window.axe.run(
        { exclude: [["[data-floating-ui-focus-guard]"]] },
        {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
          },
        }
      )
    ).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map(({ target, failureSummary, any }) => ({
        target,
        failureSummary,
        any,
      })),
    }))
  );
  assert.deepEqual(violations, []);
}

async function visibleTouchAction(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    box &&
      viewport &&
      box.y >= 0 &&
      box.y + box.height <= viewport.height &&
      box.width >= 40 &&
      box.height >= (viewport.width < 600 ? 44 : 36),
    JSON.stringify({ box, viewport })
  );
}

async function openAdd(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

function entryEditor(page, width) {
  return page.getByRole(width >= 1080 ? "dialog" : "region", {
    name: "Add entry",
  });
}

async function mobileToastFits(page, text, width) {
  if (width >= 600) return;
  await page.waitForFunction(
    ({ text, width }) => {
      const content = [...document.querySelectorAll(".g-toast")].find((node) =>
        node.textContent?.includes(text)
      );
      if (!content) return false;
      const box = content.getBoundingClientRect();
      return box.x >= 8 && box.right <= width - 8 && box.y >= 0 && box.bottom <= innerHeight;
    },
    { text, width }
  );
}

async function feedbackDoesNotCover(page, ...controls) {
  // No manual dismissal or auto-hide wait: feedback must coexist with actions.
  await page.locator('[data-qa="notification-shelf"] [data-toast="true"]').first().waitFor();
  await page.waitForTimeout(300); // UIKit replacement animation, not auto-hide.
  assert.equal(await page.locator('[data-qa="notification-shelf"] [data-toast="true"]').count(), 1);
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    assert.equal(
      await control.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const toastRects = [...document.querySelectorAll('[data-toast="true"]')]
          // A foreground confirmation hides feedback with its backdrop.
          // Its background rectangle is not a visible overlap.
          .filter((toast) => {
            const rect = toast.getBoundingClientRect();
            return toast.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            );
          })
          .map((toast) => toast.getBoundingClientRect());
        const points = [0.2, 0.5, 0.8].map((fraction) => ({
          x: box.x + box.width * fraction,
          y: box.y + box.height / 2,
        }));
        return (
          box.y >= 0 &&
          box.bottom <= innerHeight &&
          points.every(({ x, y }) => node.contains(document.elementFromPoint(x, y))) &&
          toastRects.every(
            (toast) =>
              box.right <= toast.x ||
              box.x >= toast.right ||
              box.bottom <= toast.y ||
              box.y >= toast.bottom
          )
        );
      }),
      true,
      `feedback must not cover ${(await control.getAttribute("aria-label")) ?? (await control.textContent())}`
    );
  }
  const geometry = await page.evaluate(() => {
    const pane = document.querySelector('[data-qa="page-scroll"]');
    const shelf = document.querySelector('[data-qa="notification-shelf"]');
    return {
      paneBottom: pane.getBoundingClientRect().bottom,
      shelfTop: shelf.getBoundingClientRect().top,
      bodyHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
    };
  });
  assert.ok(geometry.paneBottom <= geometry.shelfTop, JSON.stringify(geometry));
  assert.ok(
    geometry.bodyHeight <= geometry.viewportHeight,
    "phone has one content scroll owner, not body + pane"
  );
}

async function screenshot(page, filename) {
  if (!process.env.CIPHERMOTH_SCREENSHOT_DIR) return;
  await mkdir(process.env.CIPHERMOTH_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(process.env.CIPHERMOTH_SCREENSHOT_DIR, filename),
    fullPage: true,
  });
}

async function viewportScreenshot(page, filename) {
  if (!process.env.CIPHERMOTH_SCREENSHOT_DIR) return;
  await mkdir(process.env.CIPHERMOTH_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(process.env.CIPHERMOTH_SCREENSHOT_DIR, filename),
  });
}

for (const [width, reason] of [
  [375, "hidden"],
  [1440, "idle"],
  [1440, "renderer-reset"],
]) {
  test(`encrypted new-entry draft survives ${reason} locking and unlock at ${width}px`, async () => {
    const { context, page, errors } = await vault(width, "en", "dark", entries, { clock: true });
    let secret = "Synthetic-unsaved-secret-2026!";
    try {
      const mutations = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/passwords/create") mutations.push(request);
      });
      await openAdd(page, width);
      const editor = entryEditor(page, width);
      await editor.getByRole("textbox", { name: /^Name/ }).fill("Unsaved synthetic entry");
      await editor.getByRole("textbox", { name: /^Username/ }).fill("unsaved@example.test");
      await editor.locator('input[autocomplete="new-password"]').fill(secret);
      await fits(page);
      assert.deepEqual(mutations, [], "a draft must not create a real entry");
      if (reason === "hidden") {
        await page.evaluate(() => {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            get: () => true,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
      }
      if (reason === "renderer-reset") {
        secret = "Last-input-before-native-reset!";
        // Reproduce native navigation without endSession or a flush callback.
        // Inspect storage in the input task: waiting a tick hides the old race.
        await page.evaluate((value) => {
          const storageKey = "ciphermoth-entry-draft:v1:1";
          const before = sessionStorage.getItem(storageKey);
          const input = document.querySelector('input[autocomplete="new-password"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
            input,
            value
          );
          input.dispatchEvent(new Event("input", { bubbles: true }));
          if (sessionStorage.getItem(storageKey) === before)
            throw new Error("The last input was not persisted in the input task");
          sessionStorage.removeItem("ciphermothSession");
          sessionStorage.removeItem("ciphermothUser");
          window.location.replace("/login");
        }, secret);
      } else {
        await page.clock.fastForward(reason === "hidden" ? 10001 : 30001);
      }
      await page.getByRole("button", { name: "Unlock vault", exact: true }).waitFor();
      const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
      assert.match(stored, /ciphermoth-entry-draft:v1:1/);
      assert.ok(!stored.includes(secret) && !stored.includes("unsaved@example.test"));
      await page.getByRole("textbox", { name: "Username", exact: true }).fill("synthetic");
      await page.locator('input[autocomplete="current-password"]').fill("Synthetic-login-only!");
      await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
      if (width < 576) {
        const resume = page.getByRole("button", {
          name: "Continue editing",
          exact: true,
        });
        await editor.or(resume).waitFor();
        if (await resume.isVisible()) await resume.click();
      }
      await editor.waitFor();
      assert.equal(
        await editor.getByRole("textbox", { name: /^Name/ }).inputValue(),
        "Unsaved synthetic entry"
      );
      assert.equal(
        await editor.getByRole("textbox", { name: /^Username/ }).inputValue(),
        "unsaved@example.test"
      );
      assert.equal(await editor.locator('input[autocomplete="new-password"]').inputValue(), secret);
      assert.equal(
        await editor.locator('input[autocomplete="new-password"]').getAttribute("type"),
        "password"
      );
      assert.deepEqual(mutations, []);
      await screenshot(page, `draft-restored-${width}-${reason}.png`);
      await taskAction(page, editor, "Create").click();
      await editor.waitFor({ state: "hidden" });
      assert.equal(mutations.length, 1);
      assert.equal(mutations[0].postDataJSON().password_value, secret);
      assert.equal(
        await page.evaluate(() => sessionStorage.getItem("ciphermoth-entry-draft:v1:1")),
        null
      );
      await openAdd(page, width);
      assert.equal(await editor.getByRole("textbox", { name: /^Name/ }).inputValue(), "");
      await editor.getByRole("textbox", { name: /^Name/ }).fill("Cancel this draft");
      await taskAction(page, editor, "Cancel").click();
      assert.equal(
        await page.evaluate(() => sessionStorage.getItem("ciphermoth-entry-draft:v1:1")),
        null
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("a damaged draft is kept until explicit discard, and does not permanently block creation", async () => {
  const { context, page, errors } = await vault(375);
  try {
    await page.evaluate(() => sessionStorage.setItem("ciphermoth-entry-draft:v1:1", "damaged"));
    await page.reload();
    await page
      .getByText("Could not create or restore an encrypted draft.", {
        exact: false,
      })
      .waitFor();
    assert.equal(await page.getByRole("button", { name: "Add", exact: true }).isDisabled(), true);
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("ciphermoth-entry-draft:v1:1")),
      "damaged"
    );
    await fits(page);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("button", { name: "Discard draft", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("ciphermoth-entry-draft:v1:1")),
      "damaged"
    );
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await openAdd(page, 375);
    const editor = entryEditor(page, 375);
    await editor.waitFor();
    await taskAction(page, editor, "Cancel").click();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const width of [375, 1440]) {
  test(`new entry inherits the active folder and uses responsive editor at ${width}px`, async () => {
    const { context, page, errors } = await vault(width);
    try {
      const creates = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/passwords/create")
          creates.push(request.postDataJSON());
      });
      await page.getByRole("combobox", { name: /^Folder/ }).click();
      await page.getByRole("option", { name: /^Work/ }).click();
      await openAdd(page, width);

      const editor = entryEditor(page, width);
      await editor.waitFor();
      assert.equal(await page.getByRole("dialog").count(), width >= 1080 ? 1 : 0);
      const folder = editor.getByRole("combobox", {
        name: "Folder (optional)",
        exact: true,
      });
      assert.equal((await folder.textContent()).trim(), "Work");
      await folder.click();
      assert.deepEqual(await page.getByRole("option").allTextContents(), ["Work", "Personal"]);
      await page.keyboard.press("Escape");
      await screenshot(page, `entry-create-${width}.png`);

      const createButton = taskAction(page, editor, "Create");
      assert.equal(await createButton.isDisabled(), true);
      await editor.getByRole("textbox", { name: /^Name/ }).fill("Inherited folder entry");
      assert.equal(await createButton.isDisabled(), true);
      await editor.locator('input[autocomplete="new-password"]').fill("Synthetic-folder-secret");
      assert.equal(await createButton.isEnabled(), true);
      await createButton.click();
      await editor.waitFor({ state: "hidden" });
      assert.equal(creates.length, 1);
      assert.equal(creates[0].folder_id, 1);
      assert.equal(creates[0].folder, "Work");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const width of [375, 1440]) {
  test(`new entry does not inherit a read-only folder at ${width}px`, async () => {
    const { context, page, errors } = await vault(width);
    try {
      await page.getByRole("combobox", { name: /^Folder/ }).click();
      await page.getByRole("option", { name: /^Shared/ }).click();
      await openAdd(page, width);
      const editor = entryEditor(page, width);
      const folder = editor.getByRole("combobox", {
        name: "Folder (optional)",
        exact: true,
      });
      await folder.waitFor();
      assert.equal((await folder.textContent()).trim(), "Work, Personal");
      await folder.click();
      assert.deepEqual(await page.getByRole("option").allTextContents(), ["Work", "Personal"]);
      await page.keyboard.press("Escape");
      await taskAction(page, editor, "Cancel").click();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const width of [375, 1440]) {
  test(`administrator grants folder access from user management at ${width}px`, async () => {
    const folder = {
      id: 1,
      name: "Work",
      owner_id: 1,
      owner_username: "synthetic",
      access: null,
      can_manage: true,
    };
    const { context, page, errors } = await vault(width, "en", "dark", entries, {
      role: "admin",
      users: [
        {
          id: 1,
          username: "synthetic",
          role: "admin",
          active: true,
        },
        {
          id: 2,
          username: "team-member",
          role: "member",
          active: true,
        },
      ],
      userFolderAccess: [
        {
          folder,
          direct_permission: null,
          direct_expires_at: null,
          effective_permission: null,
          sources: [],
        },
      ],
      groups: [{ id: 10, name: "Operations", member_count: 1 }],
      groupMembers: [{ user_id: 2, username: "team-member", role: "member" }],
      groupAudit: [
        {
          id: 1,
          created: "2026-10-27T12:00:00",
          actor_user_id: 1,
          actor_username: "synthetic",
          action: "group_created",
          resource_type: "group",
          resource_id: 10,
          target_user_id: null,
          target_username: null,
        },
      ],
    });
    try {
      const grants = [];
      page.on("request", (request) => {
        if (
          request.method() === "PUT" &&
          new URL(request.url()).pathname === "/api/folders/1/grants/users/2"
        )
          grants.push(request.postDataJSON());
      });
      await page.goto(`${origin}/users`);
      await page.getByRole("heading", { name: "Accounts and service access" }).waitFor();
      await page.getByRole("button", { name: "Groups", exact: true }).click();
      const groupsDialog = taskSurface(page, {
        name: "Groups",
        exact: true,
      });
      await groupsDialog.waitFor();
      await groupsDialog.getByText("team-member", { exact: true }).waitFor();
      await groupsDialog.getByText("synthetic created the group.", { exact: true }).waitFor();
      assert.equal(
        await groupsDialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
        true
      );
      const groupsClose = taskAction(page, groupsDialog, "Close");
      await visibleTouchAction(page, groupsClose);
      await viewportScreenshot(page, `group-management-${width}.png`);
      await groupsClose.click();
      await groupsDialog.waitFor({ state: "hidden" });

      await page.getByRole("button", { name: "More: team-member", exact: true }).click();
      await page
        .getByRole("menuitem", {
          name: "Manage folders and access",
          exact: true,
        })
        .click();
      const dialog = taskSurface(page, {
        name: "Folder access for team-member",
        exact: true,
      });
      await dialog.waitFor();
      const noAccess = dialog.getByText("No access", { exact: true });
      await noAccess.waitFor();
      assert.equal(await noAccess.count(), 1);
      await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
      await page.getByText("Folder access saved.", { exact: true }).waitFor();
      await mobileToastFits(page, "Folder access saved.", width);
      assert.deepEqual(grants, [{ permission: "read", expires_at: null }]);
      await dialog.getByText("Direct grant: team-member (Read)", { exact: true }).waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      const close = taskAction(page, dialog, "Close");
      await visibleTouchAction(page, close);
      await viewportScreenshot(page, `user-folder-access-${width}.png`);

      await close.click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const width of [375, 1440]) {
  test(`folder owner grants group access and sees audit at ${width}px`, async () => {
    const { context, page, errors } = await vault(width, "en", "dark", entries, {
      groups: [{ id: 10, name: "Operations", member_count: 1 }],
      shareTargets: [{ id: 2, username: "team-member", role: "member" }],
      folderAudit: [
        {
          id: 1,
          created: "2026-10-27T12:00:00",
          actor_user_id: 1,
          actor_username: "synthetic",
          action: "folder_created",
          resource_type: "folder",
          resource_id: 1,
        },
      ],
    });
    try {
      const grants = [];
      page.on("request", (request) => {
        if (
          request.method() === "PUT" &&
          new URL(request.url()).pathname === "/api/folders/1/grants/groups/10"
        )
          grants.push(request.postDataJSON());
      });
      const mobileNavigation = await page.locator('[data-qa="mobile-header"]').count();
      if (mobileNavigation) {
        await page.getByRole("button", { name: "More", exact: true }).click();
      }
      await page.locator('a[href="/passwords?tool=folders"]').click();
      if (mobileNavigation) {
        await page
          .getByRole("dialog", { name: "Workspace", exact: true })
          .waitFor({ state: "hidden" });
      }
      const dialog = taskSurface(page, {
        name: "Folder access",
        exact: true,
      });
      await dialog.waitFor();
      await settleAnimations(page);
      await dialog.getByText("synthetic created the folder.", { exact: true }).waitFor();
      assert.equal(await dialog.getByText("Owner", { exact: true }).count(), 0);
      if (width < 576)
        await dialog.getByRole("button", { name: "Rename folder", exact: true }).click();
      const [renameBox, grantsBox] = await Promise.all([
        dialog
          .getByRole("textbox", {
            name: "Rename folder",
            exact: true,
          })
          .boundingBox(),
        dialog
          .getByRole("heading", {
            name: "Access grants",
            exact: true,
          })
          .boundingBox(),
      ]);
      assert.ok(
        renameBox && grantsBox && grantsBox.y >= renameBox.y + renameBox.height,
        JSON.stringify({ renameBox, grantsBox })
      );
      await dialog.getByLabel("Grant to", { exact: true }).click();
      await page.getByRole("option", { name: "Group", exact: true }).click();
      await dialog.getByLabel("Account or group", { exact: true }).click();
      await page.getByRole("option", { name: "Operations", exact: true }).click();
      const expiry = dialog.getByLabel("Expires (optional)", {
        exact: true,
      });
      assert.equal(await expiry.getAttribute("type"), "text");
      assert.equal(await expiry.getAttribute("role"), "combobox");
      assert.equal(await dialog.locator('input[type="datetime-local"]').count(), 0);
      await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
      const calendar = page.getByRole("grid").last();
      await calendar.waitFor();
      const calendarBounds = await calendar.boundingBox();
      assert.ok(
        calendarBounds && calendarBounds.x >= 0 && calendarBounds.x + calendarBounds.width <= width,
        JSON.stringify({ calendarBounds, width })
      );
      await page.keyboard.press("Escape");
      await calendar.waitFor({ state: "hidden" });
      await dialog.getByRole("button", { name: "Grant access", exact: true }).click();
      await page.getByText("Folder access saved.", { exact: true }).waitFor();
      await mobileToastFits(page, "Folder access saved.", width);
      assert.deepEqual(grants, [{ permission: "read", expires_at: null }]);
      await dialog.getByText("Operations", { exact: true }).first().waitFor();
      const grantAudit = dialog.getByText("synthetic granted folder access to group Operations.", {
        exact: true,
      });
      await grantAudit.waitFor();
      assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
      await visibleTouchAction(page, taskAction(page, dialog, "Close"));
      await viewportScreenshot(page, `folder-group-access-${width}.png`);
      await grantAudit.scrollIntoViewIfNeeded();
      await viewportScreenshot(page, `folder-group-audit-${width}.png`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const [width, language, theme] of [
  [320, "ru", "dark"],
  [375, "en", "light"],
  [768, "ru", "light"],
  [1440, "en", "dark"],
]) {
  test(`expiration uses the Gravity date picker at ${width}px in ${language} ${theme}`, async () => {
    const copy = language === "ru" ? ruText : enText;
    const { context, page, errors } = await vault(width, language, theme, entries, {
      groups: [{ id: 10, name: "Operations", member_count: 1 }],
    });
    try {
      if (await page.locator('[data-qa="mobile-header"]').count()) {
        await page.locator('[data-qa="burger"]').click();
      }
      await page.locator('a[href="/passwords?tool=folders"]').click();
      if (await page.locator('[data-qa="mobile-header"]').count()) {
        await page
          .getByRole("dialog", {
            name: copy.navigation.workspace,
            exact: true,
          })
          .waitFor({ state: "hidden" });
      }
      const dialog = taskSurface(page, {
        name: copy.folderAccess.title,
        exact: true,
      });
      await dialog.waitFor();
      await settleAnimations(page);
      await dialog.getByLabel(copy.folderAccess.targetType, { exact: true }).click();
      await page
        .getByRole("option", {
          name: copy.folderAccess.targetTypes.group,
          exact: true,
        })
        .click();
      await dialog.getByLabel(copy.folderAccess.target, { exact: true }).click();
      await page.getByRole("option", { name: "Operations", exact: true }).click();

      const expiry = dialog.getByLabel(copy.folderAccess.expiresAt, {
        exact: true,
      });
      assert.equal(await expiry.getAttribute("type"), "text");
      assert.equal(await expiry.getAttribute("role"), "combobox");
      assert.equal(await page.locator('input[type="datetime-local"]').count(), 0);
      const expiryInput = await expiry.elementHandle();
      const calendarTrigger = dialog.getByRole("button", {
        name: language === "ru" ? "Календарь" : "Calendar",
        exact: true,
      });
      await calendarTrigger.click();
      const calendar = page.getByRole("grid").last();
      await calendar.waitFor();
      if (width <= 375) {
        const dayBounds = await calendar.locator(".g-date-calendar__button").first().boundingBox();
        assert.ok(
          dayBounds && dayBounds.width >= 39 && dayBounds.height >= 39,
          JSON.stringify({ dayBounds, width })
        );
        assert.equal(await expiryInput.getAttribute("aria-expanded"), "true");
      }
      const calendarBounds = await calendar.boundingBox();
      assert.ok(
        calendarBounds && calendarBounds.x >= 0 && calendarBounds.x + calendarBounds.width <= width,
        JSON.stringify({ calendarBounds, width })
      );
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await viewportScreenshot(page, `gravity-expiry-${width}-${language}-${theme}.png`);
      await page.keyboard.press("Escape");
      await calendar.waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("Gravity composites replace native settings, form validation, and confirmation UI", async () => {
  const { context, page, errors } = await vault(1440, "en", "light", entries, {
    role: "admin",
    users: [
      { id: 1, username: "synthetic", role: "admin", active: true },
      {
        id: 2,
        username: "team-member",
        role: "member",
        active: true,
      },
    ],
  });
  try {
    await page.getByText(enText.topMenu.settings, { exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: enText.settings.title,
      exact: true,
    });
    await settings.waitFor();
    const inactivity = settings.getByRole("spinbutton").first();
    assert.notEqual(await inactivity.getAttribute("type"), "number");
    assert.equal(await inactivity.getAttribute("aria-valuemin"), "30");
    assert.equal(await inactivity.getAttribute("aria-valuemax"), "3600");
    assert.equal(await settings.locator('input[type="number"]').count(), 0);
    assert.equal(await settings.locator('[data-qa="control-buttons-qa"]').count(), 5);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });

    let createRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/users") {
        createRequests += 1;
      }
    });
    await page.goto(`${origin}/users`);
    const form = page.locator("form");
    await form.getByLabel(enText.auth.username, { exact: false }).fill("new-member");
    await form
      .getByRole("button", {
        name: enText.common.actions.create,
        exact: true,
      })
      .click();
    await form
      .getByText(enText.users.temporaryPasswordRequired, {
        exact: true,
      })
      .waitFor();
    const password = form.getByLabel(enText.users.temporaryPassword, {
      exact: true,
    });
    assert.equal(await password.getAttribute("aria-invalid"), "true");
    assert.equal(await password.evaluate((node) => node === document.activeElement), true);
    assert.equal(createRequests, 0);

    await page.getByRole("button", { name: "More: team-member", exact: true }).click();
    await page
      .getByRole("menuitem", {
        name: enText.common.actions.delete,
        exact: true,
      })
      .click();
    const confirmation = page.getByRole("dialog").last();
    await confirmation.waitFor();
    assert.equal(await confirmation.getAttribute("aria-label"), enText.common.actions.delete);
    assert.equal(await confirmation.locator(".gc-confirm-dialog__body").count(), 1);
    const cancel = confirmation.getByRole("button", {
      name: enText.common.actions.cancel,
      exact: true,
    });
    assert.equal(await cancel.evaluate((node) => node === document.activeElement), true);
    await cancel.click();
    await confirmation.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const width of [375, 1440]) {
  test(`sidebar navigation keeps native spacing and one active item at ${width}px`, async () => {
    const { context, page, errors } = await vault(width, "ru");
    try {
      if (await page.locator('[data-qa="mobile-header"]').count()) {
        await page.getByRole("button", { name: "Ещё", exact: true }).click();
      }
      const items = page.locator('[data-qa="navigation-items"] [data-navigation-id]');
      const boxes = await items.evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        })
      );
      assert.ok(boxes.length >= 6, JSON.stringify(boxes));
      for (let index = 1; index < boxes.length; index += 1) {
        assert.ok(boxes[index].top - boxes[index - 1].bottom >= 4, JSON.stringify(boxes));
      }
      const current = page.locator('[data-qa="navigation-items"] [aria-current="page"]');
      assert.equal(await current.count(), 1);
      assert.equal(await current.getAttribute("data-navigation-id"), "/passwords");
      await page.locator('a[data-navigation-id="/passwords?tool=backup"]').click();
      const backupDialog = taskSurface(page, {
        name: "Создать резервную копию",
        exact: true,
      });
      await backupDialog.waitFor();
      assert.equal(await current.count(), 1);
      assert.equal(await current.getAttribute("data-navigation-id"), "/passwords?tool=backup");
      await page.goBack();
      await backupDialog.waitFor({ state: "hidden" });
      assert.equal(new URL(page.url()).searchParams.has("tool"), false);
      await page.goForward();
      await backupDialog.waitFor();
      await page.goto(`${origin}/passwords?tool=health`);
      await backupDialog.waitFor({ state: "hidden" });
      await taskSurface(page, {
        name: "Проверка паролей",
        exact: true,
      }).waitFor();
      assert.equal(await taskSurface(page).count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const width of [375, 899, 900, 1024, 1440]) {
  test(`vault tools stay reachable without duplicate page actions at ${width}px`, async () => {
    const { context, page, errors } = await vault(width, "ru");
    try {
      assert.equal(
        await page
          .getByRole("button", {
            name: "Действия с хранилищем",
            exact: true,
          })
          .count(),
        0
      );
      for (const [name, tool] of [
        ["Папки", "folders"],
        ["Проверка паролей", "health"],
        ["Резервная копия", "backup"],
        ["Импорт", "import"],
        ["Корзина", "trash"],
      ]) {
        if (await page.locator('[data-qa="mobile-header"]').count()) {
          await page.getByRole("button", { name: "Ещё", exact: true }).click();
        }
        const action = page.locator(`a[href="/passwords?tool=${tool}"]`);
        assert.equal(await action.textContent(), name);
        await visibleTouchAction(page, action);
        assert.equal(
          await page
            .getByText(name, { exact: true })
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
          true
        );
        await action.click();
        const dialog = page.locator(
          '[role="dialog"]:not([aria-label="Рабочая область"]), [data-qa="task-page"]'
        );
        await dialog.waitFor();
        await fits(page);
        await leaveSurface(page);
        await dialog.waitFor({ state: "hidden" });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const width of [375, 1440]) {
  test(`password health keeps one readable scroll flow at ${width}px`, async () => {
    const records = [
      entries[0],
      ...Array.from({ length: 10 }, (_, index) => ({
        ...entries[0],
        id: 200 + index,
        password_name:
          index === 9
            ? "Very long weak credential name ".repeat(8)
            : `Weak credential ${index + 1}`,
        username: index === 9 ? "very-long-username-".repeat(12) : `weak-${index + 1}@example.test`,
        password_value: `x${index}`,
        updated: "2026-10-28T12:00:00Z",
      })),
    ];
    const { context, page, errors } = await vault(width, "ru", "dark", records);
    try {
      await page.goto(`${origin}/passwords?tool=health`);
      const dialog = taskSurface(page, {
        name: "Проверка паролей",
        exact: true,
      });
      await dialog.waitFor();
      const groups = dialog.locator('[data-qa="health-issue-group"]');
      await groups.first().waitFor({ state: "visible" });
      assert.equal(await groups.count(), 1);
      const rows = groups.getByRole("button");
      assert.equal(await rows.count(), 10);
      const geometry = await dialog.evaluate((node) => {
        const body = node.querySelector(".g-dialog-body") ?? node.children[1];
        const footer =
          node.querySelector(".g-dialog-footer") ??
          document.querySelector('[data-qa="mobile-task-actions"] [data-qa="task-actions"]');
        const group = node.querySelector('[data-qa="health-issue-group"]');
        const pageScroll = document.querySelector('[data-qa="page-scroll"]');
        const rect = (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            left: bounds.left,
          };
        };
        return {
          dialog: rect(node),
          body: rect(body),
          footer: rect(footer),
          scroll: pageScroll ? rect(pageScroll) : null,
          group: rect(group),
          bodyScrollable: node.hasAttribute("data-qa")
            ? pageScroll.scrollHeight > pageScroll.clientHeight
            : body.scrollHeight > body.clientHeight,
          bodyOverflow: body.scrollWidth > body.clientWidth,
        };
      });
      assert.equal(geometry.bodyOverflow, false, JSON.stringify(geometry));
      assert.ok(geometry.group.left >= geometry.body.left, JSON.stringify(geometry));
      assert.ok(geometry.group.right <= geometry.body.right, JSON.stringify(geometry));
      assert.ok(
        geometry.footer.top >= (geometry.scroll ?? geometry.body).bottom - 1,
        JSON.stringify(geometry)
      );
      assert.ok(
        geometry.footer.bottom <= (width < 576 ? 812 : geometry.dialog.bottom) + 1,
        JSON.stringify(geometry)
      );
      assert.equal(geometry.bodyScrollable, true, JSON.stringify(geometry));
      if (process.env.CIPHERMOTH_SCREENSHOT_DIR) {
        await mkdir(process.env.CIPHERMOTH_SCREENSHOT_DIR, {
          recursive: true,
        });
        await page.screenshot({
          path: resolve(process.env.CIPHERMOTH_SCREENSHOT_DIR, `health-${width}-top.png`),
        });
      }
      await rows.last().scrollIntoViewIfNeeded();
      await rows.last().waitFor({ state: "visible" });
      if (width < 576) {
        const last = await rows.last().boundingBox();
        assert.ok(last.y >= 0 && last.y + last.height <= geometry.footer.top);
      }
      const done = page.getByRole("button", {
        name: "Готово",
        exact: true,
      });
      await visibleTouchAction(page, done);
      assert.equal(
        await done.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          );
        }),
        true,
        "health completion is reachable through its only scroll owner"
      );
      if (process.env.CIPHERMOTH_SCREENSHOT_DIR) {
        await page.screenshot({
          path: resolve(process.env.CIPHERMOTH_SCREENSHOT_DIR, `health-${width}-bottom.png`),
        });
      }
      await fits(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const width of [320, 375, 430, 768, 1024, 1440]) {
  test(`vault rows keep a touch-safe open action and responsive quick actions at ${width}px`, async () => {
    const { context, page, errors } = await vault(width, "en", "dark", [
      { ...entries[0], totp_secret: null },
    ]);
    try {
      const item = page.locator('[data-qa="entry-list"]').getByRole("row");
      const open = item;
      await visibleTouchAction(page, open);
      const actions = item.getByRole("button");
      const visible = await actions.evaluateAll((buttons) =>
        buttons
          .filter((button) => button.offsetParent !== null)
          .map((button) => {
            const { x, width, height } = button.getBoundingClientRect();
            return { x, width, height };
          })
      );
      if (width < 1280) {
        if (width < 576) {
          assert.equal(visible.length, 1);
          assert.ok(visible[0].width >= 44 && visible[0].height >= 44);
        } else assert.deepEqual(visible, []);
      } else {
        assert.ok(visible.length >= 4);
        for (const box of visible) {
          assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify(box));
          assert.ok(box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
        }
      }
      await fits(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("desktop vault keeps the screen fixed and scrolls the entry list", async () => {
  const records = [
    entries[0],
    ...Array.from({ length: 39 }, (_, index) => ({
      ...entries[0],
      id: 100 + index,
      password_name: `Scrollable entry ${index + 1}`,
    })),
  ];
  const { context, page, errors } = await vault(1440, "ru", "dark", records);
  try {
    const region = page.locator('[data-qa="entry-scroll-region"]');
    const title = page.locator('[data-qa="vault-page"] h1');
    const before = await region.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      windowScrollY: window.scrollY,
      documentScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
    }));
    assert.ok(before.scrollHeight > before.clientHeight, JSON.stringify(before));
    assert.ok(before.documentScrollHeight <= before.viewportHeight + 1, JSON.stringify(before));
    await viewportScreenshot(page, "desktop-vault-scroll-top.png");
    const titleTop = await title.evaluate((node) => node.getBoundingClientRect().top);
    await region.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForTimeout(100);
    const after = await region.evaluate((node) => ({
      scrollTop: node.scrollTop,
      windowScrollY: window.scrollY,
    }));
    assert.ok(after.scrollTop > 0, JSON.stringify(after));
    assert.equal(after.windowScrollY, 0);
    assert.equal(await title.evaluate((node) => node.getBoundingClientRect().top), titleTop);
    await viewportScreenshot(page, "desktop-vault-scroll-bottom.png");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("mobile vault opens an accessible read view without exposing secrets", async () => {
  const { context, page, errors } = await vault(375);
  try {
    const list = page.locator('[data-qa="entry-list"]');
    await list.getByRole("row", { name: /GitHub/ }).click();
    const detail = taskSurface(page, {
      name: "GitHub",
      exact: true,
    });
    await detail.waitFor();
    assert.equal(await detail.getByText(entries[0].password_value, { exact: true }).count(), 0);
    assert.equal(await detail.getByText("Synthetic-recovery", { exact: true }).count(), 0);
    await detail.getByRole("button", { name: "Show password", exact: true }).click();
    await detail.getByText(entries[0].password_value, { exact: true }).waitFor();
    await detail.getByRole("button", { name: "Copy password", exact: true }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      entries[0].password_value
    );
    await detail.getByRole("button", { name: /^Copy 2FA code/ }).click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^\d{6}$/);
    await taskAction(page, detail, "Back").click();

    await list.getByRole("row", { name: /Read-only account/ }).click();
    const readOnly = taskSurface(page, {
      name: "Read-only account",
      exact: true,
    });
    await readOnly.waitFor();
    for (const name of ["Edit", "Delete", "Manage access"]) {
      assert.equal(await readOnly.getByRole("button", { name, exact: true }).count(), 0);
    }
    await readOnly.getByText("Attachments (1)", { exact: true }).click();
    await readOnly.getByText("Readme.txt", { exact: true }).waitFor();
    assert.equal(await readOnly.locator('input[type="file"]').count(), 0);
    await taskAction(page, readOnly, "Back").click();

    await list.getByRole("row", { name: /Recovery notes/ }).click();
    const note = taskSurface(page, {
      name: "Recovery notes",
      exact: true,
    });
    assert.equal(await note.getByText(entries[2].password_value, { exact: true }).count(), 0);
    await note.getByRole("button", { name: "Copy note", exact: true }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      entries[2].password_value
    );
    await fits(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("desktop quick actions and details preserve ACL and confirmation boundaries", async () => {
  const { context, page, errors } = await vault(1440);
  try {
    const list = page.locator('[data-qa="entry-list"]');
    const github = list.getByRole("row").filter({ hasText: "GitHub" });
    await github.getByRole("button", { name: "Copy username", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), entries[0].username);
    await github.getByRole("button", { name: "Show password", exact: true }).click();
    await github.getByText(entries[0].password_value, { exact: true }).waitFor();
    assert.equal(await github.locator('[data-qa="entry-revealed-separator"]').count(), 1);
    const revealedGeometry = await github.evaluate((row) => {
      const metadata = row.querySelector('[data-qa="entry-metadata"]').getBoundingClientRect();
      const revealed = row
        .querySelector('[data-qa="entry-revealed-value"]')
        .getBoundingClientRect();
      return {
        metadataBottom: metadata.bottom,
        metadataLeft: metadata.left,
        revealedTop: revealed.top,
        revealedLeft: revealed.left,
      };
    });
    assert.ok(
      revealedGeometry.revealedTop >= revealedGeometry.metadataBottom,
      JSON.stringify(revealedGeometry)
    );
    assert.ok(
      Math.abs(revealedGeometry.revealedLeft - revealedGeometry.metadataLeft) <= 1,
      JSON.stringify(revealedGeometry)
    );
    await viewportScreenshot(page, "entry-row-revealed-1440.png");
    await github.getByRole("button", { name: "Copy password", exact: true }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      entries[0].password_value
    );
    await github.getByRole("button", { name: "More: GitHub", exact: true }).click();
    for (const name of [
      "Open website",
      "Remove from favorites",
      "Edit",
      "Manage access",
      "Delete",
    ]) {
      const item = page.getByRole("menuitem", { name, exact: true });
      await item.waitFor();
      await item.hover();
      assert.match(await github.getAttribute("class"), /g-list-item-view_hovered_yes/);
    }
    await viewportScreenshot(page, "entry-menu-hover-1440.png");
    await page.keyboard.press("Escape");
    assert.doesNotMatch((await github.getAttribute("class")) ?? "", /g-list-item-view_hovered_yes/);

    const trigger = github;
    await trigger.click({ position: { x: 24, y: 24 } });
    const detail = page.getByRole("region", { name: "Entry details" });
    await detail.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
    const back = detail.getByRole("button", {
      name: "Back to entries",
      exact: true,
    });
    await visibleTouchAction(page, back);
    assert.ok((await back.locator("svg").count()) >= 1);
    const headerGeometry = await detail.evaluate((region) => {
      const backBox = region
        .querySelector('[data-qa="entry-details-back"]')
        .getBoundingClientRect();
      const headerBox = region
        .querySelector('[data-qa="entry-details-header"]')
        .getBoundingClientRect();
      return {
        backBottom: backBox.bottom,
        headerTop: headerBox.top,
        gap: headerBox.top - backBox.bottom,
      };
    });
    assert.ok(headerGeometry.headerTop >= headerGeometry.backBottom);
    assert.ok(headerGeometry.gap <= 24, JSON.stringify(headerGeometry));
    assert.equal(await detail.getByText(entries[0].password_value, { exact: true }).count(), 0);
    const deleteButton = detail.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await deleteButton.click();
    const confirmation = page.getByRole("dialog", {
      name: "Move entry to trash?",
      exact: true,
    });
    await confirmation.waitFor();
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await page.keyboard.press("Escape");
    assert.equal(await detail.count(), 0);
    await page.waitForFunction(
      (row) => document.activeElement === row,
      await trigger.elementHandle()
    );
    assert.equal(await trigger.evaluate((button) => document.activeElement === button), true);

    const readOnlyTrigger = list.getByRole("row").filter({ hasText: "Read-only account" });
    await readOnlyTrigger.click();
    const readOnly = page.getByRole("region", { name: "Entry details" });
    await readOnly.getByRole("heading", { name: "Read-only account" }).waitFor();
    for (const name of ["Edit", "Delete", "Manage access"]) {
      assert.equal(await readOnly.getByRole("button", { name, exact: true }).count(), 0);
    }
    await fits(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("entry context actions preserve ACL, keyboard focus, selection and mobile access", async () => {
  const { context, page, errors } = await vault(1440);
  try {
    const list = page.locator('[data-qa="entry-list"]');
    const github = list.getByRole("row").filter({ hasText: "GitHub" });
    const menu = page.getByRole("menu", {
      name: "Actions for GitHub",
      exact: true,
    });

    await github.focus();
    await page.keyboard.press("Shift+F10");
    await menu.waitFor();
    for (const name of [
      "Copy username",
      "Copy password",
      "Copy 2FA code",
      "Copy website",
      "Open website",
      "Duplicate",
      "Move",
      "Move to trash",
    ]) {
      await menu.getByRole("menuitem", { name, exact: true }).waitFor();
    }
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await github.evaluate((node) => node === document.activeElement), true);

    await github.click({ button: "right", modifiers: ["Shift"] });
    assert.equal(await menu.count(), 0, "Shift+right-click keeps the browser menu");

    await github.click({ button: "right" });
    await menu.waitFor();
    await menu.getByRole("menuitem", { name: "Copy website", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "github.com");
    assert.equal(await github.evaluate((node) => node === document.activeElement), true);

    await github.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
    const duplicate = page.getByRole("dialog", {
      name: "Add entry",
      exact: true,
    });
    await duplicate.waitFor();
    assert.equal(
      await duplicate.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
      "GitHub (copy)"
    );
    await duplicate.getByRole("button", { name: "Cancel", exact: true }).click();
    await duplicate.waitFor({ state: "hidden" });

    await list.getByLabel("Select GitHub", { exact: true }).click();
    await list.getByLabel("Select Recovery notes", { exact: true }).click();
    await github.click({ button: "right" });
    const selectedMenu = page.getByRole("menu", {
      name: "Actions for 2 selected entries",
      exact: true,
    });
    await selectedMenu.waitFor();
    await selectedMenu
      .getByRole("menuitem", {
        name: "Move 2 selected entries",
        exact: true,
      })
      .waitFor();
    await selectedMenu
      .getByRole("menuitem", {
        name: "Move 2 selected entries to trash",
        exact: true,
      })
      .waitFor();
    await page.keyboard.press("Escape");
    await selectedMenu.waitFor({ state: "hidden" });
    assert.equal(await list.getByLabel("Select GitHub", { exact: true }).isChecked(), true);
    await list.getByLabel("Select GitHub", { exact: true }).click();
    await list.getByLabel("Select Recovery notes", { exact: true }).click();

    const writable = list.getByRole("row").filter({ hasText: "Recovery notes" });
    await writable.click({ button: "right" });
    const writableMenu = page.getByRole("menu", {
      name: "Actions for Recovery notes",
      exact: true,
    });
    await writableMenu.waitFor();
    for (const name of ["Duplicate", "Move", "Move to trash"]) {
      await writableMenu.getByRole("menuitem", { name, exact: true }).waitFor();
    }
    assert.equal(
      await writableMenu.getByRole("menuitem", { name: "Manage access", exact: true }).count(),
      0
    );
    await page.keyboard.press("Escape");

    const readOnly = list.getByRole("row").filter({ hasText: "Read-only account" });
    await readOnly.click({ button: "right" });
    const readOnlyMenu = page.getByRole("menu", {
      name: "Actions for Read-only account",
      exact: true,
    });
    await readOnlyMenu.waitFor();
    await readOnlyMenu.getByRole("menuitem", { name: "Copy username", exact: true }).waitFor();
    for (const name of ["Edit", "Duplicate", "Move", "Move to trash", "Manage access"]) {
      assert.equal(await readOnlyMenu.getByRole("menuitem", { name, exact: true }).count(), 0);
    }
    await page.keyboard.press("Escape");
    await fits(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("phone exposes entry context actions through a touch-sized menu button", async () => {
  const { context, page, errors } = await vault(375, "ru", "dark");
  try {
    const more = page.getByRole("button", {
      name: "Ещё: GitHub",
      exact: true,
    });
    await visibleTouchAction(page, more);
    await more.click();
    const menu = page.getByRole("menu", {
      name: "Действия с записью «GitHub»",
      exact: true,
    });
    await menu.waitFor();
    await menu.getByRole("menuitem", { name: "Скопировать сайт", exact: true }).waitFor();
    await fits(page);
    await axe(page);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await more.evaluate((node) => node === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("entry editor keeps favorite beside the dialog close action", async () => {
  const { context, page, errors } = await vault(1440, "en", "dark");
  try {
    await page
      .locator('[data-qa="entry-list"]')
      .getByRole("row")
      .filter({ hasText: "GitHub" })
      .getByText("GitHub", { exact: true })
      .click();
    const details = page.getByRole("region", { name: "Entry details" });
    await details.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Edit login",
      exact: true,
    });
    await dialog.waitFor();
    await settleAnimations(page);
    const favorite = dialog.locator('[data-qa="entry-favorite-toggle"]');
    const close = dialog.locator("button[aria-label]").first();
    await visibleTouchAction(page, favorite);
    assert.equal(await favorite.count(), 1);
    const geometry = await Promise.all([favorite, close].map((control) => control.boundingBox()));
    assert.ok(geometry.every(Boolean), JSON.stringify(geometry));
    const [favoriteBox, closeBox] = geometry;
    assert.ok(favoriteBox.x < closeBox.x, JSON.stringify(geometry));
    assert.ok(Math.abs(favoriteBox.y - closeBox.y) <= 1, JSON.stringify(geometry));
    assert.ok(closeBox.x - (favoriteBox.x + favoriteBox.width) <= 12, JSON.stringify(geometry));
    await viewportScreenshot(page, "entry-editor-header.png");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const [width, language, theme] of [
  [320, "en", "dark"],
  [375, "ru", "light"],
  [430, "en", "dark"],
  [768, "ru", "dark"],
  [900, "ru", "dark"],
  [1024, "en", "dark"],
  [1280, "en", "dark"],
  [1440, "ru", "light"],
]) {
  test(`vault layout, filtering, details and trash fit ${width}px / ${language} / ${theme}`, async () => {
    const { context, page, errors } = await vault(width, language, theme);
    try {
      const ru = language === "ru";
      const t = ru ? ruText : enText;
      const list = page.locator('[data-qa="entry-list"]');
      assert.equal(await list.getByRole("row").count(), entries.length);
      await fits(page);
      await axe(page);

      const expectedOrder = [entries[1], entries[3], entries[2], entries[0]].map(
        (entry) => entry.password_name
      );
      assert.deepEqual(
        await list
          .getByRole("row")
          .evaluateAll((rows) =>
            rows.map((row) => row.querySelectorAll('[role="gridcell"]')[1].textContent)
          ),
        expectedOrder
      );

      const search = page.getByPlaceholder(ru ? "Поиск записей…" : "Search entries…");
      assert.equal(await page.locator('[data-qa="vault-search"] svg').count(), 0);
      const sort = page.getByRole("combobox", {
        name: t.vault.browser.sort,
        exact: true,
      });
      assert.equal((await sort.textContent()).trim(), t.vault.browser.dateAdded);
      const folder = page.getByRole("combobox", {
        name: t.common.fields.folder,
        exact: true,
      });
      assert.equal((await folder.textContent()).trim(), t.vault.allFolders);
      await search.fill("reader@example.test");
      assert.equal(await list.getByRole("row").count(), 1);
      await search.fill("");

      await page
        .getByRole("combobox", {
          name: ru ? /^Папка/ : /^Folder/,
        })
        .click();
      await page.getByRole("option", { name: /^(Shared|Общ)/ }).click();
      assert.equal(await list.getByRole("row").count(), 1);
      await page
        .getByRole("combobox", {
          name: ru ? /^Папка/ : /^Folder/,
        })
        .click();
      await page
        .getByRole("option", {
          name: ru ? "Все папки" : "All folders",
          exact: true,
        })
        .click();

      const longName = entries[3].password_name;
      await list.getByRole("row").filter({ hasText: longName }).click();
      const detail =
        width >= 1280
          ? page.getByRole("region", {
              name: ru ? "Просмотр записи" : "Entry details",
            })
          : taskSurface(page, { name: longName, exact: true });
      await detail.waitFor();
      await axe(page);
      assert.equal(await detail.getByText(entries[3].password_value, { exact: true }).count(), 0);
      await detail
        .getByRole("button", {
          name: ru ? "Показать пароль" : "Show password",
          exact: true,
        })
        .click();
      await detail.getByText(entries[3].password_value, { exact: true }).waitFor();
      await leaveSurface(page);
      await detail.waitFor({ state: "hidden" });

      if (await page.locator('[data-qa="mobile-header"]').count()) {
        await page
          .getByRole("button", {
            name: t.navigation.more,
            exact: true,
          })
          .click();
      }
      await page.locator('a[href="/passwords?tool=trash"]').click();
      const trash = taskSurface(page, {
        name: ru ? "Корзина" : "Trash",
        exact: true,
      });
      await trash.waitFor();
      await trash.getByRole("button", { name: /^(Восстановить|Restore)/ }).waitFor();
      await fits(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const [width, language] of [
  [320, "en"],
  [375, "ru"],
]) {
  test(`quick filters intersect and reset at ${width}px / ${language}`, async () => {
    const { context, page, errors } = await vault(width, language);
    try {
      const text = language === "ru" ? ruText : enText;
      const list = page.locator('[data-qa="entry-list"]');
      const trigger = page.locator('[data-qa="entry-filters"]');
      await visibleTouchAction(page, trigger);
      await trigger.click();
      const menu = page.getByRole("menu", {
        name: text.vault.filters.title,
        exact: true,
      });
      await menu.waitFor();
      const attachments = menu.locator('[data-qa="entry-filter-attachments"]');
      assert.match((await attachments.textContent()).trim(), /1$/);

      const favorites = menu.locator('[data-qa="entry-filter-favorites"]');
      await favorites.focus();
      await favorites.press("Space");
      assert.equal(await favorites.isVisible(), true);
      assert.equal(await favorites.getAttribute("aria-checked"), "true");
      assert.equal(await list.getByRole("row").count(), 1);

      const selected = list.getByRole("checkbox", {
        name: text.vault.bulk.selectEntry.replace("{{name}}", "GitHub"),
        exact: true,
      });
      await selected.check();
      if (!(await menu.isVisible())) await trigger.click();
      await menu.locator('[data-qa="entry-filter-secure-notes"]').click();
      await page.getByText(text.vault.noQuickFilterResults, { exact: true }).waitFor();
      await page
        .getByRole("button", {
          name: text.vault.resetFilters,
          exact: true,
        })
        .click();
      assert.equal(await list.getByRole("row").count(), entries.length);
      assert.equal(await selected.isChecked(), true);
      await fits(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("bulk vault and trash actions keep stable selections and send one bounded request", async () => {
  const trash = [
    {
      id: 11,
      password_name: "Deleted / account",
      username: "old@example.test",
      deleted: "2026-10-20T12:00:00Z",
    },
    {
      id: 12,
      password_name: "Old Wi-Fi",
      username: "wifi@example.test",
      deleted: "2026-10-21T12:00:00Z",
    },
  ];
  const { context, page, errors } = await vault(375, "en", "dark", entries, {
    trash,
  });
  try {
    const list = page.locator('[data-qa="entry-list"]');
    const github = list.getByRole("checkbox", {
      name: "Select GitHub",
      exact: true,
    });
    await github.focus();
    await github.press("Enter");
    assert.equal(await github.isChecked(), true);
    await github.press("Space");
    assert.equal(await github.isChecked(), false);
    await github.press("Space");
    assert.equal(await github.isChecked(), true);
    await page.getByRole("button", { name: "Move to trash", exact: true }).waitFor();
    await page.getByPlaceholder("Search entries…").fill("Recovery");
    assert.equal(await page.locator('[data-qa="entry-bulk-actions"]').count(), 1);
    await page.getByPlaceholder("Search entries…").fill("");
    assert.equal(await github.isChecked(), true);

    const bulkMove = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/vault/entries/move"
    );
    await page.getByRole("button", { name: "Move", exact: true }).click();
    const moveDialog = taskSurface(page, {
      name: "Move selected entries",
      exact: true,
    });
    await moveDialog.waitFor();
    await taskAction(page, moveDialog, "Move").click();
    assert.deepEqual((await bulkMove).postDataJSON(), {
      entries: [{ entry_id: 1 }],
      folder_id: null,
    });
    const bulkMoveUndo = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/vault/entries/move/undo"
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    assert.deepEqual((await bulkMoveUndo).postDataJSON(), {
      entries: [{ entry_id: 1, folder_id: 1, moved_to_folder_id: null }],
    });

    await github.check();
    const bulkTrash = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/vault/entries/trash"
    );
    await github.press("Backspace");
    assert.deepEqual((await bulkTrash).postDataJSON(), {
      entries: [{ entry_id: 1, password_name: "GitHub" }],
    });
    await page.locator('[data-qa="entry-bulk-actions"]').waitFor({ state: "hidden" });

    await page.goto(`${origin}/passwords?tool=trash`);
    const dialog = taskSurface(page, { name: "Trash", exact: true });
    await dialog.waitFor();
    for (const entry of trash) {
      await dialog
        .getByRole("checkbox", {
          name: `Select ${entry.password_name}`,
          exact: true,
        })
        .check();
    }
    const restore = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/vault/trash/restore"
    );
    await dialog.getByRole("button", { name: "Restore selected", exact: true }).click();
    assert.deepEqual((await restore).postDataJSON(), {
      entries: trash.map((entry) => ({
        password_name: entry.password_name,
        entry_id: entry.id,
      })),
    });
    await dialog.locator('[data-qa="trash-bulk-actions"]').waitFor({ state: "hidden" });

    for (const entry of trash) {
      await dialog
        .getByRole("checkbox", {
          name: `Select ${entry.password_name}`,
          exact: true,
        })
        .check();
    }
    await dialog.getByRole("button", { name: "Delete selected", exact: true }).click();
    const confirmation = page.getByRole("dialog", {
      name: "Delete selected entries permanently?",
      exact: true,
    });
    assert.match(await confirmation.textContent(), /Deleted \/ account/);
    assert.match(await confirmation.textContent(), /Old Wi-Fi/);
    const purge = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/vault/trash/purge"
    );
    await confirmation.getByRole("button", { name: "Delete selected", exact: true }).click();
    assert.deepEqual((await purge).postDataJSON(), {
      entries: trash.map((entry) => ({
        password_name: entry.password_name,
        entry_id: entry.id,
      })),
    });
    await confirmation.waitFor({ state: "hidden" });
    await fits(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const [width, language] of [
  [320, "en"],
  [375, "ru"],
]) {
  test(`bulk trash Undo fits ${width}px / ${language}`, async () => {
    const text = language === "ru" ? ruText : enText;
    const { context, page, errors } = await vault(width, language);
    try {
      const selected = page.getByRole("checkbox", {
        name: text.vault.bulk.selectEntry.replace("{{name}}", "GitHub"),
        exact: true,
      });
      await selected.check();
      const trashed = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/vault/entries/trash"
      );
      await page
        .getByRole("button", {
          name: text.vault.bulk.moveToTrash,
          exact: true,
        })
        .click();
      assert.deepEqual((await trashed).postDataJSON(), {
        entries: [{ entry_id: 1, password_name: "GitHub" }],
      });
      await page
        .getByRole("button", {
          name: text.vault.bulk.undo,
          exact: true,
        })
        .waitFor();
      await mobileToastFits(page, text.vault.messages.movedToTrash_one, width);

      const undone = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/vault/entries/trash/undo"
      );
      await page
        .getByRole("button", {
          name: text.vault.bulk.undo,
          exact: true,
        })
        .click();
      assert.deepEqual((await undone).postDataJSON(), {
        entries: [
          {
            entry_id: 1,
            password_name: "GitHub",
            deleted_at: "2026-11-11T12:00:00",
          },
        ],
      });
      await mobileToastFits(page, text.vault.messages.trashUndone_one, width);
      await fits(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("profile footer shows and applies current language and theme", async () => {
  const { context, page, errors } = await vault(375, "ru", "dark", entries, {
    role: "admin",
  });
  try {
    await page.getByRole("button", { name: ruText.navigation.more, exact: true }).click();
    await settleAnimations(page);
    const footer = page.locator('[data-qa="navigation-footer"]');
    assert.equal(await footer.locator('[data-qa="navigation-account"]').count(), 1);
    await footer
      .getByRole("button", {
        name: new RegExp(`^${ruText.language.label}\\s+${ruText.language.russian}$`),
      })
      .click();
    await page
      .getByRole("menuitemcheckbox", {
        name: ruText.language.english,
        exact: true,
      })
      .click();
    await footer
      .getByRole("button", {
        name: new RegExp(`^${enText.language.label}\\s+${enText.language.english}$`),
      })
      .waitFor();

    await footer
      .getByRole("button", {
        name: new RegExp(`^${enText.theme.label}\\s+${enText.theme.dark}$`),
      })
      .click();
    await page
      .getByRole("menuitemcheckbox", {
        name: enText.theme.light,
        exact: true,
      })
      .click();
    await footer
      .getByRole("button", {
        name: new RegExp(`^${enText.theme.label}\\s+${enText.theme.light}$`),
      })
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() => ({
        mode: document.documentElement.dataset.theme,
        saved: localStorage.getItem("ciphermoth-theme"),
      })),
      { mode: "light", saved: "light" }
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const [width, language] of [
  [320, "en"],
  [375, "ru"],
  [1440, "en"],
]) {
  test(`recovery code issue, close, retry and revoke fit ${width}px / ${language}`, async () => {
    const text = language === "ru" ? ruText : enText;
    const currentPassword = "Synthetic-current-password!2026";
    const issuedCode = "SYNTHETIC-RECOVERY-CODE-ONCE";
    let configured = false;
    let issueAttempts = 0;
    let revokeAttempts = 0;
    const { context, page, errors } = await vault(width, language, "dark", entries, {
      role: "admin",
    });
    const openRecovery = async () => {
      if (width < 1080)
        await page.getByRole("button", { name: text.navigation.more, exact: true }).click();
      await page.getByRole("button", { name: text.auth.recoveryTitle, exact: true }).click();
      await page.getByLabel(text.auth.currentPassword, { exact: true }).waitFor();
    };
    try {
      await page.route("**/api/auth/recovery", async (route) => {
        const request = route.request();
        if (request.method() === "GET") return route.fulfill({ json: { configured } });
        assert.deepEqual(request.postDataJSON(), { current_password: currentPassword });
        if (request.method() === "POST") {
          issueAttempts += 1;
          if (issueAttempts === 1)
            return route.fulfill({
              status: 403,
              json: { detail: "Synthetic confirmation rejected" },
            });
          configured = true;
          return route.fulfill({
            json: { configured: true, recovery_code: issuedCode },
          });
        }
        assert.equal(request.method(), "DELETE");
        revokeAttempts += 1;
        configured = false;
        return route.fulfill({ json: { configured: false } });
      });

      await openRecovery();
      const password = page.getByLabel(text.auth.currentPassword, { exact: true });
      await password.fill(currentPassword);
      await page.getByRole("button", { name: text.auth.recoveryCreate, exact: true }).click();
      await page.getByText("Synthetic confirmation rejected", { exact: true }).waitFor();
      assert.equal(await password.inputValue(), currentPassword, "failure permits retry");
      assert.equal(await password.getAttribute("type"), "password");
      assert.equal((await page.locator("body").textContent()).includes(currentPassword), false);

      await page.getByRole("button", { name: text.auth.recoveryCreate, exact: true }).click();
      await page.getByText(issuedCode, { exact: false }).waitFor();
      assert.equal(
        await page.getByLabel(text.auth.currentPassword, { exact: true }).count(),
        0,
        "the issued code is the only state shown before close"
      );
      await fits(page);
      await axe(page);
      const recoverySurface =
        width < 576
          ? page.locator('[data-qa="task-page"]')
          : page.getByRole("dialog", { name: text.auth.recoveryTitle, exact: true });
      await taskAction(page, recoverySurface, text.common.actions.close).click();
      await page.getByText(issuedCode, { exact: false }).waitFor({ state: "hidden" });

      await openRecovery();
      assert.equal(
        await page.getByText(issuedCode, { exact: false }).count(),
        0,
        "a code is never fetched or redisplayed after close"
      );
      await page.getByLabel(text.auth.currentPassword, { exact: true }).fill(currentPassword);
      await page.getByRole("button", { name: text.auth.recoveryRevoke, exact: true }).click();
      await page.getByRole("button", { name: text.auth.recoveryCreate, exact: true }).waitFor();
      assert.equal(issueAttempts, 2);
      assert.equal(revokeAttempts, 1);
      await fits(page);
      await axe(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("phone task navigation preserves list context, history, drafts and failed edits", async () => {
  const records = [
    ...structuredClone(entries),
    ...Array.from({ length: 30 }, (_, index) => ({
      ...structuredClone(entries[0]),
      id: 100 + index,
      password_name: `GitHub ${String(index).padStart(2, "0")}`,
    })),
  ];
  records.find((entry) => entry.id === 129).password_history = [
    { value: "Synthetic-history", changed_at: "2026-10-01T12:00:00Z" },
  ];
  records.find((entry) => entry.id === 2).password_history = [
    { value: "Synthetic-read-history", changed_at: "2026-10-01T12:00:00Z" },
  ];
  const { context, page, errors } = await vault(375, "ru", "dark", records, {
    role: "admin",
  });
  const t = ruText;
  const button = (name) => page.getByRole("button", { name, exact: true });
  const capture = async (state) => {
    await fits(page);
    await axe(page);
    await viewportScreenshot(page, `navigation-375-ru-dark-${state}.png`);
  };
  try {
    const search = page.getByPlaceholder(t.vault.searchPlaceholder);
    await search.fill("GitHub");
    await page
      .getByRole("combobox", {
        name: t.common.fields.folder,
        exact: true,
      })
      .click();
    await page.getByRole("option", { name: /^Work/ }).click();
    await page.getByRole("combobox", { name: t.vault.browser.sort, exact: true }).click();
    await page
      .getByRole("option", {
        name: t.vault.browser.nameAscending,
        exact: true,
      })
      .click();
    const row = page.locator('[data-entry-id="129"]');
    await row.scrollIntoViewIfNeeded();
    const scroll = await page.locator('[data-qa="page-scroll"]').evaluate((node) => node.scrollTop);
    assert.ok(scroll > 0);
    await row.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/passwords?entry=129&view=details");
    await taskSurface(page, { name: "GitHub 29", exact: true }).waitFor();
    await settleAnimations(page);
    assert.deepEqual(
      await page
        .getByRole("dialog")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
      []
    );
    assert.equal(
      await search.isVisible(),
      false,
      "a task owns main, not a second body below the list"
    );
    await button(t.entry.labels.passwordHistory).click();
    const history = page.getByRole("dialog", {
      name: t.entry.history.title,
      exact: true,
    });
    await history.waitFor();
    await history
      .getByRole("button", {
        name: t.entry.history.useAgain,
        exact: true,
      })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: t.entry.history.confirmTitle,
      exact: true,
    });
    await confirmation.waitFor();
    await capture("history-confirmation");
    await confirmation.getByRole("button", { name: t.common.actions.cancel, exact: true }).click();
    await history.getByRole("button", { name: t.common.actions.close, exact: true }).click();
    await history.waitFor({ state: "hidden" });
    await capture("details");
    await page.goBack();
    await row.waitFor();
    await page.waitForTimeout(100);
    assert.equal(await search.inputValue(), "GitHub");
    assert.equal(await row.evaluate((node) => document.activeElement === node), true);
    assert.ok(
      Math.abs(
        (await page.locator('[data-qa="page-scroll"]').evaluate((node) => node.scrollTop)) - scroll
      ) < 5,
      "Back restores list position"
    );
    await page.goForward();
    await taskSurface(page, { name: "GitHub 29", exact: true }).waitFor();
    await page.reload();
    await taskSurface(page, { name: "GitHub 29", exact: true }).waitFor();
    await button(t.common.actions.edit).click();
    await page.waitForURL("**/passwords?entry=129&view=edit");
    const username = page.getByLabel(t.entry.labels.usernameOptional, {
      exact: true,
    });
    await username.fill("changed@example.test");
    await page.setViewportSize({ width: 768, height: 900 });
    await taskSurface(page, {
      name: t.entry.title.editPassword,
      exact: true,
    }).waitFor();
    assert.equal(
      await username.inputValue(),
      "changed@example.test",
      "resize keeps the same task and form state"
    );
    await page.setViewportSize({ width: 375, height: 480 });
    await username.focus();
    await page.keyboard.press("Tab");
    await settleAnimations(page);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await capture("edit-short-focused");
    let fail = true;
    const updates = [];
    await page.route("**/api/passwords/update", async (route) => {
      const payload = route.request().postDataJSON();
      updates.push(payload);
      if (fail)
        return route.fulfill({
          status: 503,
          json: { detail: "Synthetic save failure" },
        });
      Object.assign(
        records.find((entry) => entry.id === 129),
        payload.new_password
      );
      return route.fulfill({ json: {} });
    });
    await button(t.common.actions.update).click();
    await page.getByText("Synthetic save failure", { exact: true }).waitFor();
    assert.equal(await username.inputValue(), "changed@example.test");
    await capture("edit-error-retained");
    fail = false;
    await button(t.common.actions.update).click();
    await page.waitForURL("**/passwords?entry=129&view=details");
    await page.getByText("changed@example.test", { exact: true }).waitFor();
    assert.equal(updates.length, 2);
    await page.locator('[data-qa="task-back"]').click();
    await page.waitForURL("**/passwords");
    await page.setViewportSize({ width: 375, height: 812 });
    await button(t.common.actions.add).click();
    await page.getByLabel(t.common.fields.name, { exact: true }).fill("Unfinished synthetic draft");
    await page.goBack();
    await page.waitForURL("**/passwords");
    await button(t.entry.draft.resume).click();
    assert.equal(
      await page.getByLabel(t.common.fields.name, { exact: true }).inputValue(),
      "Unfinished synthetic draft"
    );
    await capture("draft-resume-page");
    await button(t.common.actions.cancel).click();
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("ciphermoth-entry-draft:v1:1")),
      null
    );
    for (const view of ["edit", "share"]) {
      await page.goto(`${origin}/passwords?entry=2&view=${view}`);
      await page.getByText(t.entry.unavailable, { exact: true }).waitFor();
      assert.equal(await button(t.common.actions.update).count(), 0);
      await capture(`readonly-${view}-denied`);
    }
    await page.goto(`${origin}/passwords?entry=2&view=details`);
    await taskSurface(page, {
      name: "Read-only account",
      exact: true,
    }).waitFor();
    await button(t.entry.labels.passwordHistory).click();
    const readonlyHistory = page.getByRole("dialog", {
      name: t.entry.history.title,
      exact: true,
    });
    await readonlyHistory.waitFor();
    assert.equal(
      await readonlyHistory
        .getByRole("button", {
          name: t.entry.history.useAgain,
          exact: true,
        })
        .count(),
      0
    );
    await readonlyHistory
      .getByRole("button", { name: t.common.actions.close, exact: true })
      .click();
    await readonlyHistory.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("phone preferences save, retry and password change return through real routes", async () => {
  const { context, page, errors } = await vault(375, "ru", "dark", entries, {
    role: "admin",
  });
  const t = ruText;
  const button = (name) => page.getByRole("button", { name, exact: true });
  try {
    await page.goto(`${origin}/settings`);
    await taskSurface(page, {
      name: t.settings.title,
      exact: true,
    }).waitFor();
    const fields = page.getByRole("spinbutton");
    assert.equal(await fields.count(), 5);
    await fields.last().fill("45");
    let fail = true;
    let settings;
    await page.route("**/api/settings", (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      settings = route.request().postDataJSON();
      return fail
        ? route.fulfill({
            status: 503,
            json: { detail: "Synthetic settings failure" },
          })
        : route.fulfill({ json: settings });
    });
    await button(t.common.actions.save).click();
    await page.getByText("Synthetic settings failure", { exact: true }).waitFor();
    assert.equal(await fields.last().inputValue(), "45");
    await viewportScreenshot(page, "navigation-settings-save-error.png");
    fail = false;
    await button(t.common.actions.save).click();
    await page.waitForURL("**/passwords");
    assert.equal(settings.clipboard_clear_ms, 45000);
    await page.goto(`${origin}/account/password`);
    await page.getByLabel(t.auth.currentPassword, { exact: true }).fill("Synthetic-current");
    const secret = "Synthetic-new-password!2026";
    await page.getByLabel(t.auth.newPassword, { exact: true }).fill(secret);
    await page.getByLabel(t.auth.confirmNewPassword, { exact: true }).fill(secret);
    await page.route("**/api/auth/password", (route) =>
      route.fulfill({
        json: {
          session_token: "synthetic-rotated-session",
          user: {
            id: 1,
            username: "synthetic",
            role: "admin",
            must_change_password: false,
          },
        },
      })
    );
    await button(t.auth.changePassword).click();
    await page.waitForURL("**/passwords");
    await fits(page);
    await axe(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const [width, language, theme] of [
  [375, "ru", "dark"],
  [320, "en", "light"],
  [1440, "ru", "dark"],
]) {
  test(`backup bottom actions stay reachable through validation, keyboard viewport and retry at ${width}px`, async () => {
    const t = language === "ru" ? ruText : enText;
    const { context, page, errors } = await vault(width, language, theme);
    let release;
    try {
      await page.goto(`${origin}/passwords?tool=backup`);
      const apply = page.getByRole("button", {
        name: t.backup.title,
        exact: true,
      });
      const close = page.getByRole("button", {
        name: t.common.actions.cancel,
        exact: true,
      });
      const field = page.getByLabel(t.auth.masterPassword, {
        exact: true,
      });
      const reachable = async () => {
        for (const control of [apply, close]) {
          await visibleTouchAction(page, control);
          assert.ok(
            await control.evaluate((node) => {
              const b = node.getBoundingClientRect();
              return node.contains(
                document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
              );
            })
          );
        }
      };
      const dock = page.locator('[data-qa="mobile-task-actions"]');
      await apply.waitFor();
      if (width < 600) {
        await dock.getByRole("button", { name: t.backup.title, exact: true }).waitFor();
        assert.equal(await page.locator('[data-qa="task-back"]').count(), 0);
        const bounds = await dock.boundingBox();
        assert.ok(Math.abs(bounds.y + bounds.height - 812) < 2);
        const scroll = await page.locator('[data-qa="page-scroll"]').boundingBox();
        assert.ok(scroll.y + scroll.height <= bounds.y);
      } else {
        assert.equal(await dock.count(), 0);
        await page
          .getByRole("dialog", { name: t.backup.title, exact: true })
          .getByRole("button", { name: t.backup.title, exact: true })
          .waitFor();
      }
      await viewportScreenshot(page, `backup-bottom-${width}-${language}-${theme}.png`);
      let requests = 0;
      await page.route("**/api/passwords/backup", async (route) => {
        requests++;
        assert.equal(route.request().method(), "POST");
        assert.deepEqual(route.request().postDataJSON(), {
          master_password: "Synthetic-only",
        });
        if (requests === 1) {
          await new Promise((resolve) => {
            release = resolve;
          });
          try {
            await route.fulfill({
              status: 422,
              json: { detail: t.errors.backupFailed },
            });
          } catch (error) {
            if (!/aborted|closed/i.test(String(error))) throw error;
          }
          return;
        }
        await route.fulfill(
          requests === 2
            ? {
                status: 422,
                json: { detail: t.errors.backupFailed },
              }
            : {
                contentType: "application/octet-stream",
                body: "synthetic-backup-test-only",
              }
        );
      });
      await apply.click();
      await page.getByText(t.backup.passwordRequired, { exact: true }).waitFor();
      assert.equal(requests, 0);
      await field.fill("Synthetic-only");
      if (width < 600) {
        // Model a keyboard changing only VisualViewport, not LayoutViewport.
        // This is not a claim of an actual Android/iOS keyboard test.
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, "height", {
            configurable: true,
            value: 400,
          });
          window.visualViewport.dispatchEvent(new Event("resize"));
        });
        await page.waitForFunction(() => {
          const b = document
            .querySelector('[data-qa="mobile-task-actions"]')
            .getBoundingClientRect();
          return Math.abs(b.bottom - 400) < 2;
        });
        await field.scrollIntoViewIfNeeded();
        await field.focus();
        await reachable();
        const fieldBounds = await field.boundingBox();
        const dockBounds = await dock.boundingBox();
        assert.ok(fieldBounds.y >= 0 && fieldBounds.y + fieldBounds.height <= dockBounds.y);
        await viewportScreenshot(page, `backup-bottom-${width}-visual-viewport.png`);
        await page.evaluate(() => {
          delete window.visualViewport.height;
          window.visualViewport.dispatchEvent(new Event("resize"));
        });
      }
      const request = page.waitForRequest("**/api/passwords/backup");
      await apply.click();
      await request;
      const cancelBackup = page.getByRole("button", {
        name: t.backup.cancel,
        exact: true,
      });
      await cancelBackup.waitFor();
      assert.equal(await apply.isDisabled(), true);
      assert.equal(await cancelBackup.isEnabled(), true);
      assert.equal(await close.count(), 0);
      await field.press("Enter");
      await field.press("Enter");
      assert.equal(requests, 1, "Enter cannot submit a second backup while loading");
      const aborted = page.waitForEvent(
        "requestfailed",
        (candidate) => new URL(candidate.url()).pathname === "/api/passwords/backup"
      );
      await cancelBackup.click();
      await aborted;
      release();
      await page.getByText(t.backup.cancelRequested, { exact: true }).waitFor();
      await close.waitFor();
      assert.equal(await page.getByText(t.errors.backupFailed, { exact: true }).count(), 0);
      assert.equal(await field.inputValue(), "Synthetic-only");
      assert.equal(new URL(page.url()).searchParams.get("tool"), "backup");
      assert.equal(
        await page.getByText(t.vault.messages.backupRequested, { exact: true }).count(),
        0
      );
      await reachable();
      const retry = page.waitForRequest("**/api/passwords/backup");
      await apply.click();
      await retry;
      await page.getByText(t.errors.backupFailed, { exact: true }).waitFor();
      assert.equal(await field.inputValue(), "Synthetic-only");
      await reachable();
      await fits(page);
      await axe(page);
      const download = page.waitForEvent("download");
      await apply.click();
      assert.match((await download).suggestedFilename(), /\.cmbackup$/);
      await page.waitForURL("**/passwords");
      assert.equal(requests, 3);
      if (width < 600) {
        await dock.locator("button").first().waitFor({ state: "detached" });
        assert.equal(await dock.locator("button").count(), 0);
      }
      // Re-enter while the success notification is still visible, then cancel.
      await page.evaluate(() => {
        history.pushState({}, "", "/passwords?tool=backup");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await apply.waitFor();
      await reachable();
      await viewportScreenshot(page, `backup-bottom-${width}-notification.png`);
      await close.click();
      await page.waitForURL("**/passwords");
      if (width < 600) {
        await dock.locator("button").first().waitFor({ state: "detached" });
        assert.equal(await dock.locator("button").count(), 0);
      }
      assert.deepEqual(errors, []);
    } finally {
      release?.();
      await context.close();
    }
  });
}

for (const [width, height, theme] of [
  [375, 812, "dark"],
  [375, 480, "dark"],
  [320, 812, "light"],
]) {
  test(`phone feedback reserves space after double copy and during editing ${width}x${height} ${theme}`, async () => {
    const t = ruText;
    const { context, page, errors } = await vault(width, "ru", theme);
    const button = (name) => page.getByRole("button", { name, exact: true });
    try {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/passwords?entry=1&view=details`);
      await button(t.vault.columns.copyPassword).click();
      await button(t.vault.columns.copyPassword).click();
      await feedbackDoesNotCover(
        page,
        button(t.vault.columns.copyPassword),
        button(t.common.actions.edit)
      );
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        entries[0].password_value
      );
      await viewportScreenshot(page, `feedback-${width}x${height}-${theme}-double-copy.png`);
      await button(t.common.actions.edit).click();
      await page
        .getByLabel(t.entry.labels.usernameOptional, { exact: true })
        .fill("feedback@example.test");
      await feedbackDoesNotCover(
        page,
        button(t.common.actions.update),
        button(t.common.actions.cancel)
      );
      await viewportScreenshot(page, `feedback-${width}x${height}-${theme}-edit-actions.png`);
      await fits(page);
      await axe(page);
      await button(t.common.actions.cancel).click();
      await page.waitForURL("**/passwords?entry=1&view=details");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("phone management tasks exercise folder, group, share and recovery actions", async () => {
  const t = ruText;
  const users = [
    { id: 1, username: "synthetic", role: "admin", active: true },
    { id: 2, username: "team-member", role: "member", active: true },
  ];
  const groups = [{ id: 10, name: "Operations", member_count: 0 }];
  const members = [];
  const shares = [];
  const folders = [
    {
      id: 1,
      name: "Work",
      owner_id: 1,
      owner_username: "synthetic",
      access: "owner",
      can_manage: true,
    },
  ];
  const { context, page, errors } = await vault(375, "ru", "dark", entries, {
    role: "admin",
    users,
    groups,
    groupMembers: members,
    shares,
    shareTargets: [users[1]],
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const capture = async (state) => {
    await fits(page);
    await axe(page);
    await viewportScreenshot(page, `management-375-ru-dark-${state}.png`);
  };
  const writes = [];
  try {
    await page.route(/\/api\/folders(?:\/\d+)?$/, async (route) => {
      const request = route.request();
      const method = request.method();
      if (method === "GET") return route.fulfill({ json: folders });
      writes.push({ path: new URL(request.url()).pathname, method });
      if (method === "POST")
        folders.push({
          ...folders[0],
          id: 9,
          name: request.postDataJSON().name,
        });
      if (method === "PATCH")
        folders.find((folder) => folder.id === 9).name = request.postDataJSON().name;
      if (method === "DELETE")
        folders.splice(
          folders.findIndex((folder) => folder.id === 9),
          1
        );
      return route.fulfill({ json: { id: 9 } });
    });
    await page.goto(`${origin}/passwords?tool=folders`);
    await button(t.folderAccess.createFolder).click();
    await page
      .getByRole("textbox", { name: t.common.fields.name, exact: true })
      .fill("Synthetic folder");
    await capture("folder-create-expanded");
    await button(t.common.actions.create).click();
    await page
      .getByRole("combobox", {
        name: t.common.fields.folder,
        exact: true,
      })
      .click();
    await page.getByRole("option", { name: /^Synthetic folder/ }).click();
    await button(t.folderAccess.rename).click();
    await page
      .getByRole("textbox", { name: t.folderAccess.rename, exact: true })
      .fill("Renamed synthetic folder");
    await capture("folder-rename-expanded");
    await button(t.common.actions.save).click();
    await page
      .getByRole("heading", {
        name: "Renamed synthetic folder",
        exact: true,
      })
      .waitFor();
    await feedbackDoesNotCover(page, button(t.common.actions.delete));
    await button(t.common.actions.delete).click();
    const confirmation = page.getByRole("dialog");
    assert.equal(await confirmation.count(), 1);
    await feedbackDoesNotCover(
      page,
      confirmation.getByRole("button", {
        name: t.common.actions.delete,
        exact: true,
      }),
      confirmation.getByRole("button", {
        name: t.common.actions.cancel,
        exact: true,
      })
    );
    await capture("folder-delete-confirm");
    await confirmation.getByRole("button", { name: t.common.actions.delete, exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    assert.equal(folders.length, 1);
    await page.route(/\/api\/groups(?:\/\d+)?$/, (route) => {
      const request = route.request();
      const method = request.method();
      if (method === "GET") return route.fulfill({ json: groups });
      writes.push({ path: new URL(request.url()).pathname, method });
      if (method === "POST")
        groups.push({
          id: 11,
          name: request.postDataJSON().name,
          member_count: 0,
        });
      if (method === "PATCH")
        groups.find((group) => group.id === 11).name = request.postDataJSON().name;
      if (method === "DELETE")
        groups.splice(
          groups.findIndex((group) => group.id === 11),
          1
        );
      return route.fulfill({ json: { id: 11 } });
    });
    await page.route("**/api/groups/11/members/2", (route) => {
      const method = route.request().method();
      writes.push({ path: "/api/groups/11/members/2", method });
      if (method === "PUT")
        members.push({
          user_id: 2,
          username: "team-member",
          role: "member",
        });
      else members.splice(0);
      return route.fulfill({ json: {} });
    });
    await page.goto(`${origin}/users?view=groups`);
    await button(t.groups.create).click();
    await page.getByRole("textbox", { name: t.groups.name, exact: true }).fill("Synthetic group");
    await capture("group-create-expanded");
    await button(t.common.actions.create).click();
    await page.getByRole("combobox", { name: t.groups.group, exact: true }).click();
    await page.getByRole("option", { name: "Synthetic group", exact: true }).click();
    await page
      .getByRole("textbox", { name: t.groups.rename, exact: true })
      .fill("Renamed synthetic group");
    await button(t.common.actions.save).click();
    await page.getByRole("combobox", { name: t.groups.addMember, exact: true }).click();
    await page.getByRole("option", { name: /^team-member/ }).click();
    await button(t.common.actions.add).click();
    await taskSurface(page, { name: t.groups.title, exact: true })
      .getByText("team-member", { exact: true })
      .waitFor();
    // Successful add clears the selection (and disables Add). Select the
    // next available user to exercise the next enabled action, not a disabled hit target.
    await page.getByRole("combobox", { name: t.groups.addMember, exact: true }).click();
    await page.getByRole("option", { name: /^synthetic/ }).click();
    await feedbackDoesNotCover(
      page,
      button(t.common.actions.add),
      button(t.common.actions.delete).first(),
      button(t.common.actions.remove).last()
    );
    await capture("group-member-added");
    await taskSurface(page, { name: t.groups.title, exact: true })
      .getByText("team-member", { exact: true })
      .locator("..")
      .locator("..")
      .getByRole("button", { name: t.common.actions.remove, exact: true })
      .click();
    await page.getByText(t.groups.noMembers, { exact: true }).waitFor();
    await button(t.common.actions.delete).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: t.common.actions.delete, exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(groups.length, 1);
    await page.route("**/api/passwords/1/shares/2", (route) => {
      const request = route.request();
      const method = request.method();
      writes.push({ path: "/api/passwords/1/shares/2", method });
      if (method === "PUT")
        shares.push({
          user_id: 2,
          username: "team-member",
          role: "member",
          ...request.postDataJSON(),
        });
      else shares.splice(0);
      return route.fulfill({ json: {} });
    });
    await page.goto(`${origin}/passwords?entry=1&view=share`);
    await page.getByRole("combobox", { name: t.sharing.user, exact: true }).click();
    await page.getByRole("option", { name: /^team-member/ }).click();
    await button(t.sharing.grant).click();
    await page.getByText("team-member", { exact: true }).waitFor();
    await capture("share-added");
    await button(t.sharing.revoke).click();
    await page.getByText(t.sharing.ownerOnly, { exact: true }).waitFor();
    assert.equal(shares.length, 0);
    await page.route("**/api/passwords", (route) =>
      route.fulfill({
        json: entries.map((entry) => (entry.id === 2 ? { ...entry, password_value: "x" } : entry)),
      })
    );
    await page.goto(`${origin}/passwords?tool=health`);
    await page
      .locator('[data-qa="health-issue-group"]')
      .getByRole("button")
      .filter({ hasText: "Read-only account" })
      .first()
      .click();
    await page.waitForURL("**/passwords?entry=2&view=details");
    assert.equal(await button(t.common.actions.edit).count(), 0);
    await page.goBack();
    await page.waitForURL("**/passwords?tool=health");
    await capture("health-return");
    let restored = false;
    await page.route("**/api/passwords/trash", (route) =>
      restored ? route.fulfill({ json: [] }) : route.fallback()
    );
    await page.route(/\/api\/passwords\/[^/]+\/restore\?entry_id=11$/, (route) => {
      assert.equal(route.request().method(), "POST");
      restored = true;
      return route.fulfill({ json: {} });
    });
    await page.goto(`${origin}/passwords?tool=trash`);
    await page
      .getByRole("button", {
        name: new RegExp(`^${t.trashDialog.restore}:`),
      })
      .click();
    await page.getByText(t.trashDialog.empty, { exact: true }).waitFor();
    assert.equal(restored, true, "restore submitted the selected trash entry ID");
    await capture("trash-restored-empty");
    assert.ok(writes.some((write) => write.path === "/api/folders/9" && write.method === "DELETE"));
    assert.ok(
      writes.some((write) => write.path === "/api/groups/11/members/2" && write.method === "DELETE")
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("phone management request errors expose retry instead of false empty states", async () => {
  const t = ruText;
  const { context, page, errors } = await vault(375, "ru", "dark", entries, {
    role: "admin",
  });
  try {
    for (const [path, routePath, emptyText] of [
      ["users", "/users", t.users.empty],
      ["users", "/users?view=access&user=1", t.users.empty],
      ["groups", "/users?view=groups", t.groups.empty],
      ["folders", "/passwords?tool=folders", t.folderAccess.empty],
      ["users/1/folder-access", "/users?view=access&user=1", t.folderAccess.empty],
    ]) {
      let fail = true;
      await page.route(`**/api/${path}`, (route) =>
        fail
          ? route.fulfill({
              status: 503,
              json: { detail: "Synthetic management load failure" },
            })
          : route.fallback()
      );
      await page.goto(`${origin}${routePath}`);
      await page
        .getByText("Synthetic management load failure", { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      assert.equal(await page.getByText(emptyText, { exact: true }).count(), 0);
      await fits(page);
      await axe(page);
      await viewportScreenshot(
        page,
        `management-error-${path.replaceAll("/", "-")}${path === "users" && routePath.includes("view=") ? "-direct-access" : ""}.png`
      );
      fail = false;
      await page
        .getByRole("button", {
          name: t.common.actions.retry,
          exact: true,
        })
        .click();
      await page
        .getByText("Synthetic management load failure", { exact: true })
        .filter({ visible: true })
        .waitFor({ state: "hidden" });
    }
    await page.goto(`${origin}/users?view=access&user=999`);
    await page.getByText(t.users.unavailable, { exact: true }).waitFor();
    await fits(page);
    await axe(page);
    await viewportScreenshot(page, "management-375-ru-dark-user-unavailable.png");
    await page.locator('[data-qa="task-back"]').click();
    await page.waitForURL("**/users");
    await page.locator('[data-qa="user-card"]').first().waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const width of [375, 1440]) {
  test(`complete peer disclosures and note submission at ${width}px`, async () => {
    const t = ruText;
    const { context, page, errors } = await vault(width, "ru", "dark");
    const button = (name) => page.getByRole("button", { name, exact: true });
    const capture = async (state) => {
      await fits(page);
      await axe(page);
      await captureMatrixState(page, `supplement-${width}-ru-dark-${state}`);
    };
    try {
      await button(t.common.actions.add).click();
      const sections = [
        t.entry.labels.twoFactor,
        t.common.fields.tags,
        t.entry.labels.customFields,
        t.entry.labels.notes,
      ];
      for (const name of sections) {
        assert.equal(await button(name).getAttribute("aria-expanded"), "false");
        await button(name).click();
      }
      await page.getByLabel(t.common.fields.name, { exact: true }).fill("Synthetic complete entry");
      await page
        .getByRole("textbox", {
          name: t.common.fields.password,
          exact: true,
        })
        .fill("Synthetic-complete!2026");
      await page
        .getByLabel(t.entry.labels.twoFactorSecret, { exact: true })
        .fill(entries[0].totp_secret);
      await page
        .getByRole("textbox", {
          name: t.common.fields.tags,
          exact: true,
        })
        .fill("работа, личное");
      await button(t.entry.actions.addField).click();
      await page
        .getByLabel(t.entry.labels.label, { exact: true })
        .fill("Длинное название дополнительного поля");
      await page.getByLabel(t.entry.labels.value, { exact: true }).fill("Synthetic-custom-value");
      await page
        .getByLabel(t.common.fields.description, { exact: true })
        .fill("Длинное примечание для проверки мобильной формы. ".repeat(6));
      await capture("all-peers-expanded");
      for (const name of sections) {
        await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
      }
      await capture("all-peers-collapsed-filled");
      const submissions = [];
      await page.route("**/api/passwords/create", (route) => {
        submissions.push(route.request().postDataJSON());
        return route.fulfill({ json: {} });
      });
      await button(t.common.actions.create).click();
      await taskSurface(page).waitFor({ state: "hidden" });
      assert.equal(submissions[0].totp_secret, entries[0].totp_secret);
      assert.deepEqual(submissions[0].tags, ["работа", "личное"]);
      assert.equal(submissions[0].custom_fields[0].value, "Synthetic-custom-value");
      await button(t.common.actions.add).click();
      await page.getByRole("radio", { name: t.entry.labels.note, exact: true }).check();
      await page.getByLabel(t.common.fields.name, { exact: true }).fill("Synthetic submitted note");
      await page
        .getByRole("textbox", {
          name: t.entry.labels.note,
          exact: true,
        })
        .fill("Synthetic note content\nSecond line");
      await capture("note-filled");
      await button(t.common.actions.create).click();
      await taskSurface(page).waitFor({ state: "hidden" });
      assert.equal(submissions[1].kind, "note");
      assert.equal(submissions[1].password_value, "Synthetic note content\nSecond line");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test("phone uncommon states keep management-only access, encrypted import recovery and purge retry usable", async () => {
  const t = ruText;
  const { context, page, errors } = await vault(375, "ru", "dark", entries, {
    role: "admin",
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const capture = async (state) => {
    await fits(page);
    await axe(page);
    await captureMatrixState(page, `supplement-375-ru-dark-${state}`);
  };
  try {
    await page.route("**/api/folders", (route) =>
      route.fulfill({
        json: [
          {
            id: 1,
            name: "Management only",
            owner_id: 2,
            owner_username: "owner",
            access: null,
            can_manage: true,
          },
        ],
      })
    );
    await page.goto(`${origin}/passwords?tool=folders`);
    await page.getByText(t.folderAccess.managementOnly, { exact: true }).waitFor();
    assert.equal(await button(t.folderAccess.rename).count(), 0);
    await page.getByRole("combobox", { name: t.folderAccess.target, exact: true }).waitFor();
    await capture("folder-management-only");
    await page.route("**/api/passwords", (route) =>
      route.fulfill({
        json: [{ ...entries[0], updated: new Date().toISOString() }],
      })
    );
    await page.goto(`${origin}/passwords?tool=health`);
    await page.getByText(t.health.allClear, { exact: true }).waitFor();
    await capture("health-all-clear");
    await page.route("**/api/users", (route) => route.fulfill({ json: [] }));
    await page.goto(`${origin}/users`);
    await page.getByText(t.users.empty, { exact: true }).waitFor();
    await capture("users-empty");
    await page.goto(`${origin}/passwords?tool=import`);
    await page.locator('input[type="file"]').setInputFiles({
      name: "Synthetic.cmbackup",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("synthetic UI fixture only"),
    });
    await page
      .getByLabel(t.importDialog.backupPassword, { exact: true })
      .fill("Synthetic-password-only");
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let fail = true;
    await page.route("**/api/passwords/import", async (route) => {
      await pending;
      return route.fulfill(
        fail
          ? {
              status: 422,
              json: {
                detail: "Synthetic encrypted import failure",
              },
            }
          : { json: { total: 1, imported: 1 } }
      );
    });
    const request = page.waitForRequest("**/api/passwords/import");
    await button(t.common.actions.import).click();
    await request;
    assert.equal(await button(t.common.actions.import).isDisabled(), true);
    await capture("encrypted-import-busy");
    release();
    await page.getByText("Synthetic encrypted import failure", { exact: true }).waitFor();
    await capture("encrypted-import-error");
    fail = false;
    await button(t.common.actions.import).click();
    await taskSurface(page, {
      name: t.importDialog.completeTitle,
      exact: true,
    }).waitFor();
    await capture("encrypted-import-recovered");
    let purged = false;
    let purgeFail = true;
    let purgeRequests = 0;
    await page.route("**/api/passwords/trash", (route) =>
      purged ? route.fulfill({ json: [] }) : route.fallback()
    );
    await page.route(/\/api\/passwords\/[^/]+\/purge\?entry_id=11$/, (route) => {
      purgeRequests++;
      assert.equal(route.request().method(), "DELETE");
      if (purgeFail)
        return route.fulfill({
          status: 503,
          json: { detail: "Synthetic purge failure" },
        });
      purged = true;
      return route.fulfill({ json: {} });
    });
    await page.goto(`${origin}/passwords?tool=trash`);
    await page
      .getByRole("button", {
        name: new RegExp(`^${t.trashDialog.deleteForever}:`),
      })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: t.trashDialog.deleteForeverTitle,
      exact: true,
    });
    await confirmation
      .getByRole("button", {
        name: t.trashDialog.deleteForever,
        exact: true,
      })
      .click();
    await page.getByText(t.trashDialog.purgeFailed, { exact: true }).waitFor();
    await capture("purge-retry");
    purgeFail = false;
    await confirmation.getByRole("button", { name: t.common.actions.retry, exact: true }).click();
    await confirmation.waitFor({ state: "hidden" });
    await page.getByText(t.trashDialog.empty, { exact: true }).waitFor();
    assert.equal(purgeRequests, 2);
    await capture("purge-recovered-empty");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("console errors stay absent across final phone task routes", async () => {
  const { context, page, errors } = await vault(375, "ru", "dark", entries, {
    role: "admin",
    updateAvailable: true,
    users: [{ id: 1, username: "synthetic", role: "admin", active: true }],
  });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    for (const path of [
      "/passwords",
      "/passwords?entry=1&view=details",
      "/passwords?entry=1&view=edit",
      "/passwords?entry=1&view=share",
      "/entries/new",
      "/passwords?tool=folders",
      "/passwords?tool=backup",
      "/passwords?tool=import",
      "/passwords?tool=health",
      "/passwords?tool=trash",
      "/settings",
      "/account/password",
      "/updates",
      "/users",
      "/users?view=create",
      "/users?view=groups",
      "/users?view=access&user=1",
    ]) {
      await page.goto(`${origin}${path}`);
      await page.waitForLoadState("networkidle");
      assert.deepEqual(consoleErrors, [], path);
      assert.deepEqual(errors, [], path);
    }
  } finally {
    await context.close();
  }
});

// Opt-in visual matrix uses exactly the synthetic API/session fixture above.
// No backend, native runtime, real unlock, or external service is involved.
async function captureMatrixState(page, prefix) {
  // Disclosures may scroll more than the body (e.g. a mobile Dialog's root).
  // Capture the real top and every scroll owner rather than assuming one CSS node.
  const owners = await page.evaluate(() => {
    const foreground = [...document.querySelectorAll('[role="dialog"]')]
      .filter((node) => !node.closest('[aria-hidden="true"]'))
      .at(-1);
    window.__matrixScrollOwners = [...document.querySelectorAll("body *")].filter((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        !node.closest('[aria-hidden="true"]') &&
        (!foreground || foreground.contains(node) || node.contains(foreground)) &&
        node.scrollHeight > node.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)
      );
    });
    window.__matrixScrollOwners.forEach((node) => {
      node.scrollTop = 0;
    });
    if (!document.querySelector('[role="dialog"]')) window.scrollTo(0, 0);
    return window.__matrixScrollOwners.map((node) =>
      Math.ceil((node.scrollHeight - node.clientHeight) / Math.max(1, node.clientHeight * 0.75))
    );
  });
  const images = [`${prefix}.png`];
  await viewportScreenshot(page, images[0]);
  for (let index = 0; index < owners.length; index++) {
    for (let step = 1; step <= owners[index]; step++) {
      await page.evaluate(
        ({ index, step }) => {
          const node = window.__matrixScrollOwners[index];
          node.scrollTop = node.clientHeight * 0.75 * step;
        },
        { index, step }
      );
      const name = `${prefix}-owner-${index}-scroll-${step}.png`;
      images.push(name);
      await viewportScreenshot(page, name);
    }
    await page.evaluate((index) => {
      window.__matrixScrollOwners[index].scrollTop = 0;
    }, index);
  }
  if (
    !(await page.getByRole("dialog").count()) &&
    !(await page.getByRole("menu").count()) &&
    (await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1))
  ) {
    const name = `${prefix}-full.png`;
    images.push(name);
    await screenshot(page, name);
  }
  return images;
}
registerBottomActionChecks({
  vault,
  entries,
  fits,
  axe,
  settleAnimations,
  viewportScreenshot,
  enText,
  ruText,
});

if (process.env.CIPHERMOTH_LAYOUT_MATRIX) {
  const combinations =
    process.env.CIPHERMOTH_LAYOUT_MATRIX === "baseline"
      ? [
          [375, "ru", "dark"],
          [1440, "en", "light"],
        ]
      : process.env.CIPHERMOTH_LAYOUT_MATRIX === "final"
        ? [320, 375, 768, 1440].flatMap((width) => [
            [width, "ru", "dark"],
            [width, "en", "light"],
          ])
        : [320, 375, 768, 1440].flatMap((width) =>
            ["ru", "en"].flatMap((language) =>
              ["light", "dark"].map((theme) => [width, language, theme])
            )
          );
  for (const [width, language, theme] of combinations) {
    test(`composition matrix ${width} ${language} ${theme}`, async () => {
      const t = language === "ru" ? ruText : enText;
      const options = {
        role: "admin",
        updateAvailable: true,
        users: [
          {
            id: 1,
            username: "synthetic",
            role: "admin",
            active: true,
          },
          {
            id: 2,
            username: "team-member",
            role: "member",
            active: true,
          },
          {
            id: 3,
            username: "automation",
            role: "service",
            active: false,
          },
        ],
        groups: [{ id: 10, name: "Operations", member_count: 1 }],
        groupMembers: [{ user_id: 2, username: "team-member", role: "member" }],
        shareTargets: [
          { id: 4, username: "auditor", role: "member" },
          { id: 2, username: "team-member", role: "member" },
        ],
        groupAudit: [
          {
            id: 1,
            created: "2026-10-27T12:00:00Z",
            actor_username: "synthetic",
            action: "group_created",
          },
        ],
        folderAudit: [
          {
            id: 1,
            created: "2026-10-27T12:00:00Z",
            actor_username: "synthetic",
            action: "folder_created",
          },
        ],
        folderGrants: [
          {
            target_type: "group",
            target_id: 10,
            target_name: "Operations",
            permission: "read",
            expires_at: null,
          },
        ],
        userFolderAccess: [
          {
            folder: {
              id: 1,
              name: "Work",
              owner_id: 1,
              owner_username: "synthetic",
              can_manage: true,
            },
            direct_permission: null,
            direct_expires_at: null,
            effective_permission: null,
            sources: [],
          },
        ],
      };
      const { context, page, errors } = await vault(
        width,
        language,
        theme,
        entries.map((entry) =>
          entry.id === 1
            ? {
                ...entry,
                attachment_count: 1,
                password_history: [
                  {
                    changed_at: "2026-09-01T12:00:00Z",
                    value: "Synthetic-old-secret",
                  },
                ],
              }
            : entry
        ),
        options
      );
      const metrics = [];
      const prefix = `matrix-${width}-${language}-${theme}`;
      const capture = async (name) => {
        await page.evaluate(() => document.fonts.ready);
        await settleAnimations(page);
        await fits(page);
        // Dialogs and drawers are viewport overlays. A full-page capture
        // stitches fixed layers over scrolled content and invents visual
        // overlaps that are not present in the rendered viewport.
        const images = await captureMatrixState(page, `${prefix}-${name}`);
        metrics.push({
          state: name,
          images,
          language,
          theme,
          route: new URL(page.url()).pathname + new URL(page.url()).search,
          ...(await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => ({
              name: node.getAttribute("aria-label"),
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
            })),
          }))),
        });
      };
      const button = (name) => page.getByRole("button", { name, exact: true });
      const dismiss = async () => {
        await leaveSurface(page);
      };
      const utility = async (name) => {
        if (width < 1080) await button(t.navigation.more).click();
        // Utility rows have the same native List view as primary navigation.
        await page.getByText(name, { exact: true }).click();
      };
      try {
        await capture("vault");
        const search = page.getByPlaceholder(t.vault.searchPlaceholder);
        await search.fill("no-synthetic-match");
        await capture("no-results");
        await button(t.vault.resetFilters).click();
        assert.equal(
          await page.locator('[data-qa="entry-list"]').getByRole("row").count(),
          entries.length
        );
        if (width < 1080) {
          await button(t.navigation.more).click();
          await capture("drawer");
          if (process.env.CIPHERMOTH_LAYOUT_MATRIX !== "baseline") {
            for (const height of [480, 900]) {
              await page.setViewportSize({ width, height });
              await page.waitForTimeout(300);
              const geometry = await page
                .locator('[data-qa="navigation-shell"]')
                .evaluate((shell) => {
                  const rect = (name) => {
                    const r = shell.querySelector(`[data-qa="${name}"]`).getBoundingClientRect();
                    return {
                      top: r.top,
                      bottom: r.bottom,
                      height: r.height,
                    };
                  };
                  return {
                    header: rect("navigation-header"),
                    body: rect("navigation-body"),
                    footer: rect("navigation-footer"),
                    height: innerHeight,
                    preferences: (() => {
                      const preferences = shell.querySelector('[data-qa="navigation-preferences"]');
                      const buttons = [...preferences.querySelectorAll("button")];
                      const logout = shell.querySelector('[data-qa="navigation-footer"] > button');

                      return {
                        width: preferences.getBoundingClientRect().width,
                        buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
                        buttonRects: buttons.map((button) => {
                          const rect = button.getBoundingClientRect();
                          return {
                            top: rect.top,
                            bottom: rect.bottom,
                          };
                        }),

                        logoutWidth: logout.getBoundingClientRect().width,
                      };
                    })(),
                    controls: [
                      ...shell.querySelectorAll('[data-qa="navigation-preferences"] button'),
                    ].map((node) => node.getBoundingClientRect().height),
                  };
                });
              assert.ok(geometry.header.bottom <= geometry.body.top + 1);
              assert.ok(geometry.body.height > 100, "navigation owns the available scroll area");
              // Every drawer (<1080), including tablet, uses one
              // scroll owner for destinations, utilities and account.
              assert.ok(Math.abs(geometry.body.bottom - height) <= 1, JSON.stringify(geometry));
              assert.equal(
                await page
                  .locator('[data-qa="navigation-body"]')
                  .evaluate((body) =>
                    body.contains(body.querySelector('[data-qa="navigation-footer"]'))
                  ),
                true
              );
              for (const name of [t.language.label, t.theme.label, t.auth.logOut]) {
                const action = page.getByRole("button", {
                  name: new RegExp(`^${name}`),
                });
                await action.scrollIntoViewIfNeeded();
                await visibleTouchAction(page, action);
              }
              // A scrolled footer must not strand the destinations.
              const firstDestination = page.locator('a[data-navigation-id="/passwords"]');
              await firstDestination.scrollIntoViewIfNeeded();
              await visibleTouchAction(page, firstDestination);
              assert.ok(geometry.controls.every((height) => height >= 44));
              assert.ok(
                geometry.preferences.buttonRects[0].bottom <=
                  geometry.preferences.buttonRects[1].top,
                JSON.stringify(geometry.preferences)
              );

              metrics.push({
                state: `drawer-${height}`,
                ...geometry,
              });
              await capture(`drawer-${height}`);
            }
          }
          await dismiss();
          await page.setViewportSize({
            width,
            height: width < 600 ? 812 : 900,
          });
        }
        const list = page.locator('[data-qa="entry-list"]');
        const longRow = list.getByRole("row").filter({ hasText: entries[3].password_name });
        await longRow.scrollIntoViewIfNeeded();
        const wrappedValues = await longRow.evaluate((row) => {
          const measure = (qa) => {
            const node = row.querySelector(`[data-qa="${qa}"]`);
            const bounds = node.getBoundingClientRect();
            return {
              height: bounds.height,
              lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
            };
          };
          return {
            name: measure("entry-name"),
            primaryValue: measure("entry-primary-value"),
          };
        });
        for (const value of Object.values(wrappedValues)) {
          if (width < 576)
            assert.ok(
              value.height <= value.lineHeight * 2 + 1,
              "phone summary is at most two lines; full value is in details"
            );
          else assert.ok(value.scrollWidth <= value.clientWidth + 1, JSON.stringify(wrappedValues));
        }
        for (const [name, state] of [
          ["GitHub", "details"],
          ["Read-only account", "readonly"],
          ["Recovery notes", "note"],
          [entries[3].password_name, "long-details"],
        ]) {
          await list
            .getByRole("row")
            .filter({ hasText: name })
            .click({ position: { x: 24, y: 24 } });
          await capture(state);
          await leaveSurface(page);
        }
        await list.getByRole("row").filter({ hasText: "GitHub" }).click();
        await button(t.sharing.manage).click();
        await capture("share");
        await dismiss();
        await leaveSurface(page);
        await list.getByRole("row").filter({ hasText: "GitHub" }).click();
        await button(t.common.actions.delete).click();
        await button(t.vault.moveToTrash.action).waitFor();
        await capture("delete-confirm");
        await dismiss();
        await leaveSurface(page);
        for (const tool of ["backup", "health", "trash", "folders", "import"]) {
          await page.goto(`${origin}/passwords?tool=${tool}`);
          await taskSurface(page).waitFor();
          await capture(tool);
          if (tool === "trash") {
            await page
              .getByRole("button", {
                name: /^(Удалить навсегда|Delete forever):/,
              })
              .click();
            await capture("purge-confirm");
            await page.keyboard.press("Escape");
          }
          await dismiss();
        }
        await utility(t.topMenu.settings);
        await capture("settings");
        await taskSurface(page).getByRole("spinbutton").first().fill("0");
        await button(t.common.actions.save).click();
        await capture("settings-validation");
        await dismiss();
        await utility(t.auth.changePassword);
        await capture("change-password");
        await page.getByLabel(t.auth.currentPassword, { exact: true }).fill("Synthetic-current");
        await page
          .getByLabel(t.auth.newPassword, { exact: true })
          .fill("Synthetic-new-Password!2026");
        await page.getByLabel(t.auth.confirmNewPassword, { exact: true }).fill("Mismatch");
        await button(t.auth.changePassword).click();
        await capture("change-password-validation");
        await dismiss();
        await utility(t.common.actions.update);
        await capture("updates");
        await dismiss();
        await button(t.common.actions.add).click();
        await capture("editor");
        await button(t.entry.actions.generatePassword).click();
        await capture("generator");
        await button(t.generator.regenerate).click();
        const slider = page.getByRole("slider").first();
        await slider.focus();
        await page.keyboard.press("ArrowRight");
        await capture("generator-strength");
        await button(t.common.actions.cancel).click();
        await button(t.common.actions.add).click();
        await page
          .getByRole("radio", {
            name: t.entry.labels.note,
            exact: true,
          })
          .check();
        await capture("create-note");
        await button(t.common.actions.cancel).click();
        for (const [entryName, state] of [
          ["GitHub", "edit-login"],
          ["Recovery notes", "edit-note"],
        ]) {
          await page
            .locator('[data-qa="entry-list"]')
            .getByRole("row")
            .filter({ hasText: entryName })
            .click();
          await button(t.common.actions.edit).click();
          const editor = taskSurface(page, {
            name: state === "edit-login" ? t.entry.title.editPassword : t.entry.title.editNote,
            exact: true,
          });
          await editor.waitFor();
          if (state === "edit-login") {
            await editor
              .getByRole("button", {
                name: new RegExp(`^${t.entry.labels.passwordHistory}`),
              })
              .click();
            await editor.getByText("Readme.txt", { exact: true }).waitFor();
            await editor
              .getByRole("button", {
                name: t.entry.labels.notes,
                exact: true,
              })
              .click();
          }
          await capture(state);
          if (state === "edit-login") {
            await editor
              .getByRole("button", {
                name: t.attachments.removeFile,
                exact: true,
              })
              .click();
            await capture("attachment-delete-confirm");
            await page
              .getByRole("dialog", {
                name: t.attachments.removeTitle,
                exact: true,
              })
              .getByRole("button", {
                name: t.common.actions.cancel,
                exact: true,
              })
              .click();
            await page
              .getByRole("dialog", {
                name: t.attachments.removeTitle,
                exact: true,
              })
              .waitFor({ state: "hidden" });
          }
          await button(t.common.actions.cancel).click();
          await editor.waitFor({ state: "hidden" });
          await leaveSurface(page);
        }
        await page.goto(`${origin}/users`);
        await page.getByText("team-member", { exact: true }).waitFor();
        const clippedAccounts = await page
          .locator('[data-qa="user-card"], [data-qa="user-role-control"]')
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.scrollWidth > node.clientWidth + 1)
              .map((node) => node.textContent)
          );
        assert.deepEqual(clippedAccounts, []);
        await capture("users");
        await button(t.groups.title).click();
        await taskSurface(page).getByText("team-member", { exact: true }).waitFor();
        await capture("groups");
        await dismiss();
        await button(`${t.navigation.more}: team-member`).click();
        await page
          .getByRole("menuitem", {
            name: t.folderAccess.manage,
            exact: true,
          })
          .click();
        await taskSurface(page).getByText("Work", { exact: true }).waitFor();
        await capture("user-acl");
        await dismiss();
        await button(`${t.navigation.more}: team-member`).click();
        await page
          .getByRole("menuitem", {
            name: t.users.resetPassword,
            exact: true,
          })
          .click();
        await capture("reset-password");
        await dismiss();
        await page.route("**/api/passwords", (route) => route.fulfill({ json: [] }));
        await page.goto(`${origin}/passwords`);
        await page.getByText(t.vault.emptyTitle, { exact: true }).first().waitFor();
        await capture("empty");
        assert.equal(
          await page
            .getByRole("button", {
              name: t.common.actions.add,
              exact: true,
            })
            .count(),
          0
        );
        await page.route("**/api/passwords", (route) =>
          route.fulfill({
            status: 503,
            json: { detail: "Synthetic UI request failure" },
          })
        );
        await page.reload();
        await page.getByText("Synthetic UI request failure", { exact: false }).first().waitFor();
        await capture("error");
        assert.equal(await page.getByText(t.vault.emptyTitle, { exact: true }).count(), 0);
        await page.route("**/api/passwords", (route) => route.fulfill({ json: entries }));
        await button(t.common.actions.retry).click();
        await page.locator('[data-qa="entry-list"]').waitFor();
        await capture("retry-recovered");
        assert.deepEqual(errors, []);
      } finally {
        if (process.env.CIPHERMOTH_SCREENSHOT_DIR)
          await writeFile(
            resolve(process.env.CIPHERMOTH_SCREENSHOT_DIR, `${prefix}-metrics.json`),
            JSON.stringify(metrics, null, 2)
          );
        await context.close();
      }
    });
  }

  // Additional states use the same shipped app and intercepted fixture. They
  // protect long labels, request/empty distinctions and secondary form owners.
  for (const width of [320, 375, 768, 1440])
    for (const [language, theme] of [
      ["ru", "dark"],
      ["en", "light"],
    ]) {
      test(`extended matrix ${width} ${language} ${theme}`, async () => {
        const t = language === "ru" ? ruText : enText;
        const users = [
          {
            id: 1,
            username: "synthetic",
            role: "admin",
            active: true,
          },
          {
            id: 2,
            username: "team-member",
            role: "member",
            active: true,
            must_change_password: true,
          },
          {
            id: 3,
            username: "automation",
            role: "service",
            active: false,
          },
        ];
        const records = entries.map((entry) =>
          entry.id === 1
            ? {
                ...entry,
                attachment_count: 1,
                password_history: [
                  {
                    changed_at: "2026-09-01T12:00:00Z",
                    value: "Synthetic-old-secret",
                  },
                ],
              }
            : entry
        );
        const { context, page, errors } = await vault(width, language, theme, records, {
          role: "admin",
          users,
          shares: [
            {
              user_id: 2,
              username: "team-member",
              role: "member",
              permission: "read",
            },
          ],
          userFolderAccess: [
            {
              folder: {
                id: 1,
                name: "Work / " + "continuous".repeat(8),
                owner_id: 1,
                owner_username: "synthetic",
              },
              direct_permission: "read",
              effective_permission: "write",
              sources: [
                {
                  source: "group",
                  source_id: 10,
                  name: "Operations / " + "continuous".repeat(12),
                  permission: "write",
                  expired: false,
                },
                {
                  source: "direct",
                  source_id: 2,
                  name: "team-member",
                  permission: "read",
                  expired: true,
                },
              ],
            },
          ],
        });
        const metrics = [];
        const button = (name) => page.getByRole("button", { name, exact: true });
        const capture = async (state) => {
          await page.evaluate(() => document.fonts.ready);
          await fits(page);
          const images = await captureMatrixState(
            page,
            `extended-${width}-${language}-${theme}-${state}`
          );
          await axe(page);
          metrics.push({
            state,
            images,
            route: new URL(page.url()).pathname + new URL(page.url()).search,
            width,
            language,
            theme,
          });
        };
        const go = async (tool) => {
          await page.goto(`${origin}/passwords${tool ? `?tool=${tool}` : ""}`);
          if (tool) {
            await taskSurface(page).waitFor();
            // Wait for the overlay's real focus handoff. With reduced
            // motion CSS can finish before the modal focus lifecycle.
            await page.waitForFunction(() =>
              document.activeElement?.closest('[role="dialog"], [data-qa="task-page"]')
            );
          } else await page.locator('[data-qa="entry-list"]').waitFor();
        };
        const dismiss = async () => {
          await leaveSurface(page);
        };
        const override = async (path, json, status = 200) =>
          page.route(`**/api/${path}`, (route) => route.fulfill({ status, json }));
        try {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page
            .getByRole("combobox", {
              name: t.common.fields.folder,
              exact: true,
            })
            .click();
          await page.getByRole("option", { name: /^Shared/ }).click();
          await capture("folder-filter");
          await go();
          await page
            .locator('[data-qa="entry-list"]')
            .getByRole("row")
            .filter({ hasText: "GitHub" })
            .click();
          const detail =
            width >= 1280
              ? page.getByRole("region", {
                  name: t.vault.browser.details,
                  exact: true,
                })
              : taskSurface(page, {
                  name: "GitHub",
                  exact: true,
                });
          await detail
            .getByRole("button", {
              name: t.vault.columns.revealPassword,
              exact: true,
            })
            .click();
          await detail
            .getByRole("button", {
              name: `${t.passwordField.show}: Recovery code`,
              exact: true,
            })
            .click();
          await detail
            .getByRole("button", {
              name: new RegExp(`^${t.entry.labels.passwordHistory}`),
            })
            .click();
          const historyDialog = page.getByRole("dialog", {
            name: t.entry.history.title,
            exact: true,
          });
          await historyDialog.waitFor();
          await historyDialog
            .getByRole("button", {
              name: t.entry.history.useAgain,
              exact: true,
            })
            .waitFor();
          await capture("password-history");
          await historyDialog
            .getByRole("button", {
              name: t.common.actions.close,
              exact: true,
            })
            .click();
          await historyDialog.waitFor({ state: "hidden" });
          await detail
            .getByRole("button", {
              name: new RegExp(`^${t.entry.labels.attachments}`),
            })
            .click();
          await detail.getByText("Readme.txt", { exact: true }).waitFor();
          await capture("details-revealed-history-attachments");
          await detail
            .getByRole("button", {
              name: t.vault.columns.copyPassword,
              exact: true,
            })
            .click();

          await detail
            .getByRole("button", {
              name: /^(Copy 2FA code|Скопировать код 2FA)/,
            })
            .click();
          await capture("copy-feedback");
          if (width < 576) {
            await feedbackDoesNotCover(
              page,
              detail.getByRole("button", {
                name: t.vault.columns.copyPassword,
                exact: true,
              }),
              detail.getByRole("button", {
                name: /^(Copy 2FA code|Скопировать код 2FA)/,
              }),
              detail.getByRole("button", {
                name: t.sharing.manage,
                exact: true,
              })
            );
          }
          await detail
            .getByRole("button", {
              name: t.sharing.manage,
              exact: true,
            })
            .click();
          await taskSurface(page, {
            name: t.sharing.manage,
            exact: true,
          }).waitFor();
          await capture("share-current");
          await taskSurface(page, {
            name: t.sharing.manage,
            exact: true,
          })
            .getByLabel(t.folderAccess.expiresAt, { exact: true })
            .fill("2000-01-01T10:00");
          await capture("share-expiry-error");
          await dismiss();
          await page.keyboard.press("Escape");
          await go("backup");
          await button(t.backup.title).click();
          await capture("backup-validation");
          await page.getByLabel(t.auth.masterPassword, { exact: true }).fill("Synthetic-only");
          let releaseBackup;
          const backupPending = new Promise((resolve) => {
            releaseBackup = resolve;
          });
          await page.route("**/api/passwords/backup", async (route) => {
            await backupPending;
            await route.fulfill({
              status: 422,
              json: { detail: t.errors.backupFailed },
            });
          });
          const backupRequest = page.waitForRequest("**/api/passwords/backup");
          await button(t.backup.title).click();
          await backupRequest;
          assert.equal(await button(t.backup.title).isDisabled(), true);
          await capture("backup-busy");
          releaseBackup();
          await page.getByText(t.errors.backupFailed, { exact: true }).waitFor();
          await capture("backup-error");
          await dismiss();
          await go("import");
          await button(t.common.actions.import).click();
          await capture("import-validation");
          await page
            .getByRole("radio", {
              name: t.importDialog.csvMode,
              exact: true,
            })
            .check();
          await button(t.common.actions.import).click();
          await capture("csv-validation");
          const filename = "Synthetic-" + "continuous".repeat(12) + ".csv";
          await page.locator('input[type="file"]').setInputFiles({
            name: filename,
            mimeType: "text/csv",
            buffer: Buffer.from("name,password\nfixture,synthetic-only\n"),
          });
          await capture("csv-file");
          await override("passwords/import/csv", { detail: t.errors.importFailed }, 422);
          await button(t.common.actions.import).click();
          await page.getByText(t.errors.importFailed, { exact: true }).waitFor();
          await capture("csv-error");
          let releaseImport;
          const importPending = new Promise((resolve) => {
            releaseImport = resolve;
          });
          await page.route("**/api/passwords/import/csv", async (route) => {
            await importPending;
            await route.fulfill({
              json: {
                total: 3,
                imported: 1,
                overwritten: 1,
                skipped: 1,
                renamed: 1,
                renamed_rows: [
                  {
                    where: "row 2",
                    name: "Renamed synthetic entry",
                    reason: "Name conflict",
                  },
                ],
                ignored: 1,
                ignored_rows: [
                  {
                    where: "row 4",
                    name: "Invalid synthetic entry",
                    reason: "Missing password",
                  },
                ],
              },
            });
          });
          const importRequest = page.waitForRequest("**/api/passwords/import/csv");
          await button(t.common.actions.import).click();
          await importRequest;
          assert.equal(await button(t.common.actions.import).isDisabled(), true);
          await capture("csv-busy");
          releaseImport();
          await taskSurface(page, {
            name: t.importDialog.completeTitle,
            exact: true,
          }).waitFor();
          await capture("csv-result");
          await dismiss();
          await go("import");
          await page.locator('input[type="file"]').setInputFiles({
            name: "Synthetic.cmbackup",
            mimeType: "application/octet-stream",
            buffer: Buffer.from("synthetic UI fixture only"),
          });
          await page
            .getByLabel(t.importDialog.backupPassword, {
              exact: true,
            })
            .fill("Synthetic-only-password");
          await override("passwords/import", {
            total: 1,
            imported: 1,
            trashed: 1,
            attachments: 1,
            grants_restored: 1,
            settings_restored: true,
          });
          await button(t.common.actions.import).click();
          await taskSurface(page, {
            name: t.importDialog.completeTitle,
            exact: true,
          }).waitFor();
          await capture("restore-result");
          await dismiss();
          await go("folders");
          await taskSurface(page).getByRole("heading", { name: "Work", exact: true }).waitFor();
          await taskSurface(page)
            .getByRole("combobox", {
              name: t.common.fields.folder,
              exact: true,
            })
            .click();

          await page.getByRole("option", { name: /^Shared/ }).click();
          await capture("folder-readonly");
          await dismiss();
          await override("folders", []);
          await go("folders");
          await page.getByText(t.folderAccess.empty, { exact: true }).waitFor();
          await capture("folders-empty");
          await dismiss();
          await page.goto(`${origin}/users`);
          await page.getByText("team-member", { exact: true }).waitFor();
          await button(t.groups.title).click();
          await page.getByText(t.groups.empty, { exact: true }).waitFor();
          await capture("groups-empty");
          await dismiss();
          await button(`${t.navigation.more}: team-member`).click();
          await capture("user-menu");
          await page
            .getByRole("menuitem", {
              name: t.folderAccess.manage,
              exact: true,
            })
            .click();
          await page.getByText(/Operations \/ continuous/).waitFor();
          await capture("user-acl-sources");
          await dismiss();
          await button(`${t.navigation.more}: team-member`).click();
          await page
            .getByRole("menuitem", {
              name: t.common.actions.delete,
              exact: true,
            })
            .click();
          await capture("user-delete-confirm");
          await dismiss();
          if (width < 576) await button(t.common.actions.add).click();
          const form = page.locator("form");
          await form
            .getByRole("combobox", {
              name: t.users.role,
              exact: true,
            })
            .click();
          await page
            .getByRole("option", {
              name: t.users.roles.service,
              exact: true,
            })
            .click();
          await capture("create-service");
          await form.getByLabel(t.auth.username, { exact: false }).fill("synthetic-service");
          await page.route("**/api/users", (route) =>
            route.request().method() === "POST"
              ? route.fulfill({
                  json: {
                    id: 4,
                    service_token: "Synthetic-issued-token-only",
                  },
                })
              : route.fallback()
          );
          const createService = (
            width < 576 ? page.locator('[data-qa="mobile-task-actions"]') : form
          ).getByRole("button", {
            name: t.common.actions.create,
            exact: true,
          });
          assert.equal(await createService.count(), 1);
          assert.equal(
            await createService.evaluate(
              (control) => control.form === document.querySelector("form")
            ),
            true,
            "service creation keeps its form owner after mobile portaling"
          );
          await createService.click();
          await page.getByText(t.users.serviceTokenOnce, { exact: true }).waitFor();
          await capture("service-token");
          // Clear transient messages before inspecting other empty/error owners.
          await go("trash");
          await page
            .getByRole("button", {
              name: /^(Удалить навсегда|Delete forever):/,
            })
            .click();

          await page.route("**/api/passwords/**", (route) =>
            new URL(route.request().url()).pathname.endsWith("/purge")
              ? route.fulfill({
                  status: 503,
                  json: { detail: t.errors.deletePassword },
                })
              : route.fallback()
          );
          await page
            .getByRole("dialog", {
              name: t.trashDialog.deleteForeverTitle,
              exact: true,
            })
            .getByRole("button", {
              name: t.trashDialog.deleteForever,
              exact: true,
            })
            .click();
          await page.getByText(t.trashDialog.purgeFailed, { exact: true }).waitFor();
          await capture("purge-error");

          await page
            .getByRole("dialog", {
              name: t.trashDialog.deleteForeverTitle,
              exact: true,
            })
            .getByRole("button", {
              name: t.common.actions.cancel,
              exact: true,
            })
            .click();
          await page
            .getByRole("dialog", {
              name: t.trashDialog.deleteForeverTitle,
              exact: true,
            })
            .waitFor({ state: "hidden" });
          await override("passwords/trash", []);
          await page.reload();
          await page.getByText(t.trashDialog.empty, { exact: true }).waitFor();
          await capture("trash-empty");
          await dismiss();
          const weak = [
            entries[0],
            ...entries.slice(1).map((entry) => ({
              ...entry,
              password_value: "x",
              updated: "2020-01-01T00:00:00Z",
            })),
          ];
          await override("passwords", weak);
          await go("health");
          await capture("health-issues");
          await dismiss();
          await override("vault/damaged", {
            entries: [77],
            attachments: [88],
          });
          await go();
          await page
            .getByRole("button", {
              name: t.common.actions.remove,
              exact: true,
            })
            .waitFor();
          await capture("damage-warning");
          await override("auth/entry-draft-key", { detail: t.entry.draft.unavailable }, 503);
          await page.reload();
          await page
            .getByRole("button", {
              name: t.common.actions.retry,
              exact: true,
            })
            .waitFor();
          await capture("draft-error-disabled");
          // Hold only the synthetic list GET to inspect loading, without real data.
          let release;
          const pending = new Promise((resolve) => {
            release = resolve;
          });
          await page.route("**/api/passwords", async (route) => {
            await pending;
            await route.fulfill({ json: entries });
          });
          await page.reload();
          await page.locator('[data-qa="vault-page"] .g-loader').waitFor();
          await capture("vault-loading");
          release();
          assert.deepEqual(errors, []);
        } finally {
          if (process.env.CIPHERMOTH_SCREENSHOT_DIR)
            await writeFile(
              resolve(
                process.env.CIPHERMOTH_SCREENSHOT_DIR,
                `extended-${width}-${language}-${theme}-metrics.json`
              ),
              JSON.stringify(metrics, null, 2)
            );
          await context.close();
        }
      });
    }
}
