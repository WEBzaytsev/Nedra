import { beforeEach, describe, expect, it, vi } from "vitest";

import { replyWith } from "../test/adapter";
import { stubBrowser } from "../test/globals";
import {
  LOGOUT_NOTICE,
  clearSession,
  getSessionToken,
  isAuth,
  setSessionToken,
} from "../utils";
import apiClient, { SESSION_ENDED } from "./client";

const TOKEN = "kM3x1y8Qe0bWv7c2Z9pL4tR6sN5aH1jD0fG3uY8iO2w";

let browser;

beforeEach(() => {
  vi.unstubAllGlobals();
  browser = stubBrowser();
});

const failWith = async (status, data) => {
  const error = await apiClient
    .get("/passwords", { adapter: replyWith(status, data) })
    .catch((err) => err);
  expect(error.response.status).toBe(status);
  return error;
};

describe("session helpers", () => {
  it("keeps only the session token in sessionStorage", () => {
    expect(isAuth()).toBe(false);
    setSessionToken(TOKEN);
    expect(isAuth()).toBe(true);
    expect(getSessionToken()).toBe(TOKEN);
    expect(browser.storage.entries()).toEqual({ nedraSession: TOKEN });
    clearSession();
    expect(isAuth()).toBe(false);
    expect(browser.storage.entries()).toEqual({});
  });

  it("ignores empty tokens", () => {
    setSessionToken("");
    setSessionToken(undefined);
    expect(isAuth()).toBe(false);
  });


});

describe("request interceptor", () => {
  it("sends the session token in its own header when unlocked", async () => {
    setSessionToken(TOKEN);
    const seen = [];
    await apiClient.get("/passwords", { adapter: replyWith(200, [], seen) });
    expect(seen[0].headers["x-nedra-session"]).toBe(TOKEN);
    expect(seen[0].headers.Authorization).toBeUndefined();
  });


  it("sends no credential when locked", async () => {
    const seen = [];
    await apiClient.get("/master_password/status", { adapter: replyWith(200, {}, seen) });
    expect(seen[0].headers["x-nedra-session"]).toBeUndefined();
  });

  it("keeps an explicit session header", async () => {
    setSessionToken(TOKEN);
    const seen = [];
    await apiClient.post("/master_password/lock", null, {
      adapter: replyWith(200, {}, seen),
      headers: { "x-nedra-session": "other" },
    });
    expect(seen[0].headers["x-nedra-session"]).toBe("other");
  });
});

describe("response interceptor", () => {
  it.each([
    ["an ended session", 401, { detail: "expired", code: "invalid_session" }],
    ["a rejected vault key", 403, { detail: "Invalid key.", code: "invalid_key" }],
  ])("locks and reloads on %s", async (_, status, data) => {
    setSessionToken(TOKEN);
    const error = await failWith(status, data);
    expect(error.response.data.code).toBe(data.code);
    expect(isAuth()).toBe(false);
    expect(browser.storage.entries()).toEqual({ [LOGOUT_NOTICE]: SESSION_ENDED });
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
  });

  it("reads the code from a Blob body as well", async () => {
    setSessionToken(TOKEN);
    const body = new Blob([JSON.stringify({ detail: "x", code: "invalid_session" })], {
      type: "application/json",
    });
    await failWith(401, body);
    expect(isAuth()).toBe(false);
    expect(browser.location.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 403 without a code", 403, { detail: "Incorrect master password." }],
    ["a 403 with another code", 403, { detail: "x", code: "other" }],
    ["a 403 with the session code", 403, { code: "invalid_session" }],
    ["a 401 with the key code", 401, { code: "invalid_key" }],
    ["a 401 without a code", 401, { detail: "Unauthorized" }],
    ["a 403 with a non-JSON Blob", 403, new Blob(["<html>"])],
    ["a 500", 500, { detail: "An internal server error occurred." }],
    ["a 429", 429, { detail: "Too many attempts." }],
  ])("keeps the session on %s", async (_, status, data) => {
    setSessionToken(TOKEN);
    await failWith(status, data);
    expect(getSessionToken()).toBe(TOKEN);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it("does not reload when the vault is already locked", async () => {
    await failWith(401, { code: "invalid_session" });
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it("passes successful responses through untouched", async () => {
    setSessionToken(TOKEN);
    const { data } = await apiClient.get("/meta", { adapter: replyWith(200, { version: "1" }) });
    expect(data).toEqual({ version: "1" });
    expect(isAuth()).toBe(true);
  });
});
