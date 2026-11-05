import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const dockSelector = '[data-qa="mobile-task-actions"]';
const footerSelector = '[data-qa="task-actions"]';
const bodySelector = '[data-qa="task-body"]';
const phoneCases = [
    [375, 812, "ru", "dark"],
    [320, 812, "en", "light"],
    [375, 480, "ru", "dark"],
];

// Reuse the real production-image fixture. No app-only QA route or fake DOM.
export function registerBottomActionChecks({
    vault,
    entries,
    fits,
    axe,
    settleAnimations,
    viewportScreenshot,
    enText,
    ruText,
}) {
    const strings = (language) => (language === "ru" ? ruText : enText);
    const button = (page, name) =>
        page.getByRole("button", { name, exact: true });
    const dock = (page) => page.locator(dockSelector);
    const action = (page, name) =>
        dock(page).getByRole("button", { name, exact: true });
    const open = async (page, path) =>
        page.goto(`${new URL(page.url()).origin}${path}`);
    const shot = async (page, prefix, state) => {
        await settleAnimations(page);
        await viewportScreenshot(page, `${prefix}-${state}.png`);
    };
    const options = {
        role: "admin",
        users: [
            { id: 1, username: "synthetic", role: "admin", active: true },
            { id: 2, username: "team-member", role: "member", active: true },
        ],
        groups: [{ id: 10, name: "Operations", member_count: 0 }],
        shareTargets: [{ id: 2, username: "team-member", role: "member" }],
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

    async function record(page, data) {
        if (!process.env.CIPHERMOTH_SCREENSHOT_DIR) return;
        await mkdir(process.env.CIPHERMOTH_SCREENSHOT_DIR, { recursive: true });
        await appendFile(
            resolve(
                process.env.CIPHERMOTH_SCREENSHOT_DIR,
                "dock-metrics.jsonl",
            ),
            JSON.stringify({
                route:
                    new URL(page.url()).pathname + new URL(page.url()).search,
                viewport: page.viewportSize(),
                ...data,
            }) + "\n",
        );
    }

    async function assertDock(
        page,
        labels,
        height = page.viewportSize().height,
    ) {
        await dock(page).locator(footerSelector).waitFor();
        await page.waitForFunction(
            (labels) =>
                JSON.stringify(
                    [
                        ...document.querySelectorAll(
                            '[data-qa="mobile-task-actions"] button',
                        ),
                    ].map((node) => node.textContent.trim()),
                ) === JSON.stringify(labels),
            labels,
        );
        await settleAnimations(page);
        assert.equal(
            await dock(page).locator(footerSelector).count(),
            1,
            "only the active task owns the dock",
        );
        assert.deepEqual(
            (await dock(page).getByRole("button").allTextContents()).map((s) =>
                s.trim(),
            ),
            labels,
        );
        assert.equal(
            await page
                .locator('[data-qa="task-page"] header [data-qa="task-back"]')
                .count(),
            0,
            "no unreachable duplicate Back above content",
        );
        const metrics = await dock(page).evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            const scroll = document
                .querySelector('[data-qa="page-scroll"]')
                .getBoundingClientRect();
            const shelf = document
                .querySelector('[data-qa="notification-shelf"]')
                .getBoundingClientRect();
            return {
                top: bounds.top,
                bottom: bounds.bottom,
                scrollBottom: scroll.bottom,
                shelfTop: shelf.top,
                shelfBottom: shelf.bottom,
                buttons: [...node.querySelectorAll("button")].map((control) => {
                    const r = control.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                        r.x + r.width / 2,
                        r.y + r.height / 2,
                    );
                    return {
                        name: control.textContent.trim(),
                        x: r.x,
                        right: r.right,
                        top: r.top,
                        bottom: r.bottom,
                        width: r.width,
                        height: r.height,
                        // UIKit intentionally turns off pointer events on disabled buttons.
                        // Their center must still belong to this footer, not an overlay.
                        hit:
                            control.contains(hit) ||
                            (control.disabled && node.contains(hit)),
                    };
                }),
            };
        });
        assert.ok(
            Math.abs(metrics.bottom - height) < 2,
            JSON.stringify(metrics),
        );
        assert.ok(
            metrics.scrollBottom <= metrics.shelfTop + 1 &&
                metrics.shelfBottom <= metrics.top + 1,
            JSON.stringify(metrics),
        );
        for (const b of metrics.buttons) {
            assert.ok(
                b.width >= 44 &&
                    b.height >= 44 &&
                    b.x >= 0 &&
                    b.right <= page.viewportSize().width &&
                    b.top >= 0 &&
                    b.bottom <= height + 1 &&
                    b.hit,
                JSON.stringify(metrics),
            );
        }
        await record(page, {
            check: "dock",
            labels,
            visualHeight: height,
            metrics,
        });
        return metrics;
    }

    async function lastContentFits(page, height) {
        const scroll = page.locator('[data-qa="page-scroll"]');
        await scroll.evaluate((node) => node.scrollTo(0, node.scrollHeight));
        await settleAnimations(page);
        const body = page.locator(`${bodySelector}:visible`).last();
        const content = (await body.count())
            ? body
            : page.locator('[data-qa="task-page"] form');
        const bounds = await content.boundingBox();
        const scroller = await scroll.boundingBox();
        const footer = await dock(page).boundingBox();
        assert.ok(
            bounds &&
                bounds.y + bounds.height <= scroller.y + scroller.height + 1 &&
                bounds.y + bounds.height > 0 &&
                scroller.y + scroller.height <= footer.y + 1 &&
                footer.y < height,
            JSON.stringify({ bounds, scroller, footer }),
        );
        await record(page, {
            check: "last-content",
            visualHeight: height,
            bounds,
            scroller,
            footer,
        });
    }

    async function viewportHeight(page, height) {
        await page.evaluate((value) => {
            if (value === null) delete window.visualViewport.height;
            else
                Object.defineProperty(window.visualViewport, "height", {
                    configurable: true,
                    value,
                });
            window.visualViewport.dispatchEvent(new Event("resize"));
        }, height);
        await page.waitForFunction((height) => {
            const bounds = document
                .querySelector('[data-qa="mobile-task-actions"]')
                ?.getBoundingClientRect();
            return (
                bounds && Math.abs(bounds.bottom - (height ?? innerHeight)) < 2
            );
        }, height);
    }

    for (const [width, height, language, theme] of [
        ...phoneCases,
        [768, 900, "en", "light"],
        [1440, 900, "ru", "dark"],
    ]) {
        test(`bottom-action caller matrix ${width}x${height} ${language} ${theme}`, async () => {
            const t = strings(language);
            const { context, page, errors } = await vault(
                width,
                language,
                theme,
                entries,
                { ...options, touch: width < 576 },
            );
            const prefix = `bottom-${width}x${height}-${language}-${theme}`;
            try {
                await page.setViewportSize({ width, height });
                const cases = [
                    [
                        "settings",
                        "/settings",
                        [t.common.actions.save, t.common.actions.cancel],
                        t.common.actions.cancel,
                    ],
                    [
                        "password",
                        "/account/password",
                        [t.auth.changePassword, t.common.actions.cancel],
                        t.common.actions.cancel,
                    ],
                    [
                        "updates",
                        "/updates",
                        [t.common.actions.close],
                        t.common.actions.close,
                    ],
                    [
                        "backup",
                        "/passwords?tool=backup",
                        [t.backup.title, t.common.actions.cancel],
                        t.common.actions.cancel,
                    ],
                    [
                        "import",
                        "/passwords?tool=import",
                        [t.common.actions.import, t.common.actions.cancel],
                        t.common.actions.cancel,
                    ],
                    [
                        "health",
                        "/passwords?tool=health",
                        [t.common.actions.done],
                        t.common.actions.done,
                    ],
                    [
                        "trash",
                        "/passwords?tool=trash",
                        [t.common.actions.close],
                        t.common.actions.close,
                    ],
                    [
                        "folders",
                        "/passwords?tool=folders",
                        [t.common.actions.close],
                        t.common.actions.close,
                    ],
                    [
                        "groups",
                        "/users?view=groups",
                        [t.common.actions.close],
                        t.common.actions.close,
                    ],
                    [
                        "user-access",
                        "/users?view=access&user=2",
                        [t.common.actions.close],
                        t.common.actions.close,
                    ],
                    [
                        "share",
                        "/passwords?entry=1&view=share",
                        [t.sharing.grant, t.common.actions.cancel],
                        t.common.actions.cancel,
                    ],
                    [
                        "edit",
                        "/passwords?entry=1&view=edit",
                        [t.common.actions.update, t.common.actions.cancel],
                        t.common.actions.cancel,
                    ],
                    [
                        "create",
                        "/entries/new",
                        [
                            t.common.actions.create,
                            t.navigation.back,
                            t.common.actions.cancel,
                        ],
                        t.common.actions.cancel,
                    ],
                    ...(width < 576
                        ? [
                              [
                                  "details",
                                  "/passwords?entry=1&view=details",
                                  [t.navigation.back],
                                  t.navigation.back,
                              ],
                              [
                                  "entry-unavailable",
                                  "/passwords?entry=999&view=details",
                                  [t.navigation.back],
                                  t.navigation.back,
                              ],
                              [
                                  "user-create",
                                  "/users?view=create",
                                  [t.common.actions.create, t.navigation.back],
                                  t.navigation.back,
                              ],
                              [
                                  "user-unavailable",
                                  "/users?view=access&user=999",
                                  [t.navigation.back],
                                  t.navigation.back,
                              ],
                          ]
                        : []),
                ];
                for (const [name, path, labels, dismiss] of cases) {
                    await open(page, path);
                    if (name === "create")
                        await page
                            .getByLabel(t.common.fields.name, { exact: true })
                            .waitFor();
                    if (name === "user-unavailable")
                        await page
                            .getByText(t.users.unavailable, { exact: true })
                            .waitFor();
                    if (width < 576) {
                        await assertDock(page, labels, height);
                        await shot(page, prefix, `${name}-top`);
                        await lastContentFits(page, height);
                        await assertDock(page, labels, height);
                        await shot(page, prefix, `${name}-bottom`);
                        // Model visual-only keyboard resize, including read-only tasks without an input.
                        const field = page
                            .locator(
                                '[data-qa="task-page"] input:not([type="hidden"]), [data-qa="task-page"] textarea',
                            )
                            .filter({ visible: true })
                            .first();
                        if (await field.count()) await field.focus();
                        await viewportHeight(page, 400);
                        await assertDock(page, labels, 400);
                        await lastContentFits(page, 400);
                        await shot(page, prefix, `${name}-visual-viewport`);
                        await viewportHeight(page, null);
                    } else {
                        assert.equal(await dock(page).count(), 0);
                        await page
                            .getByRole("dialog")
                            .or(page.locator('[data-qa="task-page"]'))
                            .getByRole("button", { name: dismiss, exact: true })
                            .waitFor();
                        await shot(page, prefix, name);
                    }
                    await fits(page);
                    await axe(page);
                    if (width < 576) {
                        // Synthesized Chromium touch, not a hardware gesture claim.
                        await action(page, dismiss).tap();
                        await dock(page)
                            .locator("button")
                            .first()
                            .waitFor({ state: "detached" });
                        assert.equal(
                            await dock(page).locator("button").count(),
                            0,
                        );
                    }
                }
                assert.deepEqual(errors, []);
            } finally {
                await context.close();
            }
        });
    }

    for (const [width, height, language, theme] of phoneCases) {
        test(`bottom-action portal submit validates, disables, retains and retries ${width}x${height}`, async () => {
            const t = strings(language);
            const { context, page, errors } = await vault(
                width,
                language,
                theme,
                entries,
                { ...options, touch: true },
            );
            const prefix = `portal-${width}x${height}-${language}-${theme}`;
            let release;
            try {
                await page.setViewportSize({ width, height });
                await open(page, "/users?view=create");
                const username = page.getByLabel(t.auth.username, {
                    exact: false,
                });
                const password = page.getByLabel(t.users.temporaryPassword, {
                    exact: true,
                });
                const apply = action(page, t.common.actions.create);
                await assertDock(
                    page,
                    [t.common.actions.create, t.navigation.back],
                    height,
                );
                assert.equal(await apply.isDisabled(), true);
                assert.equal(
                    await apply.evaluate(
                        (control) =>
                            control.form?.id === control.getAttribute("form") &&
                            control.form !== null &&
                            !control.form.contains(control),
                    ),
                    true,
                    "the sole portal submit retains its actual form owner",
                );
                assert.equal(
                    await page.locator('form button[type="submit"]').count(),
                    0,
                    "no hidden duplicate submit",
                );
                let requests = 0;
                let fail = true;
                const pending = new Promise((resolve) => {
                    release = resolve;
                });
                await page.route("**/api/users", async (route) => {
                    if (route.request().method() !== "POST")
                        return route.fallback();
                    requests++;
                    assert.deepEqual(route.request().postDataJSON(), {
                        username: "new-member",
                        temporary_password: "Synthetic-temporary!2026",
                        role: "member",
                    });
                    await pending;
                    return fail
                        ? route.fulfill({
                              status: 503,
                              json: { detail: "Synthetic portal failure" },
                          })
                        : route.fulfill({
                              json: {
                                  id: 3,
                                  username: "new-member",
                                  role: "member",
                                  active: true,
                              },
                          });
                });
                await username.fill("new-member");
                await apply.tap();
                await page
                    .getByText(t.users.temporaryPasswordRequired, {
                        exact: true,
                    })
                    .waitFor();
                assert.equal(
                    requests,
                    0,
                    "client validation makes no request from the portaled control",
                );
                assert.equal(
                    await password.evaluate(
                        (node) => node === document.activeElement,
                    ),
                    true,
                );
                await password.fill("Synthetic-temporary!2026");
                const request = page.waitForRequest(
                    (r) =>
                        r.method() === "POST" &&
                        new URL(r.url()).pathname === "/api/users",
                );
                await apply.tap();
                await request;
                assert.equal(await apply.isDisabled(), true);
                assert.equal(
                    await action(page, t.navigation.back).isDisabled(),
                    true,
                );
                await assertDock(
                    page,
                    [t.common.actions.create, t.navigation.back],
                    height,
                );
                await shot(page, prefix, "busy");
                release();
                await page
                    .getByText("Synthetic portal failure", { exact: true })
                    .waitFor();
                assert.equal(await username.inputValue(), "new-member");
                assert.equal(
                    await password.inputValue(),
                    "Synthetic-temporary!2026",
                );
                await assertDock(
                    page,
                    [t.common.actions.create, t.navigation.back],
                    height,
                );
                await shot(page, prefix, "error-retained");
                await viewportHeight(page, 400);
                await assertDock(
                    page,
                    [t.common.actions.create, t.navigation.back],
                    400,
                );
                await shot(page, prefix, "error-keyboard-notification");
                await viewportHeight(page, null);
                fail = false;
                // Enter in the form must activate the external submit exactly once.
                await username.focus();
                await page.keyboard.press("Enter");
                await page.waitForFunction(
                    () =>
                        document.querySelector(
                            'form input[autocomplete="new-password"]',
                        )?.value === "",
                );
                assert.equal(requests, 2);
                await assertDock(
                    page,
                    [t.common.actions.create, t.navigation.back],
                    height,
                );
                await action(page, t.navigation.back).tap();
                await page.waitForURL("**/users");
                await dock(page)
                    .locator("button")
                    .first()
                    .waitFor({ state: "detached" });
                assert.equal(await dock(page).locator("button").count(), 0);
                assert.deepEqual(errors, []);
            } finally {
                release?.();
                await context.close();
            }
        });

        test(`bottom-action create Back preserves encrypted draft; Cancel discards ${width}x${height}`, async () => {
            const t = strings(language);
            const { context, page, errors } = await vault(
                width,
                language,
                theme,
                entries,
                { touch: true },
            );
            const prefix = `draft-bottom-${width}x${height}-${language}-${theme}`;
            try {
                await page.setViewportSize({ width, height });
                await button(page, t.common.actions.add).tap();
                const name = page.getByLabel(t.common.fields.name, {
                    exact: true,
                });
                await name.fill("Synthetic retained draft");
                await page
                    .getByRole("textbox", {
                        name: t.common.fields.password,
                        exact: true,
                    })
                    .fill("Synthetic-draft-value");
                await assertDock(
                    page,
                    [
                        t.common.actions.create,
                        t.navigation.back,
                        t.common.actions.cancel,
                    ],
                    height,
                );
                await shot(page, prefix, "before-back");
                const cipher = await page.evaluate(() =>
                    sessionStorage.getItem("ciphermoth-entry-draft:v1:1"),
                );
                assert.ok(
                    cipher &&
                        !cipher.includes("Synthetic retained draft") &&
                        !cipher.includes("Synthetic-draft-value"),
                );
                await action(page, t.navigation.back).tap();
                await page.waitForURL("**/passwords");
                assert.equal(
                    await page.evaluate(() =>
                        sessionStorage.getItem("ciphermoth-entry-draft:v1:1"),
                    ),
                    cipher,
                );
                assert.equal(await dock(page).locator("button").count(), 0);
                await button(page, t.entry.draft.resume).tap();
                assert.equal(
                    await name.inputValue(),
                    "Synthetic retained draft",
                );
                await page.reload();
                assert.equal(
                    await name.inputValue(),
                    "Synthetic retained draft",
                );
                await action(page, t.common.actions.cancel).tap();
                await page.waitForURL("**/passwords");
                assert.equal(
                    await page.evaluate(() =>
                        sessionStorage.getItem("ciphermoth-entry-draft:v1:1"),
                    ),
                    null,
                );
                assert.equal(await dock(page).locator("button").count(), 0);
                assert.deepEqual(errors, []);
            } finally {
                await context.close();
            }
        });

        test(`bottom-action initial loading and draft errors keep a working return ${width}x${height}`, async () => {
            const t = strings(language);
            const { context, page, errors } = await vault(
                width,
                language,
                theme,
                entries,
                { touch: true },
            );
            const prefix = `initial-bottom-${width}x${height}-${language}-${theme}`;
            let release;
            try {
                await page.setViewportSize({ width, height });
                let delay = true;
                let fail = false;
                const pending = new Promise((resolve) => {
                    release = resolve;
                });
                await page.route(
                    "**/api/auth/entry-draft-key",
                    async (route) => {
                        if (delay) await pending;
                        return fail
                            ? route.fulfill({
                                  status: 503,
                                  json: { detail: "Synthetic key unavailable" },
                              })
                            : route.fallback();
                    },
                );
                await open(page, "/entries/new");
                await page.getByRole("status").waitFor();
                await assertDock(page, [t.navigation.back], height);
                await shot(page, prefix, "loading");
                await action(page, t.navigation.back).tap();
                await page.waitForURL("**/passwords");
                delay = false;
                release();
                await page
                    .getByPlaceholder(t.vault.searchPlaceholder)
                    .waitFor();
                assert.equal(await dock(page).locator("button").count(), 0);
                fail = true;
                await open(page, "/entries/new");
                await page
                    .getByText(t.entry.draft.unavailable, { exact: true })
                    .waitFor();
                await assertDock(
                    page,
                    [t.common.actions.retry, t.navigation.back],
                    height,
                );
                await lastContentFits(page, height);
                await shot(page, prefix, "key-error");
                await action(page, t.navigation.back).tap();
                await page.waitForURL("**/passwords");
                await open(page, "/entries/new");
                await page
                    .getByText(t.entry.draft.unavailable, { exact: true })
                    .waitFor();
                fail = false;
                await action(page, t.common.actions.retry).tap();
                await page
                    .getByLabel(t.common.fields.name, { exact: true })
                    .waitFor();
                await assertDock(
                    page,
                    [
                        t.common.actions.create,
                        t.navigation.back,
                        t.common.actions.cancel,
                    ],
                    height,
                );
                await action(page, t.common.actions.cancel).tap();
                await page.evaluate(() =>
                    sessionStorage.setItem(
                        "ciphermoth-entry-draft:v1:1",
                        "damaged",
                    ),
                );
                await open(page, "/entries/new");
                await page
                    .getByText(t.entry.draft.unavailable, { exact: true })
                    .waitFor();
                assert.equal(
                    await page.evaluate(() =>
                        sessionStorage.getItem("ciphermoth-entry-draft:v1:1"),
                    ),
                    "damaged",
                );
                await assertDock(
                    page,
                    [t.common.actions.retry, t.navigation.back],
                    height,
                );
                await shot(page, prefix, "damaged-kept");
                await button(page, t.entry.draft.discard).tap();
                await page
                    .getByLabel(t.common.fields.name, { exact: true })
                    .waitFor();
                await action(page, t.common.actions.cancel).tap();
                await page.waitForURL("**/passwords");
                await dock(page)
                    .locator("button")
                    .first()
                    .waitFor({ state: "detached" });
                assert.equal(await dock(page).locator("button").count(), 0);
                await fits(page);
                assert.deepEqual(errors, []);
            } finally {
                release?.();
                await context.close();
            }
        });
    }

    test("bottom-action nested workflows restore exclusive actions, focus, scroll and history", async () => {
        const t = ruText;
        const records = Array.from({ length: 20 }, (_, i) => ({
            ...entries[0],
            id: i + 10,
            password_name: `Weak entry ${i}`,
            password_value: "weak",
        }));
        const { context, page, errors } = await vault(
            375,
            "ru",
            "dark",
            [...entries, ...records],
            { ...options, touch: true },
        );
        try {
            await open(page, "/passwords?tool=health");
            await assertDock(page, [t.common.actions.done]);
            const issue = page
                .locator('[data-qa="health-issue-group"]')
                .getByRole("button")
                .last();
            await issue.scrollIntoViewIfNeeded();
            await issue.focus();
            const scroll = await page
                .locator('[data-qa="page-scroll"]')
                .evaluate((node) => node.scrollTop);
            await page.keyboard.press("Enter");
            await page.waitForURL("**/passwords?entry=*&view=edit");
            await assertDock(page, [
                t.common.actions.update,
                t.common.actions.cancel,
            ]);
            await action(page, t.common.actions.cancel).tap();
            await page.waitForURL("**/passwords?tool=health");
            await assertDock(page, [t.common.actions.done]);
            await page.waitForTimeout(100);
            const restoredScroll = await page
                .locator('[data-qa="page-scroll"]')
                .evaluate((node) => node.scrollTop);
            assert.ok(
                Math.abs(restoredScroll - scroll) < 5,
                JSON.stringify({ scroll, restoredScroll }),
            );
            assert.equal(
                await issue.evaluate((node) => node === document.activeElement),
                true,
            );
            await page.goForward();
            await assertDock(page, [
                t.common.actions.update,
                t.common.actions.cancel,
            ]);
            await page.goBack();
            await assertDock(page, [t.common.actions.done]);
            await open(page, "/passwords?entry=1&view=details");
            await assertDock(page, [t.navigation.back]);
            const edit = button(page, t.common.actions.edit);
            await edit.focus();
            await page.keyboard.press("Enter");
            await assertDock(page, [
                t.common.actions.update,
                t.common.actions.cancel,
            ]);
            await action(page, t.common.actions.cancel).tap();
            await assertDock(page, [t.navigation.back]);
            assert.equal(
                await edit.evaluate((node) => node === document.activeElement),
                true,
            );
            const share = button(page, t.sharing.manage);
            await share.focus();
            const detailsScroll = await page
                .locator('[data-qa="page-scroll"]')
                .evaluate((node) => node.scrollTop);
            await page.keyboard.press("Enter");
            await assertDock(page, [t.sharing.grant, t.common.actions.cancel]);
            await action(page, t.common.actions.cancel).tap();
            await assertDock(page, [t.navigation.back]);
            assert.equal(
                await share.evaluate((node) => node === document.activeElement),
                true,
            );
            assert.ok(
                Math.abs(
                    (await page
                        .locator('[data-qa="page-scroll"]')
                        .evaluate((node) => node.scrollTop)) - detailsScroll,
                ) < 5,
            );
            await share.tap();
            await assertDock(page, [t.sharing.grant, t.common.actions.cancel]);
            await page.reload();
            await assertDock(page, [t.sharing.grant, t.common.actions.cancel]);
            await action(page, t.common.actions.cancel).tap();
            await assertDock(page, [t.navigation.back]);
            // Keep short destructive confirmations as Gravity Dialogs, not docked tasks.
            await button(page, t.common.actions.delete).tap();
            const confirmation = page.getByRole("dialog", {
                name: t.vault.moveToTrash.title,
                exact: true,
            });
            await confirmation.waitFor();
            assert.equal(await dock(page).locator(footerSelector).count(), 1);
            assert.equal(await confirmation.locator(footerSelector).count(), 0);
            const cancel = confirmation.getByRole("button", {
                name: t.common.actions.cancel,
                exact: true,
            });
            await cancel.focus();
            await page.keyboard.press("Tab");
            assert.equal(
                await confirmation.evaluate((node) =>
                    node.contains(document.activeElement),
                ),
                true,
            );
            await page.keyboard.press("Escape");
            await confirmation.waitFor({ state: "hidden" });
            await assertDock(page, [t.navigation.back]);
            await shot(page, "nested-bottom", "details-restored");
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    test("bottom-action user-folder fallback keeps Back during loading and load failure", async () => {
        const t = ruText;
        const { context, page, errors } = await vault(
            375,
            "ru",
            "dark",
            entries,
            { ...options, touch: true },
        );
        let release;
        try {
            let delay = true;
            let fail = false;
            const pending = new Promise((resolve) => {
                release = resolve;
            });
            await page.route("**/api/users", async (route) => {
                if (delay) await pending;
                return fail
                    ? route.fulfill({
                          status: 503,
                          json: { detail: "Synthetic user-list failure" },
                      })
                    : route.fallback();
            });
            await open(page, "/users?view=access&user=2");
            await page.getByRole("status").waitFor();
            await assertDock(page, [t.navigation.back]);
            await shot(page, "fallback-bottom", "user-loading");
            await action(page, t.navigation.back).tap();
            await page.waitForURL("**/users");
            delay = false;
            release();
            await page.getByText("team-member", { exact: true }).waitFor();
            assert.equal(await dock(page).locator("button").count(), 0);
            fail = true;
            await open(page, "/users?view=access&user=2");
            await page
                .locator('[data-qa="task-page"]')
                .getByText("Synthetic user-list failure", { exact: true })
                .waitFor();
            await assertDock(page, [t.navigation.back]);
            await shot(page, "fallback-bottom", "user-error");
            fail = false;
            await button(page, t.common.actions.retry).tap();
            await assertDock(page, [t.common.actions.close]);
            await shot(page, "fallback-bottom", "user-recovered");
            await action(page, t.common.actions.close).tap();
            await dock(page)
                .locator("button")
                .first()
                .waitFor({ state: "detached" });
            assert.deepEqual(errors, []);
        } finally {
            release?.();
            await context.close();
        }
    });

    test("bottom-action desktop selection does not leak a hidden details dock after resize", async () => {
        const t = enText;
        const { context, page, errors } = await vault(1440);
        try {
            await page.locator('[data-entry-id="1"]').click();
            await page
                .getByRole("region", {
                    name: t.vault.browser.details,
                    exact: true,
                })
                .waitFor();
            await page.setViewportSize({ width: 375, height: 812 });
            await page.locator('[data-qa="entry-list"]').waitFor();
            assert.equal(await dock(page).locator("button").count(), 0);
            await page.locator('[data-entry-id="2"]').click();
            await assertDock(page, [t.navigation.back]);
            await button(page, t.common.actions.edit).waitFor({
                state: "hidden",
            });
            await action(page, t.navigation.back).click();
            await page.locator('[data-qa="entry-list"]').waitFor();
            assert.equal(await dock(page).locator("button").count(), 0);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    test("bottom-action required password change has no dismiss or stale task controls", async () => {
        const t = ruText;
        const { context, page, errors } = await vault(
            375,
            "ru",
            "dark",
            entries,
            { ...options, touch: true },
        );
        try {
            await page.evaluate(() =>
                sessionStorage.setItem(
                    "ciphermothUser",
                    JSON.stringify({
                        id: 1,
                        username: "synthetic",
                        role: "admin",
                        must_change_password: true,
                    }),
                ),
            );
            await page.reload();
            await assertDock(page, [t.auth.changePassword]);
            assert.equal(
                await action(page, t.auth.changePassword).isDisabled(),
                true,
            );
            assert.equal(
                await page
                    .getByRole("button", {
                        name: t.common.actions.cancel,
                        exact: true,
                    })
                    .count(),
                0,
            );
            assert.equal(
                await page.locator('[data-qa="task-back"]').count(),
                0,
            );
            await page.keyboard.press("Escape");
            await assertDock(page, [t.auth.changePassword]);
            await axe(page);
            await shot(page, "required-bottom", "password");
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });
}
