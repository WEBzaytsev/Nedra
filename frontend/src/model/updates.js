import { action, thunk } from "easy-peasy";

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { IS_DESKTOP } from "../platform";
import apiClient from "../api/client";
import { compareVersions, getUpdateStatus } from "../lib/updateCheck";

let pendingCheck;

const Updates = {
  current: null,
  latest: null,
  releaseUrl: null,
  updateAvailable: false,
  checked: false,
  checking: false,
  error: false,
  notes: null,
  canInstall: false,

  setStatus: action((state, status) => {
    if (!status) return;
    state.notes = status.notes;
    state.canInstall = status.canInstall ?? false;
    state.current = status.current;
    state.latest = status.latest;
    state.releaseUrl = status.releaseUrl;
    state.updateAvailable = status.updateAvailable;
    state.checked = true;
  }),
  clearStatus: action((state) => {
    state.checked = false;
    state.latest = null;
    state.releaseUrl = null;
    state.updateAvailable = false;
    state.notes = null;
    state.canInstall = false;
  }),
  setVersion: action((state, version) => {
    state.current = version;
    if (state.latest) state.updateAvailable = compareVersions(state.latest, version) > 0;
  }),
  setChecking: action((state, checking) => {
    state.checking = checking;
  }),
  setError: action((state, error) => {
    state.error = error;
  }),

  fetchVersion: thunk(async (actions) => {
    try {
      if (IS_DESKTOP) actions.setVersion(await getVersion());
      else {
        const { data } = await apiClient.get("/meta");
        actions.setVersion(data.version);
      }
    } catch {}
  }),

  checkForUpdates: thunk(async (actions, { manual = false } = {}) => {
    if (manual) actions.setError(false);
    if (!pendingCheck) {
      actions.clearStatus();
      actions.setChecking(true);
      pendingCheck = (async () => {
        try {
          const status = IS_DESKTOP ? await invoke("update_check") : await getUpdateStatus();
          if (!status) throw new Error("Update status unavailable");
          actions.setStatus(status);
          return true;
        } catch {
          return false;
        } finally {
          pendingCheck = null;
          actions.setChecking(false);
        }
      })();
    }
    const success = await pendingCheck;
    if (!success && manual) actions.setError(true);
    return success;
  }),
};

export default Updates;
