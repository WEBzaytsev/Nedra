// Only imported by a dedicated QA frontend build. Runs inside the native webview.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import api from "../api/client";
import { coreStatus, coreRequest } from "./core";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EXTENSION_LOGIN = {
  name: "Extension QA login",
  password: "Extension-QA-canary-2026!",
  username: "qa@example.test",
  url: "https://login.example.test",
};
async function until(fn, attempts = 200) {
  for (let n = 0; n < attempts; n++) {
    const result = fn();
    if (result) return result;
    await pause(100);
  }
  throw new Error("UI condition timed out");
}
function input(label, value) {
  const control = document.querySelector(`input[aria-label="${label}"]`);
  const node = [...document.querySelectorAll("label")].find(
    (item) => item.textContent.replace(/\s*\*$/, "") === label
  );
  const field =
    control ||
    (node && document.getElementById(node.htmlFor)) ||
    (label === "Password" && document.querySelector('input[type="password"]'));
  if (!field) throw new Error(`Missing field: ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
async function checkAcknowledgement() {
  const field = document.querySelector('input[type="checkbox"]');
  const label = field?.closest("label");
  if (!label) throw new Error("Missing recovery acknowledgement");
  for (let attempt = 0; attempt < 20 && document.activeElement !== field; attempt++) {
    await invoke("qa_report", {
      result: { stage: "bootstrap_focus_step", attempt },
    });
    await pause(0);
  }
  if (document.activeElement !== field) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const bounds = label.getBoundingClientRect();
      if (bounds.top >= 0 && bounds.bottom <= window.innerHeight) break;
      await invoke("qa_report", {
        result: {
          stage: "bootstrap_scroll_step",
          attempt,
          direction: bounds.bottom > window.innerHeight ? "down" : "up",
        },
      });
      await pause(0);
    }
  }
  const bounds = label.getBoundingClientRect();
  const controlBounds = field.getBoundingClientRect();
  const visible =
    bounds.top >= 0 &&
    bounds.bottom <= window.innerHeight &&
    controlBounds.width > 0 &&
    controlBounds.height > 0;
  await invoke("qa_report", {
    result: {
      stage: "bootstrap_acknowledgement",
      control_center: visible
        ? {
            x: controlBounds.left + controlBounds.width / 2,
            y: controlBounds.top + controlBounds.height / 2,
          }
        : null,
      focused: document.activeElement === field,
    },
  });
  await pause(0);
  if (!field.checked) throw new Error("native acknowledgement click did not update the checkbox");
}
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (x) => x.textContent.trim().toLowerCase() === label.toLowerCase() && !x.disabled
  );
const checks = [];
try {
  // A first launch can spend well over 20 seconds starting the frozen core on
  // hosted macOS VMs. Later UI transitions keep the shorter failure budget.
  await until(
    () =>
      button("Create Vault") ||
      button("Unlock Vault") ||
      document.querySelector('input[type="checkbox"]'),
    600
  );
  const interactiveMs = Math.round(performance.now());
  if (!sessionStorage.getItem("qa-interactive-ms")) {
    sessionStorage.setItem("qa-interactive-ms", String(interactiveMs));
    await invoke("qa_report", {
      result: { stage: "interactive", interactive_ms: interactiveMs, core: await coreStatus() },
    });
  }
  const fresh = !!document.querySelector('input[type="checkbox"]');
  input(fresh ? "Administrator username" : "Username", "admin");
  input("Password", sessionStorage.getItem("qa-password") || "Desktop-GUI-Canary-2026!");
  if (fresh) {
    input("Confirm password", "Desktop-GUI-Canary-2026!");
    await checkAcknowledgement();
  }
  await pause(100);
  const submit = button(fresh ? "Create Vault" : "Unlock Vault");
  if (!submit) {
    const acknowledgement = document.querySelector('input[type="checkbox"]');
    throw new Error(`login submit stayed disabled (acknowledged=${acknowledgement?.checked})`);
  }
  submit.click();
  await until(() => button("Log out"));
  checks.push(fresh ? "create vault through UI" : "unlock persisted vault through UI");
  let { data } = await api.get("/passwords");
  if (!data.some((row) => row.password_name === EXTENSION_LOGIN.name)) {
    const addEmptyEntry = await until(() =>
      document.querySelector('[data-qa="empty-vault-add"]:not(:disabled)')
    );
    addEmptyEntry.click();
    await until(() =>
      [...document.querySelectorAll("label")].some((x) => x.textContent.startsWith("Name"))
    );
    input("Name", EXTENSION_LOGIN.name);
    input("Username or email (optional)", EXTENSION_LOGIN.username);
    input("Website (optional)", EXTENSION_LOGIN.url);
    input("Password", EXTENSION_LOGIN.password);
    await pause(100);
    (await until(() => button("Create"))).click();
    // A disabled submit button means the request is in flight, not completed.
    await until(
      () => ![...document.querySelectorAll("button")].some((x) => x.textContent === "Create")
    );
    checks.push("create password through UI");
    ({ data } = await api.get("/passwords"));
  }
  if (
    !data.some(
      (row) =>
        row.password_name === EXTENSION_LOGIN.name &&
        row.username === EXTENSION_LOGIN.username &&
        row.url === EXTENSION_LOGIN.url &&
        row.password_value === EXTENSION_LOGIN.password
    )
  )
    throw new Error("saved entry not found");
  checks.push("retrieve password through native IPC");
  const search = await until(() => document.querySelector("input[placeholder]"));
  const setSearch = (value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const hasEntryRow = () =>
    [...document.querySelectorAll('[role="row"]')].some((row) =>
      row.textContent.includes(EXTENSION_LOGIN.name)
    );
  setSearch("no-match-synthetic-qa");
  await until(() => !hasEntryRow());
  setSearch(EXTENSION_LOGIN.name);
  await until(hasEntryRow);
  setSearch("");
  checks.push("search filters and restores the native vault rows");
  if (fresh) {
    const { workflows } = await import("./qaWorkflows");
    await workflows(checks);
  }
  if (!localStorage.getItem("qa-extension-done")) {
    let paired = false;
    const stopPairing = await listen("extension-pairing", async ({ payload }) => {
      await invoke("qa_report", {
        result: { stage: "extension_pairing", browser: payload.browser, code: payload.code },
      });
      await invoke("extension_pairing_answer", { id: payload.id, allow: true });
      paired = true;
    });
    try {
      const extensionStatus = await invoke("extension_set_enabled", { enabled: true });
      if (extensionStatus?.enabled !== true) throw new Error("desktop extension did not enable");
      if (extensionStatus?.listening !== true) {
        throw new Error("desktop extension did not start listening");
      }
      if (!Array.isArray(extensionStatus?.browsers)) {
        throw new Error("desktop extension returned no browser manifest status");
      }
      await invoke("qa_report", {
        result: { stage: "extension_ready", browsers: extensionStatus.browsers },
      });
      await until(() => paired);
      await invoke("qa_report", { result: { stage: "extension_on_complete" } });
      await invoke("extension_set_enabled", { enabled: false });
      await invoke("qa_report", { result: { stage: "extension_off" } });
      localStorage.setItem("qa-extension-done", "1");
      checks.push("desktop extension enable, pair, fill, revoke and disable");
    } finally {
      stopPairing();
    }
  }
  if (import.meta.env.VITE_DESKTOP_DIALOG_QA === "1" && !sessionStorage.getItem("qa-files")) {
    const { getSessionToken } = await import("../utils");
    const session = getSessionToken();
    await invoke("qa_report", { result: { stage: "backup_save" } });
    const saved = await invoke("backup_export", {
      session,
      password: "Desktop-GUI-Canary-2026!",
    });
    if (!saved.saved) throw new Error("native backup not saved");
    await invoke("qa_report", { result: { stage: "backup_open" } });
    const selected = await invoke("choose_backup");
    if (!selected?.ticket || selected.path) throw new Error("invalid native file grant");
    const restored = await invoke("backup_import", {
      session,
      password: "Desktop-GUI-Canary-2026!",
      ticket: selected.ticket,
      onConflict: "skip",
    });
    if (restored.skipped < 1) throw new Error("native backup did not restore");
    sessionStorage.setItem("qa-files", "done");
    checks.push("native backup save/open dialogs and restore");
  }
  const denied = [
    "plugin:shell|execute",
    "plugin:fs|read_file",
    "plugin:window|close",
    "plugin:updater|check",
    "plugin:updater|download_and_install",
  ];
  for (const command of denied) {
    let refused = false;
    try {
      await invoke(command, {});
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("capability accepted");
  }
  checks.push("ungranted capabilities refused");
  let timeout = false;
  try {
    await coreRequest({
      method: "POST",
      path: "/api/master_password/unlock",
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode(
        JSON.stringify({ master_password: "Desktop-GUI-Canary-2026!" })
      ),
      timeoutMs: 1,
    });
  } catch (error) {
    timeout = error.code === "timeout";
  }
  if (!timeout) throw new Error("native timeout not enforced");
  checks.push("native timeout cancels real KDF request");
  await invoke("clipboard_write", { value: "Native-clipboard-canary", timeoutMs: 1000 });
  await invoke("qa_report", { result: { stage: "clipboard_timeout" } });
  await pause(1800);
  await invoke("clipboard_write", { value: "Native-clipboard-canary", timeoutMs: 1000 });
  await invoke("qa_report", { result: { stage: "clipboard_replaced" } });
  await pause(1800);
  checks.push("native clipboard command");
  await pause(1200);
  const stage = sessionStorage.getItem("qa-lock-stage");
  if (!stage) {
    sessionStorage.setItem("qa-checks", JSON.stringify(checks));
    sessionStorage.setItem("qa-fresh", JSON.stringify(fresh));
    sessionStorage.setItem("qa-lock-stage", "manual");
    button("Log out").click();
  } else if (stage === "manual") {
    sessionStorage.setItem("qa-lock-stage", "idle");
    await api.patch("/settings", {
      inactivity_ms: 30000,
      warn_before_ms: 5000,
      hidden_ms: 60000,
      debounce_ms: 1000,
      clipboard_clear_ms: 30000,
      update_check_enabled: false,
    });
    await invoke("qa_report", { result: { stage: "native_idle", core: await coreStatus() } });
    // Deliberately starve this real WebView's event loop. The host must observe
    // core termination before JS timers or this script can run again.
    // Date.now() continues advancing when a headless/background WebView pauses
    // its high-resolution performance clock (observed on Windows runners).
    const blockedUntil = Date.now() + 35000;
    while (Date.now() < blockedUntil) {
      /* QA only */
    }
  } else if (stage === "idle") {
    await api.patch("/settings", {
      inactivity_ms: 120000,
      warn_before_ms: 60000,
      hidden_ms: 60000,
      debounce_ms: 1000,
      clipboard_clear_ms: 30000,
      update_check_enabled: false,
    });
    sessionStorage.setItem("qa-lock-stage", "native");
    await invoke("qa_lock");
  } else if (stage === "native") {
    sessionStorage.setItem("qa-lock-stage", "rotation");
    sessionStorage.setItem("qa-password", "Desktop-Rotated-Canary-2027!");
    await api.patch("/master_password/update", {
      master_password: "Desktop-GUI-Canary-2026!",
      new_master_password: "Desktop-Rotated-Canary-2027!",
    });
  } else if (stage === "rotation") {
    const old = await api.post("/master_password/unlock", {
      master_password: "Desktop-GUI-Canary-2026!",
    });
    if (old.data.valid) throw new Error("old password survived rotation");
    sessionStorage.setItem("qa-lock-stage", "rotation-back");
    sessionStorage.removeItem("qa-password");
    await api.patch("/master_password/update", {
      master_password: "Desktop-Rotated-Canary-2027!",
      new_master_password: "Desktop-GUI-Canary-2026!",
    });
  } else if (stage === "rotation-back") {
    sessionStorage.setItem("qa-lock-stage", "shortcut");
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "L",
        code: "KeyL",
        metaKey: true,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      })
    );
  } else {
    await invoke("clipboard_write", { value: "Native-quit-clipboard-canary", timeoutMs: 300000 });
    await invoke("qa_report", {
      result: {
        ok: true,
        fresh: JSON.parse(sessionStorage.getItem("qa-fresh")),
        checks: [
          ...JSON.parse(sessionStorage.getItem("qa-checks")),
          "manual lock then UI unlock",
          "native idle lock while WebView timers cannot execute",
          "native lock callback then UI unlock",
          "master password rotated through Tauri; old password rejected; UI unlock with new password",
          "lock keyboard shortcut then UI unlock",
        ],
        core: await coreStatus(),
        backup: JSON.parse(sessionStorage.getItem("qa-backup-metrics") || "null"),
        interactive_ms: Number(sessionStorage.getItem("qa-interactive-ms")),
      },
    });
  }
} catch (error) {
  await invoke("qa_report", {
    result: {
      ok: false,
      checks,
      error: error instanceof Error ? error.message : String(error),
      text: document.body.innerText.slice(0, 1500),
    },
  });
}
