import { createStore } from "easy-peasy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import apiClient from "../api/client";
import { routes } from "../test/adapter";
import { stubBrowser } from "../test/globals";
import { setSessionToken } from "../utils";
import Passwords from "./passwords";

const TOKEN = "kM3x1y8Qe0bWv7c2Z9pL4tR6sN5aH1jD0fG3uY8iO2w";
const RESULT = { imported: 2, skipped: 1, overwritten: 0, total: 3 };
const originalAdapter = apiClient.defaults.adapter;

let seen;

const build = (table) => {
  seen = [];
  apiClient.defaults.adapter = routes(
    { "GET /passwords": [200, []], "GET /passwords/trash": [200, []], ...table },
    seen
  );
  return createStore({ passwords: Passwords }).getActions().passwords;
};

const fields = (formData) => Object.fromEntries(formData.entries());

beforeEach(() => {
  vi.unstubAllGlobals();
  stubBrowser();
  setSessionToken(TOKEN);
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
});

describe("imports", () => {
  it("sends a backup ZIP with the master password and conflict mode", async () => {
    const actions = build({ "POST /passwords/import": [200, RESULT] });
    const file = new File([new Uint8Array([80, 75, 3, 4])], "backup.zip");
    await expect(
      actions.importPasswords({ file, masterPassword: "Moth-Test-Vault-2026!", onConflict: "skip" })
    ).resolves.toEqual(RESULT);

    const [request, refresh] = seen;
    expect(request.data).toBeInstanceOf(FormData);
    const sent = fields(request.data);
    expect(Object.keys(sent).sort()).toEqual(["file", "master_password", "on_conflict"]);
    expect(sent.master_password).toBe("Moth-Test-Vault-2026!");
    expect(sent.on_conflict).toBe("skip");
    expect(sent.file.name).toBe("backup.zip");
    expect(request.headers["x-ciphermoth-session"]).toBe(TOKEN);
    expect(request.headers["x-ciphermoth-key-derivation"]).toBeUndefined();
    expect(`${refresh.method} ${refresh.url}`).toBe("get /passwords");
  });

  it("sends a CSV without the master password", async () => {
    const actions = build({ "POST /passwords/import/csv": [200, RESULT] });
    const file = new File(["name,password\na,b\n"], "export.csv", { type: "text/csv" });
    await expect(actions.importCsv({ file, onConflict: "overwrite" })).resolves.toEqual(RESULT);

    const sent = fields(seen[0].data);
    expect(Object.keys(sent).sort()).toEqual(["file", "on_conflict"]);
    expect(sent.on_conflict).toBe("overwrite");
  });

  it("turns a rejected import into the server message", async () => {
    const actions = build({
      "POST /passwords/import/csv": [400, { detail: "CSV must have a name/title column." }],
    });
    const file = new File(["x"], "export.csv");
    await expect(actions.importCsv({ file, onConflict: "skip" })).rejects.toThrow(
      "CSV must have a name/title column."
    );
    expect(seen).toHaveLength(1);
  });

  it("falls back to a generic message on an unexpected failure", async () => {
    const actions = build({ "POST /passwords/import": [500, "<html>"] });
    const file = new File(["x"], "backup.zip");
    await expect(
      actions.importPasswords({ file, masterPassword: "x", onConflict: "skip" })
    ).rejects.toThrow("Could not import entries. Check the file and try again.");
  });
});

describe("backup", () => {
  it("downloads the backup as a .cmbackup file", async () => {
    const actions = build({ "POST /passwords/backup": [200, new Blob(["zip"])] });
    const link = { click: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => link) });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:backup");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    await actions.backup("Moth-Test-Vault-2026!");

    const [request] = seen;
    expect(request.responseType).toBe("blob");
    expect(JSON.parse(request.data)).toEqual({ master_password: "Moth-Test-Vault-2026!" });
    expect(link.download).toMatch(
      /^ciphermoth_backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.cmbackup$/
    );
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:backup");
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it("reports a wrong master password from the Blob error body", async () => {
    const body = new Blob([JSON.stringify({ detail: "Incorrect master password." })]);
    const actions = build({ "POST /passwords/backup": [403, body] });
    await expect(actions.backup("wrong")).rejects.toThrow("Incorrect master password.");
  });
});

describe("bulk entry actions", () => {
  it.each([
    ["bulkTrash", "/vault/entries/trash", false],
    ["bulkRestore", "/vault/trash/restore", true],
    ["bulkPurge", "/vault/trash/purge", true],
  ])("sends one atomic %s request with correct identities", async (method, path, includeId) => {
    const actions = build({ [`POST ${path}`]: [200, { count: 2, detail: "done" }] });
    const entries = [
      { id: 7, password_name: "a/b" },
      { id: 9, password_name: "Wi-Fi ключ" },
    ];
    await expect(actions[method](entries)).resolves.toEqual({ count: 2, detail: "done" });
    expect(JSON.parse(seen[0].data)).toEqual({
      entries: entries.map((entry) => ({
        password_name: entry.password_name,
        ...(includeId ? { entry_id: entry.id } : {}),
      })),
    });
    expect(seen.filter((request) => request.method === "post")).toHaveLength(1);
    expect(seen[0].headers["x-ciphermoth-session"]).toBe(TOKEN);
  });

  it("preserves a rejected bulk request as a failure without refreshing", async () => {
    const actions = build({ "POST /vault/entries/trash": [403, { detail: "Access denied" }] });
    await expect(actions.bulkTrash([{ id: 1, password_name: "a" }])).rejects.toThrow(
      "Access denied"
    );
    expect(seen).toHaveLength(1);
  });

  it("moves and undoes entries by stable entry and folder IDs", async () => {
    const actions = build({
      "POST /vault/entries/move": [200, { count: 2, detail: "2 entries moved." }],
      "POST /vault/entries/move/undo": [200, { count: 2, detail: "2 entries moved." }],
    });
    const entries = [
      { id: 7, password_name: "a/b", folder_id: 3 },
      { id: 9, password_name: "Wi-Fi ключ", folder_id: null },
    ];
    await expect(actions.bulkMove({ entries, folderId: 4 })).resolves.toMatchObject({ count: 2 });
    await expect(
      actions.undoBulkMove([
        { entry_id: 7, folder_id: 3, moved_to_folder_id: 4 },
        { entry_id: 9, folder_id: null, moved_to_folder_id: 4 },
      ])
    ).resolves.toMatchObject({ count: 2 });
    expect(JSON.parse(seen[0].data)).toEqual({
      entries: [{ entry_id: 7 }, { entry_id: 9 }],
      folder_id: 4,
    });
    expect(JSON.parse(seen[2].data)).toEqual({
      entries: [
        { entry_id: 7, folder_id: 3, moved_to_folder_id: 4 },
        { entry_id: 9, folder_id: null, moved_to_folder_id: 4 },
      ],
    });
  });
});

describe("sharing", () => {
  it("preserves an entry grant expiry when its permission changes", async () => {
    const expiresAt = "2026-12-01T09:30:00.000Z";
    const actions = build({ "PUT /passwords/7/shares/3": [200, {}] });

    await actions.setShare({
      entryId: 7,
      userId: 3,
      permission: "write",
      expiresAt,
    });

    expect(JSON.parse(seen[0].data)).toEqual({
      permission: "write",
      expires_at: expiresAt,
    });
  });
});

describe("entry names in URLs", () => {
  it("binds Trash actions to the selected row even when names are shared", async () => {
    const actions = build({
      "POST /passwords/shared/restore": [200, {}],
      "DELETE /passwords/shared/purge": [200, {}],
    });
    await actions.restore({ passwordName: "shared", entryId: 4 });
    await actions.purge({ passwordName: "shared", entryId: 9 });
    const mutations = seen.filter((request) => request.method !== "get");
    expect(mutations.map((request) => request.params)).toEqual([{ entry_id: 4 }, { entry_id: 9 }]);
    expect(mutations.every((request) => request.headers["x-ciphermoth-entry"] === "shared")).toBe(
      true
    );
  });

  it.each([
    ["notes#2024", "/passwords/notes%232024"],
    ["a/b", "/passwords/a%2Fb"],
    ["x/purge", "/passwords/x%2Fpurge"],
    ["../settings", "/passwords/..%2Fsettings"],
    ["what?", "/passwords/what%3F"],
    ["...", "/passwords/..."],
    ["Wi-Fi ключ", "/passwords/Wi-Fi%20%D0%BA%D0%BB%D1%8E%D1%87"],
  ])("encodes %s", async (name, path) => {
    const actions = build({ [`DELETE ${path}`]: [200, { deleted: true }] });
    await actions.remove(name);
    expect(seen[0].url).toBe(path);
    expect(seen[0].headers["x-ciphermoth-entry"]).toBe(encodeURIComponent(name));
  });

  it("names the entry in a header on every entry request", async () => {
    const name = "x/purge";
    const base = "/passwords/x%2Fpurge";
    const actions = build({
      [`POST ${base}/restore`]: [200, {}],
      [`DELETE ${base}/purge`]: [200, {}],
      [`PATCH ${base}/favorite`]: [200, {}],
      [`GET ${base}/attachments`]: [200, []],
      [`POST ${base}/attachments`]: [200, {}],
      [`GET ${base}/attachments/7`]: [200, new Blob(["x"])],
      [`DELETE ${base}/attachments/7`]: [200, {}],
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    vi.stubGlobal("document", { createElement: () => ({ click: () => {} }) });
    await actions.restore(name);
    await actions.purge(name);
    await actions.toggleFavorite({ passwordName: name, favorite: true });
    await actions.fetchAttachments(name);
    await actions.uploadAttachment({ passwordName: name, file: new Blob(["f"]) });
    await actions.downloadAttachment({ passwordName: name, attachmentId: 7, filename: "f" });
    await actions.deleteAttachment({ passwordName: name, attachmentId: 7 });
    const entryRequests = seen.filter((config) => config.url.startsWith(base));
    expect(entryRequests).toHaveLength(7);
    for (const config of entryRequests) {
      expect(config.headers["x-ciphermoth-entry"]).toBe("x%2Fpurge");
    }
  });

  it.each([".", ".."])("refuses %s, which a browser would route to another URL", async (name) => {
    const actions = build({});
    await expect(actions.remove(name)).rejects.toThrow("Rename the entry");
    await expect(actions.purge(name)).rejects.toThrow("Rename the entry");
    await expect(actions.restore(name)).rejects.toThrow("Rename the entry");
    await expect(actions.toggleFavorite({ passwordName: name, favorite: true })).rejects.toThrow(
      "Rename the entry"
    );
    await expect(actions.fetchAttachments(name)).rejects.toThrow("Rename the entry");
    expect(seen).toEqual([]);
  });
});

describe("damaged rows", () => {
  it("loads the damaged rows and removes each one, then reloads", async () => {
    const actions = build({
      "GET /vault/damaged": [200, { entries: [7], attachments: [3] }],
      "DELETE /vault/damaged/entries/7": [200, { deleted: true, detail: "x" }],
      "DELETE /vault/damaged/attachments/3": [200, { deleted: true, detail: "x" }],
    });
    await actions.getDamaged();
    await actions.removeDamaged({ entries: [7], attachments: [3] });
    const calls = seen.map((request) => `${request.method.toUpperCase()} ${request.url}`);
    expect(calls).toContain("DELETE /vault/damaged/entries/7");
    expect(calls).toContain("DELETE /vault/damaged/attachments/3");
    expect(calls.filter((call) => call === "GET /vault/damaged")).toHaveLength(2);
  });

  it("keeps known damage and warns when the next check fails, then clears the warning on recovery", async () => {
    const store = createStore({ passwords: Passwords });
    const actions = store.getActions().passwords;
    actions.setDamaged({ entries: [7], attachments: [3] });
    apiClient.defaults.adapter = routes({ "GET /vault/damaged": [500, {}] }, []);
    await actions.getDamaged();
    expect(store.getState().passwords.damaged).toEqual({ entries: [7], attachments: [3] });
    expect(store.getState().passwords.damageCheckError).toContain(
      "Could not check the vault for damage"
    );
    apiClient.defaults.adapter = routes(
      { "GET /vault/damaged": [200, { entries: [], attachments: [] }] },
      []
    );
    await actions.getDamaged();
    expect(store.getState().passwords.damaged).toEqual({ entries: [], attachments: [] });
    expect(store.getState().passwords.damageCheckError).toBeNull();
  });

  it("warns when the initial damage check fails", async () => {
    const store = createStore({ passwords: Passwords });
    apiClient.defaults.adapter = routes({ "GET /vault/damaged": [500, {}] }, []);
    await store.getActions().passwords.getDamaged();
    expect(store.getState().passwords.damageCheckError).toContain("may be missing");
  });
});
