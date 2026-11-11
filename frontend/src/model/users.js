import { action, thunk } from "easy-peasy";

import apiClient from "../api/client";
import { errorDetail } from "../lib/http";
import i18n from "../i18n";

const Users = {
  users: [],
  setUsers: action((state, users) => {
    state.users = users;
  }),

  get: thunk(async (actions) => {
    try {
      const { data } = await apiClient.get("/users");
      actions.setUsers(data);
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.loadUsers")));
    }
  }),

  create: thunk(async (actions, payload) => {
    try {
      const { data } = await apiClient.post("/users", payload);
      await actions.get();
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.createUser")));
    }
  }),

  update: thunk(async (actions, { userId, ...payload }) => {
    try {
      await apiClient.patch(`/users/${userId}`, payload);
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.updateUser")));
    }
  }),

  revokeSessions: thunk(async (_actions, userId) => {
    try {
      await apiClient.post(`/users/${userId}/sessions/revoke`);
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.revokeUserSessions")));
    }
  }),

  resetPassword: thunk(async (actions, { userId, temporaryPassword }) => {
    try {
      await apiClient.put(`/users/${userId}/password`, {
        temporary_password: temporaryPassword,
      });
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.resetPassword")));
    }
  }),

  rotateServiceToken: thunk(async (_actions, { userId, currentPassword }) => {
    try {
      const { data } = await apiClient.post(`/users/${userId}/service-token`, {
        current_password: currentPassword,
      });
      return data.service_token;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.rotateServiceToken")));
    }
  }),

  updateServiceOperations: thunk(async (actions, { userId, operations, currentPassword }) => {
    try {
      await apiClient.put(`/users/${userId}/service-operations`, {
        operations,
        current_password: currentPassword,
      });
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.updateServiceOperations")));
    }
  }),

  remove: thunk(async (actions, userId) => {
    try {
      await apiClient.delete(`/users/${userId}`);
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.deleteUser")));
    }
  }),

  shareTargets: thunk(async () => {
    try {
      const { data } = await apiClient.get("/users/share-targets");
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.loadShareTargets")));
    }
  }),
};

export default Users;
