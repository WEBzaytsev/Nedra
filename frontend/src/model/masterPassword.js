import { action, thunk } from "easy-peasy";

import { enterVault } from "../platform";
import apiClient from "../api/client";
import { errorDetail } from "../lib/http";
import i18n from "../i18n";
import { setCurrentUser, setSessionToken } from "../utils";

const MasterPassword = {
  initialized: null,
  error: null,
  loading: false,
  username: "",
  value: "",
  confirm: "",
  recoveryCode: null,

  setInitialized: action((state, val) => {
    state.initialized = val;
  }),
  setUsername: action((state, value) => {
    state.username = value;
  }),
  setValue: action((state, value) => {
    state.value = value;
  }),
  setConfirm: action((state, value) => {
    state.confirm = value;
  }),
  setError: action((state, error) => {
    state.error = error;
  }),
  setLoading: action((state, loading) => {
    state.loading = loading;
  }),
  setRecoveryCode: action((state, recoveryCode) => {
    state.recoveryCode = recoveryCode;
  }),

  fetchStatus: thunk(async (actions) => {
    try {
      const { data } = await apiClient.get("/auth/status");
      actions.setInitialized(data.initialized);
    } catch {
      actions.setInitialized(true);
    }
  }),

  authenticate: thunk(async (actions, { endpoint, username, password, returnTo }) => {
    actions.setError(null);
    actions.setLoading(true);
    try {
      const { data } = await apiClient.post(endpoint, { username, password });
      if (!data.valid || !data.session_token || !data.user) {
        actions.setError(i18n.t("errors.invalidCredentials"));
        return;
      }
      setSessionToken(data.session_token);
      setCurrentUser(data.user);
      actions.setValue("");
      actions.setConfirm("");
      enterVault(returnTo);
    } catch (err) {
      const message =
        err.response?.status === 429
          ? i18n.t("errors.tooManyAttempts")
          : await errorDetail(err, i18n.t("errors.authentication"));
      actions.setError(message);
    } finally {
      actions.setLoading(false);
    }
  }),
  recover: thunk(async (actions, { username, recoveryCode, password, returnTo }) => {
    actions.setError(null);
    actions.setLoading(true);
    try {
      const { data } = await apiClient.post("/auth/recover", {
        username,
        recovery_code: recoveryCode,
        new_password: password,
      });
      if (!data.valid || !data.session_token || !data.user) {
        actions.setError(i18n.t("errors.invalidCredentials"));
        return;
      }
      setSessionToken(data.session_token);
      setCurrentUser(data.user);
      actions.setRecoveryCode(data.recovery_code ?? null);
      actions.setValue("");
      actions.setConfirm("");
      if (!data.recovery_code) enterVault(returnTo);
    } catch (err) {
      const message =
        err.response?.status === 429
          ? i18n.t("errors.tooManyAttempts")
          : await errorDetail(err, i18n.t("errors.authentication"));
      actions.setError(message);
    } finally {
      actions.setLoading(false);
    }
  }),
  continueRecovery: thunk((actions, returnTo) => {
    actions.setRecoveryCode(null);
    enterVault(returnTo);
  }),
};

export default MasterPassword;
