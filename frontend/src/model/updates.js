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

  fetchVersion: thunk(async (actions) => {
    try {
      const { data } = await apiClient.get("/meta");
      actions.setVersion(data.version);
    } catch {
      // version just won't show if the backend can't be reached
    }
  }),

  checkForUpdates: thunk(async (actions) => {
    actions.setChecking(true);
    try {
      actions.setStatus(IS_DESKTOP ? await invoke("update_check") : await getUpdateStatus());
    } catch {
      // Offline GitHub must never interfere with the vault.
    } finally {
      actions.setChecking(false);
    }
  }),
};

export default Updates;
