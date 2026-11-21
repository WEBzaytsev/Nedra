declare const __TARGET__: "chromium" | "firefox";
declare const __VERSION__: string;
declare const __NATIVE_HOST__: string;

export const TARGET = __TARGET__;
export const VERSION = __VERSION__;

export const NATIVE_HOST = __NATIVE_HOST__;

export const FEATURE = "browser-extension";
export const SESSION_HEADER = "x-nedra-session";
export const REQUEST_TIMEOUT_MS = 15_000;

export const HANDOFF_CHECK_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const HANDOFF_TTL_MS = 5 * 60 * 1000;
export const CLIPBOARD_CLEAR_MS = 30_000;
export const BADGE_MS = 2_000;

export const BRIDGE_SCRIPT_ID = "nedra-vault-bridge";
export const SESSION_MESSAGE = "nedra:extension-session";
export const CONNECTED_MESSAGE = "nedra:extension-connected";
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const HANDOFF_REDEEM_PATTERN = /^[A-Za-z0-9_-]{22,43}$/;

export const BROWSERS = [
  "Chrome",
  "Chromium",
  "Edge",
  "Brave",
  "Opera",
  "Vivaldi",
  "Firefox",
  "Browser",
] as const;
export type BrowserName = (typeof BROWSERS)[number];
