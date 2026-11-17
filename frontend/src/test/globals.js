import { vi } from "vitest";

export const memoryStorage = () => {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
    clear: () => items.clear(),
    entries: () => Object.fromEntries(items),
  };
};

export const stubBrowser = () => {
  const storage = memoryStorage();
  const location = { reload: vi.fn(), replace: vi.fn() };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", { location });
  return { storage, location };
};
