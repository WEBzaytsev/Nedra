import { invoke } from "@tauri-apps/api/core";

import { IS_DESKTOP } from "./index";

const bindingKey = (username) => `nedraBiometricDevice:${username.toLowerCase()}`;
const storedBinding = (username) => localStorage.getItem(bindingKey(username));

export const biometricAvailable = () =>
  IS_DESKTOP ? invoke("biometric_available").catch(() => false) : Promise.resolve(false);

export const biometricStatus = (session) => invoke("biometric_status", { session });

export const biometricLoginOptions = (username) => invoke("biometric_login_options", { username });

export const biometricEnroll = async (
  session,
  username,
  name,
  currentPassword,
  securityKeyAssertion
) => {
  const status = await invoke("biometric_enroll", {
    session,
    name,
    currentPassword,
    securityKeyAssertion: securityKeyAssertion ?? null,
  });
  const enrolled = status.devices?.at(-1);
  if (enrolled?.id) localStorage.setItem(bindingKey(username), String(enrolled.id));
  return status;
};

export const biometricLogin = (username, deviceId, password, securityKeyAssertion) =>
  invoke("biometric_login", {
    username,
    deviceId,
    password: password || null,
    securityKeyAssertion: securityKeyAssertion ?? null,
  });

export const biometricRemove = async (session, username, id) => {
  const status = await invoke("biometric_remove", { session, id });
  if (localStorage.getItem(bindingKey(username)) === String(id)) {
    localStorage.removeItem(bindingKey(username));
  }
  return status;
};

export const boundBiometricDevice = (username, devices) => {
  const id = Number(storedBinding(username));
  return devices.find((device) => device.id === id) ?? (devices.length === 1 ? devices[0] : null);
};
