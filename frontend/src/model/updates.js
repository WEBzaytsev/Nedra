import { action, thunk } from "easy-peasy";

import { invoke } from "@tauri-apps/api/core";
import { IS_DESKTOP } from "../platform";
import apiClient from "../api/client";
import { getUpdateStatus } from "../lib/updateCheck";

const Updates = {
  current: null,
  latest: null,
  releaseUrl: null,
  updateAvailable: false,
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
  }),
  setVersion: action((state, version) => {
    state.current = version;
  }),
  setChecking: action((state, checking) => {
    state.checking = checking;
  }),
  setError: action((state, error) => {
    state.error = error;
  }),

  fetchVersion: thunk(async (actions) => {
    try {
      const { data } = await apiClient.get("/meta");
      actions.setVersion(data.version);
    } catch {}
  }),

  checkForUpdates: thunk(async (actions, { manual = false } = {}) => {
    if (manual) actions.setError(false);
    actions.setChecking(true);
    try {
      const status = IS_DESKTOP ? await invoke("update_check") : await getUpdateStatus();
      if (!status) throw new Error("Update status unavailable");
      actions.setStatus(status);
      return true;
    } catch {
      if (manual) actions.setError(true);
      return false;
    } finally {
      actions.setChecking(false);
    }
  }),
};

export default Updates;
