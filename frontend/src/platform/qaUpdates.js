// Separate native QA artifact only. Every record and password here is synthetic.
import { invoke } from "@tauri-apps/api/core";
import api from "../api/client";
import { getSessionToken } from "../utils";
import { store } from "../store";

const password = "Desktop-GUI-Canary-2026!";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ensure = (ok, message) => {
  if (!ok) throw new Error(message);
};
async function until(fn) {
  for (let n = 0; n < 300; n++) {
    if (fn()) return fn();
    await pause(100);
  }
  throw new Error("Update QA UI timed out");
}
const button = (label) =>
  [...document.querySelectorAll("button")].find((x) => x.textContent === label && !x.disabled);
function input(label, value) {
  const field = document.querySelector(`input[aria-label="${label}"]`);
  ensure(field, `Missing input ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
function checkAcknowledgement() {
  const field = document.querySelector('input[type="checkbox"]');
  const label = field?.closest("label");
  ensure(label, "Missing recovery acknowledgement");
  label.click();
}
async function unlock() {
  await until(
    () =>
      button("Create Vault") ||
      button("Unlock Vault") ||
      document.querySelector('input[type="checkbox"]')
  );
  const fresh = !!document.querySelector('input[type="checkbox"]');
  input(fresh ? "Administrator username" : "Username", "admin");
  input("Password", password);
  if (fresh) {
    input("Confirm password", password);
    checkAcknowledgement();
  }
  await pause(100);
  (await until(() => button(fresh ? "Create Vault" : "Unlock Vault"))).click();
  await until(() => button("Log out"));
  return fresh;
}
async function fingerprint() {
  const rows = (await api.get("/passwords")).data;
  const trash = (await api.get("/passwords/trash")).data;
  const settings = (await api.get("/settings")).data;
  const attachments = [];
  for (const row of rows) {
    const path = `/passwords/${encodeURIComponent(row.password_name)}/attachments`;
    for (const attachment of (await api.get(path)).data) {
      const bytes = (await api.get(`${path}/${attachment.id}`, { responseType: "arraybuffer" }))
        .data;
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      attachments.push({ entry: row.password_name, ...attachment, digest });
    }
  }
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])])
          )
        : v;
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonical({ rows, trash, settings, attachments }))
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seed() {
  const entry = {
    password_name: "Update password",
    password_value: "Synthetic-before-2026!",
    folder: "Update folder",
    tags: ["update"],
    totp_secret: "JBSWY3DPEHPK3PXP",
    favorite: true,
  };
  await api.post("/passwords/create", entry);
  await api.patch("/passwords/update", {
    password: entry,
    new_password: { ...entry, password_value: "Synthetic-after-2026!" },
  });
  await api.post("/passwords/create", {
    password_name: "Update note",
    password_value: "Synthetic note",
    kind: "note",
  });
  await api.post("/passwords/create", {
    password_name: "Update Trash",
    password_value: "Synthetic trash",
  });
  await api.delete("/passwords/Update%20Trash");
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  for (let i = 0; i < 2; i++) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), `update-${i}.bin`);
    await api.post("/passwords/Update%20password/attachments", form);
  }
  const backup = await invoke("qa_backup", {
    operation: "backup_export",
    session: getSessionToken(),
    password,
  });
  ensure(backup.result.saved && backup.bytes > 8192, "Pre-update complete backup failed");
}
async function run() {
  let result = { ready: true };
  try {
    // Host controls the disposable test run; production has no such command.
    while (true) {
      const command = await invoke("qa_update_step", { result });
      result = { action: command.action, ok: true };
      if (command.action === "unlock") {
        result.fresh = await unlock();
        result.version = (await api.get("/meta")).data.version;
        await until(() => document.body.textContent.includes(`v${result.version}`));
      } else if (command.action === "seed") {
        await api.patch("/settings", {
          ...(await api.get("/settings")).data,
          inactivity_ms: 600000,
          hidden_ms: 600000,
          update_check_enabled: false,
        });
        await seed();
        result.fingerprint = await fingerprint();
      } else if (command.action === "verify") {
        result.fingerprint = await fingerprint();
        ensure(result.fingerprint === command.fingerprint, "Vault changed across update/failure");
        if (command.backup) {
          const restored = await invoke("qa_backup", {
            operation: "backup_import",
            session: getSessionToken(),
            password,
          });
          ensure(restored.result.skipped >= 1, "Old encrypted backup failed after update");
          // Export a fresh backup through the same native workflow after the host
          // has moved the original fixed QA destination out of the way.
        }
      } else if (command.action === "backup") {
        const backup = await invoke("qa_backup", {
          operation: "backup_export",
          session: getSessionToken(),
          password,
        });
        ensure(backup.bytes > 8192, "Post-update backup incomplete");
        result.backupBytes = backup.bytes;
      } else if (command.action === "check") {
        try {
          result.status = await invoke("update_check");
          store.getActions().ciphermothModels.updates.setStatus(result.status);
        } catch (error) {
          result.error = String(error);
        }
        if (command.reject) ensure(!!result.error, "Unsafe manifest accepted");
        else {
          ensure(!result.error, result.error);
          ensure(result.status.updateAvailable === command.available, "Wrong update detection");
        }
      } else if (command.action === "install") {
        if (!command.reject) {
          const updateButton = await until(() => button("Update"));
          updateButton.click();
          (await until(() => button("Download and install"))).click();
          // Successful installation restarts this native process.
          await new Promise(() => {});
        }
        try {
          const install = invoke("update_install");
          if (command.cancel) {
            await pause(250);
            await invoke("update_cancel");
          }
          await install;
        } catch (error) {
          result.error = String(error);
        }
        if (command.reject) ensure(!!result.error, "Unsafe artifact installed");
        else throw new Error("Successful updater should restart the application");
      } else if (command.action === "wait") {
        await pause(500);
      } else throw new Error("Unknown QA command");
    }
  } catch (error) {
    await invoke("qa_update_step", { result: { ok: false, error: String(error) } });
  }
}
void run();
