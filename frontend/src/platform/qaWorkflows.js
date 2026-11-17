// Imported only by the dedicated native QA build; all records are synthetic.
import { invoke } from "@tauri-apps/api/core";
import api from "../api/client";
import { getSessionToken } from "../utils";
import { generatePassword } from "../lib/passwordGenerator";
import { generateTotp } from "../lib/totp";

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const path = "/passwords/Native%20transport%20entry";
const entry = {
  password_name: "Native transport entry",
  password_value: "Transport-secret-2026!",
  folder: "QA folder",
  tags: ["native", "synthetic"],
  favorite: true,
  totp_secret: "JBSWY3DPEHPK3PXP",
};

export async function workflows(checks) {
  const wrong = await api.post("/master_password/unlock", { master_password: "Incorrect-2026!" });
  ensure(wrong.data.valid === false, "wrong master password accepted");
  checks.push("incorrect password rejected through Tauri");
  await api.post("/passwords/create", entry);
  await api.patch("/passwords/update", {
    password: entry,
    new_password: { ...entry, password_value: "Updated-transport-2026!" },
  });
  const rows = (await api.get("/passwords")).data;
  const saved = rows.find((row) => row.password_name === entry.password_name);
  ensure(saved?.password_history[0]?.value === entry.password_value, "history missing");
  ensure(
    saved.favorite && saved.folder === entry.folder && saved.tags.includes("native"),
    "organization lost"
  );
  ensure(/^\d{6}$/.test(await generateTotp(saved.totp_secret)), "native WebCrypto TOTP failed");
  await api.patch(path + "/favorite", { favorite: false });
  const note = {
    password_name: "Native secure note",
    password_value: "Synthetic note body",
    kind: "note",
  };
  await api.post("/passwords/create", note);
  await api.patch("/passwords/update", {
    password: note,
    new_password: { ...note, password_value: "Edited note body" },
  });
  await api.delete("/passwords/Native%20secure%20note");
  ensure(
    (await api.get("/passwords/trash")).data.some((row) => row.kind === "note"),
    "note missing from Trash"
  );
  await api.post("/passwords/Native%20secure%20note/restore");
  const generated = generatePassword({
    length: 32,
    uppercase: true,
    lowercase: true,
    numbers: true,
    symbols: true,
  });
  ensure(generated.length === 32, "password generator failed");
  await invoke("clipboard_write", { value: generated, timeoutMs: 1000 });
  checks.push(
    "Tauri login/note CRUD, folders, tags, favorites, history, Trash, TOTP and generated-password copying"
  );

  const bytes = new Uint8Array(5 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  for (let i = 0; i < 5; i++) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), `binary-${i}.bin`);
    await api.post(path + "/attachments", form);
  }
  const session = getSessionToken();
  const started = performance.now();
  await invoke("qa_report", { result: { stage: "large_backup" } });
  const backup = await invoke("qa_backup", {
    operation: "backup_export",
    session,
    password: "Desktop-GUI-Canary-2026!",
  });
  ensure(backup.bytes > 24 * 1024 * 1024 && backup.result.saved, "large native export incomplete");
  await invoke("qa_report", { result: { stage: "backup_exported" } });
  await api.delete(path);
  await api.delete(path + "/purge");
  const restored = await invoke("qa_backup", {
    operation: "backup_import",
    session,
    password: "Desktop-GUI-Canary-2026!",
  });
  ensure(restored.result.attachments === 5, "large native restore incomplete");
  await invoke("qa_report", { result: { stage: "backup_restored" } });
  const attachments = (await api.get(path + "/attachments")).data;
  ensure(attachments.length === 5, "restored attachment count");
  for (const attachment of attachments) {
    await invoke("qa_report", { result: { stage: "verify_attachment", id: attachment.id } });
    const downloaded = (
      await api.get(path + `/attachments/${attachment.id}`, { responseType: "arraybuffer" })
    ).data;
    ensure(
      downloaded.length === bytes.length && downloaded.every((b, i) => b === bytes[i]),
      "binary restore mismatch"
    );
  }
  sessionStorage.setItem(
    "qa-backup-metrics",
    JSON.stringify({ bytes: backup.bytes, roundtrip_ms: Math.round(performance.now() - started) })
  );
  checks.push(
    "Tauri native backup over 24 MiB restored; five binary attachments verified byte-for-byte"
  );
}
