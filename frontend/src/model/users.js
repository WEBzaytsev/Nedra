import { action, thunk } from "easy-peasy";

import apiClient from "../api/client";
import { errorDetail } from "../lib/http";
import { securityKeyStepUp } from "../lib/securityStepUp";
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
      const securityKeyAssertion =
        payload.role === "service"
          ? await securityKeyStepUp("service-token-create", {
              current_password: payload.current_password,
              target_role: payload.role,
              target_username: payload.username,
            })
          : undefined;
      const { data } = await apiClient.post("/users", {
        ...payload,
        security_key_assertion: securityKeyAssertion,
      });
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

  resetPassword: thunk(async (actions, { userId, temporaryPassword, currentPassword }) => {
    try {
      const securityKeyAssertion = await securityKeyStepUp("admin-password-reset", {
        current_password: currentPassword,
        target_user_id: userId,
        temporary_password: temporaryPassword,
      });
      await apiClient.put(`/users/${userId}/password`, {
        temporary_password: temporaryPassword,
        current_password: currentPassword,
        security_key_assertion: securityKeyAssertion,
      });
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.resetPassword")));
    }
  }),

  rotateServiceToken: thunk(async (_actions, { userId, currentPassword }) => {
    try {
      const securityKeyAssertion = await securityKeyStepUp("service-token-rotate", {
        current_password: currentPassword,
        target_user_id: userId,
      });
      const { data } = await apiClient.post(`/users/${userId}/service-token`, {
        current_password: currentPassword,
        security_key_assertion: securityKeyAssertion,
      });
      return data.service_token;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.rotateServiceToken")));
    }
  }),

  updateServiceOperations: thunk(async (actions, { userId, operations, currentPassword }) => {
    try {
      const securityKeyAssertion = await securityKeyStepUp("service-operations", {
        current_password: currentPassword,
        operations,
        target_user_id: userId,
      });
      await apiClient.put(`/users/${userId}/service-operations`, {
        operations,
        current_password: currentPassword,
        security_key_assertion: securityKeyAssertion,
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
