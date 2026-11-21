import { normalizeOrigin, originString, serverOrigin } from "./url";

export interface Target {
  vault: string;
  api: string;
}

const apiFor = (vault: string, api: string | null): string | null => {
  if (!api) return `${vault}/api`;
  const origin = serverOrigin(api);
  if (!origin) return null;
  const raw = api.includes("://") ? api : `https://${api}`;
  let path: string;
  try {
    path = new URL(raw).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
  return `${originString(origin)}${path || "/api"}`;
};

export const targetFor = (vaultInput: string, apiInput: string | null): Target | string => {
  const vault = serverOrigin(vaultInput);
  if (!vault) {
    return normalizeOrigin(vaultInput)
      ? "Use an https:// address (plain http only works for localhost)."
      : "That doesn't look like a web address.";
  }
  const vaultOrigin = originString(vault);
  const api = apiFor(vaultOrigin, apiInput?.trim() || null);
  if (!api) return "Use an https:// address for the API (plain http only works for localhost).";
  return { vault: vaultOrigin, api };
};

export const hostPattern = (origin: string): string => {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
};

export const permissionOrigins = (target: Target): string[] => [
  ...new Set([hostPattern(target.vault), hostPattern(target.api)]),
];

export const notNeededBy = (origins: string[], keep: string[]): string[] =>
  origins.filter((origin) => !keep.includes(origin));
