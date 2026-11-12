import { invoke } from "@tauri-apps/api/core";

// One build-time switch, shared by all platform-dependent functionality.
export const IS_DESKTOP =
  import.meta.env.MODE === "desktop" || import.meta.env.VITE_DESKTOP === "1";
export const copySecret = (value, timeoutMs) => invoke("clipboard_write", { value, timeoutMs });
export const clearClipboard = () =>
  IS_DESKTOP ? invoke("clipboard_clear").catch(() => {}) : Promise.resolve();
export const openExternal = (url) => invoke("open_external", { url });
export const chooseBackup = () => invoke("choose_backup");
export const nativeBackup = (session, password, securityKeyAssertion) =>
  invoke("backup_export", { session, password, securityKeyAssertion });
export const nativeRestore = (session, password, ticket, onConflict) =>
  invoke("backup_import", { session, password, ticket, onConflict });
export const saveFile = async (blob, filename) =>
  invoke("save_file", new Uint8Array(await blob.arrayBuffer()), {
    headers: { "x-filename": encodeURIComponent(filename) },
  });

const RETURN_TO = "ciphermothReturnTo";
const protectedPath = (value) =>
  typeof value === "string" && /^\/(?:passwords|users|entries\/new)\/?(?:[?#]|$)/.test(value);

export const rememberReturnTo = () => {
  const path = window.location.pathname + window.location.search + window.location.hash;
  if (protectedPath(path)) sessionStorage.setItem(RETURN_TO, path);
};

export const enterVault = (returnTo) => {
  const remembered = sessionStorage.getItem(RETURN_TO);
  sessionStorage.removeItem(RETURN_TO);
  const candidate = returnTo ?? remembered;
  const path = protectedPath(candidate) ? candidate : "/passwords";
  if (!IS_DESKTOP) return window.location.replace(path);
  window.history.replaceState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export const lockNative = () => invoke("vault_lock");
