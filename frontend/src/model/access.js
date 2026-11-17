import { action, thunk } from "easy-peasy";

import apiClient from "../api/client";
import { errorDetail } from "../lib/http";
import i18n from "../i18n";

const request = async (operation, fallback) => {
  try {
    const { data } = await operation();
    return data;
  } catch (error) {
    throw new Error(await errorDetail(error, i18n.t(fallback)));
  }
};

const Access = {
  folders: [],
  groups: [],

  setFolders: action((state, folders) => {
    state.folders = folders;
  }),
  setGroups: action((state, groups) => {
    state.groups = groups;
  }),

  getFolders: thunk(async (actions) => {
    const data = await request(() => apiClient.get("/folders"), "errors.loadFolders");
    actions.setFolders(data);
    return data;
  }),
  createFolder: thunk(async (actions, name) => {
    const data = await request(() => apiClient.post("/folders", { name }), "errors.saveFolder");
    await actions.getFolders();
    return data;
  }),
  renameFolder: thunk(async (actions, { folderId, name }) => {
    const data = await request(
      () => apiClient.patch(`/folders/${folderId}`, { name }),
      "errors.saveFolder"
    );
    await actions.getFolders();
    return data;
  }),
  deleteFolder: thunk(async (actions, folderId) => {
    await request(() => apiClient.delete(`/folders/${folderId}`), "errors.deleteFolder");
    await actions.getFolders();
  }),
  folderGrants: thunk(async (_actions, folderId) =>
    request(() => apiClient.get(`/folders/${folderId}/grants`), "errors.loadFolderAccess")
  ),
  setFolderGrant: thunk(
    async (_actions, { folderId, targetType, targetId, permission, expiresAt }) =>
      request(
        () =>
          apiClient.put(`/folders/${folderId}/grants/${targetType}s/${targetId}`, {
            permission,
            expires_at: expiresAt || null,
          }),
        "errors.saveFolderAccess"
      )
  ),
  revokeFolderGrant: thunk(async (_actions, { folderId, targetType, targetId }) =>
    request(
      () => apiClient.delete(`/folders/${folderId}/grants/${targetType}s/${targetId}`),
      "errors.revokeFolderAccess"
    )
  ),
  folderAudit: thunk(async (_actions, folderId) =>
    request(() => apiClient.get(`/folders/${folderId}/audit`), "errors.loadAccessAudit")
  ),
  userFolderAccess: thunk(async (_actions, userId) =>
    request(() => apiClient.get(`/users/${userId}/folder-access`), "errors.loadFolderAccess")
  ),

  getGroups: thunk(async (actions) => {
    const data = await request(() => apiClient.get("/groups"), "errors.loadGroups");
    actions.setGroups(data);
    return data;
  }),
  createGroup: thunk(async (actions, name) => {
    const data = await request(() => apiClient.post("/groups", { name }), "errors.saveGroup");
    await actions.getGroups();
    return data;
  }),
  renameGroup: thunk(async (actions, { groupId, name }) => {
    const data = await request(
      () => apiClient.patch(`/groups/${groupId}`, { name }),
      "errors.saveGroup"
    );
    await actions.getGroups();
    return data;
  }),
  deleteGroup: thunk(async (actions, groupId) => {
    await request(() => apiClient.delete(`/groups/${groupId}`), "errors.deleteGroup");
    await actions.getGroups();
  }),
  groupMembers: thunk(async (_actions, groupId) =>
    request(() => apiClient.get(`/groups/${groupId}/members`), "errors.loadGroupMembers")
  ),
  addGroupMember: thunk(async (_actions, { groupId, userId }) =>
    request(() => apiClient.put(`/groups/${groupId}/members/${userId}`), "errors.saveGroupMember")
  ),
  removeGroupMember: thunk(async (_actions, { groupId, userId }) =>
    request(
      () => apiClient.delete(`/groups/${groupId}/members/${userId}`),
      "errors.removeGroupMember"
    )
  ),
  groupAudit: thunk(async (_actions, groupId) =>
    request(() => apiClient.get(`/groups/${groupId}/audit`), "errors.loadAccessAudit")
  ),
};

export default Access;
