import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const isoFromSeconds = (seconds) =>
  Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;

export const toExtensionStatus = (raw) => ({
  enabled: raw?.enabled === true,
  listening: raw?.listening === true,
  browsers: Array.isArray(raw?.browsers)
    ? raw.browsers.filter((value) => typeof value === "string")
    : [],
  pairings: (Array.isArray(raw?.pairings) ? raw.pairings : []).map((pairing) => ({
    id: String(pairing.id),
    browser: String(pairing.browser),
    created: isoFromSeconds(pairing.created),
    lastUsed: isoFromSeconds(pairing.last_used),
  })),
  error: typeof raw?.error === "string" ? raw.error : null,
});

export const formatPairingCode = (code) =>
  /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : "";

export const extensionStatus = async () => toExtensionStatus(await invoke("extension_status"));
export const allowExtensions = async (enabled) =>
  toExtensionStatus(await invoke("extension_set_enabled", { enabled }));
export const unpairBrowser = async (id) =>
  toExtensionStatus(await invoke("extension_unpair", { id }));
export const answerPairing = (id, allow) =>
  invoke("extension_pairing_answer", { id, allow }).catch(() => {});

export const onPairingRequest = async (onRequest, onClosed) => {
  const stopRequest = await listen("extension-pairing", (event) => onRequest(event.payload));
  const stopClosed = await listen("extension-pairing-closed", (event) =>
    onClosed(event.payload.id)
  );
  return () => {
    stopRequest();
    stopClosed();
  };
};
