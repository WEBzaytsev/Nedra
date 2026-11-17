import { gcm } from "@noble/ciphers/aes.js";

const PREFIX = "nedra-entry-draft:v1:";
const MAX_DRAFT_BYTES = 1024 * 1024;
const NONCE_BYTES = 12;
const encode = (bytes) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const decode = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export const createEntryDraftStore = ({ user_id, key: encodedKey }) => {
  if (!Number.isSafeInteger(user_id) || user_id <= 0) throw new Error("Invalid draft owner");
  const key = decode(encodedKey);
  if (key.length !== 32) throw new Error("Invalid draft key");
  const storageKey = `${PREFIX}${user_id}`;
  const encoder = new TextEncoder();

  const decodeDraft = (stored, keyName) => {
    if (stored.length > MAX_DRAFT_BYTES * 2) throw new Error("Draft is too large");
    const sealed = decode(stored);
    const plaintext = gcm(key, sealed.slice(0, NONCE_BYTES), encoder.encode(keyName)).decrypt(
      sealed.slice(NONCE_BYTES)
    );
    try {
      return JSON.parse(new TextDecoder().decode(plaintext));
    } finally {
      plaintext.fill(0);
    }
  };

  const writeDraft = (form) => {
    const plaintext = encoder.encode(JSON.stringify(form));
    try {
      if (plaintext.length > MAX_DRAFT_BYTES) throw new Error("Draft is too large");
      const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const ciphertext = gcm(key, iv, encoder.encode(storageKey)).encrypt(plaintext);
      const sealed = new Uint8Array(NONCE_BYTES + ciphertext.length);
      sealed.set(iv);
      sealed.set(ciphertext, NONCE_BYTES);
      sessionStorage.setItem(storageKey, encode(sealed));
    } finally {
      plaintext.fill(0);
    }
  };

  return {
    read() {
      const stored = sessionStorage.getItem(storageKey);
      if (!stored) return null;
      return decodeDraft(stored, storageKey);
    },
    write(form) {
      // Native lock can destroy the renderer without a JS callback. Persist in
      // this input event, not in an async encryption or a later React effect.
      writeDraft(form);
    },
    clear() {
      sessionStorage.removeItem(storageKey);
    },
  };
};
