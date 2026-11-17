import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { memoryStorage } from "../test/globals";
import { createEntryDraftStore } from "./entryDraft";

const credentials = { user_id: 1, key: btoa("x".repeat(32)) };
const form = { password_name: "Unsaved entry", password_value: "Synthetic-secret-2026!" };
let storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stores only authenticated ciphertext and restores all fields with a new session key object", () => {
  const store = createEntryDraftStore(credentials);
  store.write(form);
  const persisted = JSON.stringify(storage.entries());
  expect(persisted).not.toContain(form.password_name);
  expect(persisted).not.toContain(form.password_value);
  expect(persisted).not.toContain(credentials.key);
  const reopened = createEntryDraftStore(credentials);
  expect(reopened.read()).toEqual(form);
  expect(createEntryDraftStore({ ...credentials, user_id: 2 }).read()).toBeNull();
  const wrongKey = createEntryDraftStore({ ...credentials, key: btoa("z".repeat(32)) });
  expect(() => wrongKey.read()).toThrow();
  const [name, sealed] = Object.entries(storage.entries())[0];
  storage.setItem(
    name,
    `${sealed.slice(0, 20)}${sealed[20] === "A" ? "B" : "A"}${sealed.slice(21)}`
  );
  expect(() => reopened.read()).toThrow();
});

it("persists the last input before a renderer reset without waiting for promises", () => {
  const store = createEntryDraftStore(credentials);
  store.write(form);
  expect(storage.getItem("nedra-entry-draft:v1:1")).not.toBeNull();
  const latest = { ...form, password_value: "Latest synthetic input" };
  store.write(latest);
  expect(createEntryDraftStore(credentials).read()).toEqual(latest);
  store.clear();
  expect(createEntryDraftStore(credentials).read()).toBeNull();
});

it("uses the same AES-GCM format as WebCrypto with a fresh nonce for every write", async () => {
  const store = createEntryDraftStore(credentials);
  store.write(form);
  const first = storage.getItem("nedra-entry-draft:v1:1");
  store.write(form);
  const second = storage.getItem("nedra-entry-draft:v1:1");
  expect(second).not.toBe(first);
  const sealed = Uint8Array.from(atob(second), (char) => char.charCodeAt(0));
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("x".repeat(32)),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const plaintext = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: sealed.slice(0, 12),
      additionalData: new TextEncoder().encode("nedra-entry-draft:v1:1"),
    },
    key,
    sealed.slice(12)
  );
  expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(form);
});

it("reports storage or size failure without overwriting the previous draft", () => {
  const store = createEntryDraftStore(credentials);
  store.write(form);
  expect(() => store.write({ password_value: "x".repeat(1024 * 1024) })).toThrow("too large");
  vi.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  expect(() => store.write({ ...form, password_value: "New value" })).toThrow("Quota exceeded");
  expect(store.read()).toEqual(form);
});
