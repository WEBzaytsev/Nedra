import { createStore } from "easy-peasy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import apiClient from "../api/client";
import { routes } from "../test/adapter";
import { stubBrowser } from "../test/globals";
import { setSessionToken } from "../utils";
import Access from "./access";

const TOKEN = "kM3x1y8Qe0bWv7c2Z9pL4tR6sN5aH1jD0fG3uY8iO2w";
const originalAdapter = apiClient.defaults.adapter;
let seen;

const build = (table) => {
  seen = [];
  apiClient.defaults.adapter = routes(table, seen);
  const store = createStore({ access: Access });
  return { actions: store.getActions().access, state: () => store.getState().access };
};

beforeEach(() => {
  vi.unstubAllGlobals();
  stubBrowser();
  setSessionToken(TOKEN);
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
});

describe("folder access API", () => {
  it("loads first-class folders into state", async () => {
    const folders = [{ id: 7, name: "Operations", access: "write", can_manage: false }];
    const { actions, state } = build({ "GET /folders": [200, folders] });

    await expect(actions.getFolders()).resolves.toEqual(folders);
    expect(state().folders).toEqual(folders);
    expect(seen[0].headers["x-nedra-session"]).toBe(TOKEN);
  });

  it("sends a timezone-qualified direct grant and revokes the same target", async () => {
    const expiresAt = "2027-01-02T03:04:05.000Z";
    const { actions } = build({
      "PUT /folders/7/grants/users/9": [200, { target_id: 9 }],
      "DELETE /folders/7/grants/users/9": [200, { detail: "revoked" }],
    });

    await actions.setFolderGrant({
      folderId: 7,
      targetType: "user",
      targetId: 9,
      permission: "write",
      expiresAt,
    });
    await actions.revokeFolderGrant({ folderId: 7, targetType: "user", targetId: 9 });

    expect(JSON.parse(seen[0].data)).toEqual({ permission: "write", expires_at: expiresAt });
    expect(`${seen[1].method} ${seen[1].url}`).toBe("delete /folders/7/grants/users/9");
  });

  it("uses group-specific grant and membership endpoints", async () => {
    const { actions } = build({
      "PUT /folders/3/grants/groups/4": [200, {}],
      "PUT /groups/4/members/8": [200, {}],
      "DELETE /groups/4/members/8": [200, {}],
    });

    await actions.setFolderGrant({
      folderId: 3,
      targetType: "group",
      targetId: 4,
      permission: "read",
      expiresAt: null,
    });
    await actions.addGroupMember({ groupId: 4, userId: 8 });
    await actions.removeGroupMember({ groupId: 4, userId: 8 });

    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      "put /folders/3/grants/groups/4",
      "put /groups/4/members/8",
      "delete /groups/4/members/8",
    ]);
  });

  it("surfaces the server detail instead of hiding authorization failures", async () => {
    const { actions } = build({
      "DELETE /folders/7": [403, { detail: "Only the folder owner can delete it." }],
    });

    await expect(actions.deleteFolder(7)).rejects.toThrow("Only the folder owner can delete it.");
  });
});
