import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { routes } from "../test/adapter";
import { stubBrowser } from "../test/globals";
import { LOGOUT_NOTICE, isAuth, setSessionToken } from "../utils";
import apiClient from "./client";
import { endSession, readSession, touchSession } from "./session";
import { createEntryDraftStore } from "../lib/entryDraft";

const TOKEN = "kM3x1y8Qe0bWv7c2Z9pL4tR6sN5aH1jD0fG3uY8iO2w";
const originalAdapter = apiClient.defaults.adapter;

let browser;
let seen;

beforeEach(() => {
  vi.unstubAllGlobals();
  browser = stubBrowser();
  seen = [];
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
});

describe("ending a session", () => {
  it("retains the synchronously encrypted draft when ending the session", async () => {
    const store = createEntryDraftStore({ user_id: 1, key: btoa("x".repeat(32)) });
    apiClient.defaults.adapter = routes({ "POST /master_password/lock": [200, {}] }, seen);
    setSessionToken(TOKEN);
    const form = { password_name: "Unsaved", password_value: "Synthetic-draft" };
    store.write(form);
    await endSession();
    expect(isAuth()).toBe(false);
    expect(createEntryDraftStore({ user_id: 1, key: btoa("x".repeat(32)) }).read()).toEqual(form);
    expect(browser.location.replace).toHaveBeenCalledWith("/login");
  });
  it("locks it on the server, forgets it and returns to the unlock screen", async () => {
    apiClient.defaults.adapter = routes({ "POST /master_password/lock": [200, {}] }, seen);
    setSessionToken(TOKEN);
    await endSession("Logged out due to inactivity.");

    expect(seen).toHaveLength(1);
    expect(seen[0].headers["x-nedra-session"]).toBe(TOKEN);
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(isAuth()).toBe(false);
    expect(browser.storage.entries()).toEqual({
      [LOGOUT_NOTICE]: "Logged out due to inactivity.",
    });
    expect(browser.location.replace).toHaveBeenCalledWith("/login");
  });

  it("still locks the screen when the server cannot be reached", async () => {
    apiClient.defaults.adapter = async (config) => {
      seen.push(config);
      throw new Error("Network Error");
    };
    setSessionToken(TOKEN);
    await endSession();

    expect(seen[0].timeout).toBeGreaterThan(0);
    expect(isAuth()).toBe(false);
    expect(browser.storage.entries()).toEqual({});
    expect(browser.location.replace).toHaveBeenCalledWith("/login");
  });

  it("sends nothing when there is no session", async () => {
    apiClient.defaults.adapter = routes({}, seen);
    await endSession();
    expect(seen).toHaveLength(0);
    expect(browser.location.replace).toHaveBeenCalledWith("/login");
  });
});

describe("keeping a session alive", () => {
  it("reports activity with a POST, which refreshes the session", async () => {
    apiClient.defaults.adapter = routes(
      { "POST /master_password/session": [200, { idle_timeout_ms: 120000 }] },
      seen
    );
    setSessionToken(TOKEN);
    await expect(touchSession()).resolves.toEqual({ idle_timeout_ms: 120000 });
    expect(seen[0].method).toBe("post");
    expect(seen[0].headers["x-nedra-session"]).toBe(TOKEN);
    expect(seen[0].headers.Authorization).toBeUndefined();
  });

  it("lets the interceptor lock the vault when the server already ended it", async () => {
    apiClient.defaults.adapter = routes(
      { "POST /master_password/session": [401, { code: "invalid_session" }] },
      seen
    );
    setSessionToken(TOKEN);
    await expect(touchSession()).resolves.toBeNull();
    expect(isAuth()).toBe(false);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
  });
});

describe("reading the session", () => {
  it("uses a GET, which the server does not count as activity", async () => {
    apiClient.defaults.adapter = routes(
      {
        "GET /master_password/session": [200, { idle_timeout_ms: 120000, expires_in_ms: 40000 }],
      },
      seen
    );
    setSessionToken(TOKEN);
    await expect(readSession()).resolves.toEqual({ idle_timeout_ms: 120000, expires_in_ms: 40000 });
    expect(seen[0].method).toBe("get");
  });

  it("returns nothing when the session has ended", async () => {
    apiClient.defaults.adapter = routes(
      { "GET /master_password/session": [401, { code: "invalid_session" }] },
      seen
    );
    setSessionToken(TOKEN);
    await expect(readSession()).resolves.toBeNull();
    expect(isAuth()).toBe(false);
  });
});
