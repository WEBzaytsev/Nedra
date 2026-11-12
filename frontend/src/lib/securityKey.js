import { invoke } from "@tauri-apps/api/core";

import { IS_DESKTOP } from "../platform";

const bytes = (value) => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (part) => part.charCodeAt(0));
};

const encoded = (value) => {
  const binary = String.fromCharCode(...new Uint8Array(value));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const assertion = (credential) => {
  const response = credential.response;
  const prf = credential.getClientExtensionResults()?.prf?.results?.first;
  if (!prf) throw new Error("This security key does not support the required PRF extension.");
  return {
    credential_id: encoded(credential.rawId),
    client_data_json: encoded(response.clientDataJSON),
    authenticator_data: encoded(response.authenticatorData),
    signature: encoded(response.signature),
    prf_output: encoded(prf),
  };
};

export class SecurityKeyCancelled extends Error {}

const listeners = new Set();
let waiting = null;
const setWaiting = (state) => {
  waiting = state;
  for (const listener of listeners) listener(state);
};

export const onSecurityKeyPrompt = (listener) => {
  listeners.add(listener);
  listener(waiting);
  return () => listeners.delete(listener);
};

export const cancelSecurityKey = () =>
  IS_DESKTOP ? invoke("security_key_cancel").catch(() => {}) : Promise.resolve();

const askPin = (error) =>
  new Promise((resolve, reject) => {
    setWaiting({
      kind: "pin",
      error,
      submit: resolve,
      cancel: () => reject(new SecurityKeyCancelled("Cancelled.")),
    });
  });

const nativeError = (message) =>
  message === "cancelled"
    ? new SecurityKeyCancelled("Cancelled.")
    : new Error(String(message || "The security key could not be used."));

const nativeRun = async (command, args, session = {}) => {
  let error = null;
  try {
    for (;;) {
      if (session.pin === undefined) session.pin = await askPin(error);
      setWaiting({ kind: "touch" });
      try {
        return await invoke(command, { ...args, pin: session.pin || null });
      } catch (failure) {
        if (failure !== "pin-invalid") throw nativeError(failure);
        error = "invalid";
        session.pin = undefined;
      }
    }
  } finally {
    setWaiting(null);
  }
};

export const securityKeyAssertion = async (options, session) => {
  if (IS_DESKTOP) return nativeRun("security_key_answer", { challenge: options }, session);
  if (!window.PublicKeyCredential) throw new Error("WebAuthn is not available in this client.");
  const keys = options.keys.filter((key) => key.rp_id === window.location.hostname);
  if (!keys.length) throw new Error("No registered security key matches this vault address.");
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: bytes(options.challenge),
      rpId: window.location.hostname,
      timeout: options.timeout_ms,
      userVerification: "required",
      allowCredentials: keys.map((key) => ({ id: bytes(key.credential_id), type: "public-key" })),
      extensions: {
        prf: {
          evalByCredential: Object.fromEntries(
            keys.map((key) => [key.credential_id, { first: bytes(key.prf_salt) }])
          ),
        },
      },
    },
  });
  if (!credential) throw new SecurityKeyCancelled("Security-key request was cancelled.");
  return assertion(credential);
};

export const registerSecurityKey = async (options) => {
  const session = {};
  if (IS_DESKTOP) {
    const created = await nativeRun("security_key_register", { options }, session);
    return {
      registration: created.registration,
      assertion: await securityKeyAssertion(
        {
          challenge: options.secret_challenge,
          timeout_ms: options.timeout_ms,
          keys: [
            {
              credential_id: created.credential_id,
              rp_id: created.rp_id,
              prf_salt: options.prf_salt,
            },
          ],
        },
        session
      ),
    };
  }
  if (!window.PublicKeyCredential) throw new Error("WebAuthn is not available in this client.");
  if (options.rp_id !== window.location.hostname) {
    throw new Error("This security-key relying party does not match this vault address.");
  }
  const created = await navigator.credentials.create({
    publicKey: {
      challenge: bytes(options.challenge),
      rp: { id: options.rp_id, name: options.rp_name },
      user: { id: bytes(options.user_id), name: "Nedra", displayName: "Nedra" },
      pubKeyCredParams: options.algorithms.map((alg) => ({ type: "public-key", alg })),
      excludeCredentials: options.exclude_credentials.map((id) => ({
        id: bytes(id),
        type: "public-key",
      })),
      timeout: options.timeout_ms,
      attestation: "none",
      authenticatorSelection: { userVerification: "required" },
      extensions: { prf: { eval: { first: bytes(options.prf_salt) } } },
    },
  });
  if (!created) throw new SecurityKeyCancelled("Security-key registration was cancelled.");
  const response = created.response;
  const secret = await navigator.credentials.get({
    publicKey: {
      challenge: bytes(options.secret_challenge),
      rpId: options.rp_id,
      timeout: options.timeout_ms,
      userVerification: "required",
      allowCredentials: [{ id: created.rawId, type: "public-key" }],
      extensions: { prf: { eval: { first: bytes(options.prf_salt) } } },
    },
  });
  if (!secret) throw new SecurityKeyCancelled("Security-key confirmation was cancelled.");
  return {
    registration: {
      client_data_json: encoded(response.clientDataJSON),
      attestation_object: encoded(response.attestationObject),
    },
    assertion: assertion(secret),
  };
};
