import { action, thunk } from "easy-peasy";

import { IS_DESKTOP, nativeBackup, nativeRestore } from "../platform";
import { getSessionToken } from "../utils";
import apiClient from "../api/client";
import { errorDetail, triggerDownload } from "../lib/http";
import i18n from "../i18n";

export const entryPath = (passwordName, suffix = "") => {
  if (passwordName === "." || passwordName === "..") {
    throw new Error(i18n.t("errors.invalidEntryName", { name: passwordName }));
  }
  return `/passwords/${encodeURIComponent(passwordName)}${suffix}`;
};

export const entryHeaders = (passwordName) => ({
  "x-ciphermoth-entry": encodeURIComponent(passwordName),
});

const Passwords = {
  error: null,
  loading: false,
  passwords: [],
  trash: [],
  damaged: { entries: [], attachments: [] },
  damageCheckError: null,

  setError: action((state, error) => {
    state.error = error;
  }),
  setLoading: action((state, loading) => {
    state.loading = loading;
  }),
  setPasswords: action((state, passwords) => {
    state.passwords = passwords;
  }),
  setTrash: action((state, trash) => {
    state.trash = trash;
  }),
  setDamaged: action((state, damaged) => {
    state.damaged = damaged;
  }),
  setDamageCheckError: action((state, error) => {
    state.damageCheckError = error;
  }),

  getDamaged: thunk(async (actions) => {
    try {
      const { data } = await apiClient.get("/vault/damaged");
      actions.setDamaged(data);
      actions.setDamageCheckError(null);
    } catch {
      actions.setDamageCheckError(i18n.t("errors.damageCheck"));
    }
  }),

  removeDamaged: thunk(async (actions, damaged) => {
    try {
      for (const kind of ["entries", "attachments"]) {
        for (const rowId of damaged[kind]) {
          await apiClient.delete(`/vault/damaged/${kind}/${rowId}`);
        }
      }
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.removeDamaged")));
    } finally {
      await actions.get();
      await actions.getTrash();
      await actions.getDamaged();
    }
  }),

  get: thunk(async (actions) => {
    actions.setLoading(true);
    actions.setError(null);
    try {
      const { data } = await apiClient.get("/passwords");
      actions.setPasswords(data);
    } catch (err) {
      actions.setError(await errorDetail(err, i18n.t("errors.loadPasswords")));
    } finally {
      actions.setLoading(false);
    }
  }),

  create: thunk(async (actions, payload) => {
    try {
      await apiClient.post("/passwords/create", payload);
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.createPassword")));
    }
  }),

  update: thunk(async (actions, payload) => {
    try {
      await apiClient.patch("/passwords/update", payload);
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.updatePassword")));
    }
  }),

  reuseHistory: thunk(async (actions, payload) => {
    try {
      await apiClient.post("/passwords/history/reuse", payload);
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.updatePassword")));
    }
  }),

  remove: thunk(async (actions, passwordName) => {
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName);
    try {
      await apiClient.delete(path, { headers });
      await actions.get();
      await actions.getTrash();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.deletePassword")));
    }
  }),

  bulkTrash: thunk(async (actions, entries) => {
    try {
      const { data } = await apiClient.post("/vault/entries/trash", {
        entries: entries.map((entry) => ({ password_name: entry.password_name })),
      });
      await actions.get();
      await actions.getTrash();
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.deletePassword")));
    }
  }),

  bulkRestore: thunk(async (actions, entries) => {
    try {
      const { data } = await apiClient.post("/vault/trash/restore", {
        entries: entries.map((entry) => ({
          password_name: entry.password_name,
          entry_id: entry.id,
        })),
      });
      await actions.get();
      await actions.getTrash();
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.restorePassword")));
    }
  }),

  bulkPurge: thunk(async (actions, entries) => {
    try {
      const { data } = await apiClient.post("/vault/trash/purge", {
        entries: entries.map((entry) => ({
          password_name: entry.password_name,
          entry_id: entry.id,
        })),
      });
      await actions.getTrash();
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.deletePassword")));
    }
  }),

  bulkMove: thunk(async (actions, { entries, folderId }) => {
    try {
      const { data } = await apiClient.post("/vault/entries/move", {
        entries: entries.map((entry) => ({ entry_id: entry.id })),
        folder_id: folderId,
      });
      await actions.get();
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.moveEntries")));
    }
  }),

  undoBulkMove: thunk(async (actions, entries) => {
    try {
      const { data } = await apiClient.post("/vault/entries/move/undo", { entries });
      await actions.get();
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.moveEntries")));
    }
  }),

  getTrash: thunk(async (actions) => {
    try {
      const { data } = await apiClient.get("/passwords/trash");
      actions.setTrash(data);
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.loadTrash")));
    }
  }),

  restore: thunk(async (actions, target) => {
    const { passwordName, entryId } =
      typeof target === "string" ? { passwordName: target } : target;
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName, "/restore");
    try {
      await apiClient.post(path, null, { headers, params: { entry_id: entryId } });
      await actions.get();
      await actions.getTrash();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.restorePassword")));
    }
  }),

  purge: thunk(async (actions, target) => {
    const { passwordName, entryId } =
      typeof target === "string" ? { passwordName: target } : target;
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName, "/purge");
    try {
      await apiClient.delete(path, { headers, params: { entry_id: entryId } });
      await actions.getTrash();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.deletePassword")));
    }
  }),

  toggleFavorite: thunk(async (actions, { passwordName, favorite }) => {
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName, "/favorite");
    try {
      await apiClient.patch(path, { favorite }, { headers });
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.updateFavorite")));
    }
  }),

  fetchAttachments: thunk(async (actions, passwordName) => {
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName, "/attachments");
    try {
      const { data } = await apiClient.get(path, { headers });
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.loadAttachments")));
    }
  }),

  uploadAttachment: thunk(async (actions, { passwordName, file }) => {
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName, "/attachments");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await apiClient.post(path, formData, { headers });
      await actions.get();
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.uploadAttachment")));
    }
  }),

  downloadAttachment: thunk(async (actions, { passwordName, attachmentId, filename }) => {
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName, `/attachments/${attachmentId}`);
    try {
      const response = await apiClient.get(path, { responseType: "blob", headers });
      await triggerDownload(response.data, filename || "attachment");
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.downloadAttachment")));
    }
  }),

  deleteAttachment: thunk(async (actions, { passwordName, attachmentId }) => {
    const headers = entryHeaders(passwordName);
    const path = entryPath(passwordName, `/attachments/${attachmentId}`);
    try {
      await apiClient.delete(path, { headers });
      await actions.get();
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.deleteAttachment")));
    }
  }),

  listShares: thunk(async (_actions, entryId) => {
    try {
      const { data } = await apiClient.get(`/passwords/${entryId}/shares`);
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.loadShares")));
    }
  }),

  setShare: thunk(async (_actions, { entryId, userId, permission, expiresAt = null }) => {
    try {
      const { data } = await apiClient.put(`/passwords/${entryId}/shares/${userId}`, {
        permission,
        expires_at: expiresAt,
      });
      return data;
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.saveShare")));
    }
  }),

  revokeShare: thunk(async (_actions, { entryId, userId }) => {
    try {
      await apiClient.delete(`/passwords/${entryId}/shares/${userId}`);
    } catch (err) {
      throw new Error(await errorDetail(err, i18n.t("errors.revokeShare")));
    }
  }),

  importPasswords: thunk(async (actions, { file, masterPassword, onConflict }) => {
    try {
      if (IS_DESKTOP) {
        const data = await nativeRestore(
          getSessionToken(),
          masterPassword,
          file.ticket,
          onConflict
        ).catch((message) => {
          throw new Error(String(message));
        });
        await actions.get();
        await actions.getTrash();
        return data;
      }
      const formData = new FormData();
      formData.append("file", file);
      formData.append("master_password", masterPassword);
      formData.append("on_conflict", onConflict);
      const { data } = await apiClient.post("/passwords/import", formData);
      await actions.get();
      await actions.getTrash();
      return data;
    } catch (err) {
      throw new Error(
        await errorDetail(err, IS_DESKTOP ? err.message : i18n.t("errors.importFailed"))
      );
    }
  }),

  importCsv: thunk(async (actions, { file, onConflict }) => {
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("on_conflict", onConflict);
      const { data } = await apiClient.post("/passwords/import/csv", formData);
      await actions.get();
      return data;
    } catch (err) {
      throw new Error(
        await errorDetail(err, IS_DESKTOP ? err.message : i18n.t("errors.importFailed"))
      );
    }
  }),

  backup: thunk(async (_actions, masterPassword) => {
    try {
      if (IS_DESKTOP)
        return await nativeBackup(getSessionToken(), masterPassword).catch((message) => {
          throw new Error(String(message));
        });
      const response = await apiClient.post(
        "/passwords/backup",
        { master_password: masterPassword },
        { responseType: "blob" }
      );
      const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      triggerDownload(response.data, `ciphermoth_backup_${stamp}.cmbackup`);
    } catch (err) {
      throw new Error(
        await errorDetail(err, IS_DESKTOP ? err.message : i18n.t("errors.backupFailed"))
      );
    }
  }),
};

export default Passwords;
