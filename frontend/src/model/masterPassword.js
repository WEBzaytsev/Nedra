import { action, thunk } from "easy-peasy";

import { enterVault, IS_DESKTOP } from "../platform";
import {
  biometricAvailable,
  biometricLogin,
  biometricLoginOptions,
  boundBiometricDevice,
} from "../platform/biometric";
import apiClient from "../api/client";
import { errorDetail } from "../lib/http";
import { securityKeyAssertion } from "../lib/securityKey";
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
      let { data } = await apiClient.post(endpoint, { username, password });
      if (data.security_key_required) {
        const assertion = await securityKeyAssertion(data.security_key_challenge);
        ({ data } = await apiClient.post("/auth/login/security-key", {
          username,
          password,
          assertion,
        }));
      }
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
  authenticateDevice: thunk(async (actions, { username, password, returnTo }) => {
    actions.setError(null);
    actions.setLoading(true);
    try {
      let data;
      if (IS_DESKTOP && (await biometricAvailable())) {
        const options = await biometricLoginOptions(username);
        const device = boundBiometricDevice(username, options.devices ?? []);
        if (!options.enabled || !device) {
          actions.setError(i18n.t("auth.deviceUnlockUnavailable"));
          return;
        }
        if (options.password_required && !password) {
          actions.setError(i18n.t("auth.deviceUnlockPasswordRequired"));
          return;
        }
        const factorAssertion = options.security_key_challenge
          ? await securityKeyAssertion(options.security_key_challenge)
          : undefined;
        data = await biometricLogin(
          username,
          device.id,
          options.password_required ? password : null,
          factorAssertion
        );
      } else {
        const response = await apiClient.post("/auth/login/device-unlock/options", { username });
        const options = response.data;
        if (options.password_required || !options.challenge) {
          actions.setError(i18n.t("auth.deviceUnlockPasswordRequired"));
          return;
        }
        const assertion = await securityKeyAssertion(options.challenge);
        const factorAssertion = options.security_key_challenge
          ? await securityKeyAssertion(options.security_key_challenge)
          : undefined;
        ({ data } = await apiClient.post("/auth/login/device-unlock", {
          username,
          assertion,
          ...(factorAssertion ? { security_key_assertion: factorAssertion } : {}),
        }));
      }
      if (!data.valid || !data.session_token || !data.user) {
        actions.setError(i18n.t("errors.invalidCredentials"));
        return;
      }
      setSessionToken(data.session_token);
      setCurrentUser(data.user);
      actions.setValue("");
      enterVault(returnTo);
    } catch (err) {
      actions.setError(
        typeof err === "string"
          ? err
          : await errorDetail(err, err?.message || i18n.t("errors.authentication"))
      );
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
