import apiClient from "../api/client";
import { getSessionToken } from "../utils";
import { securityKeyAssertion } from "./securityKey";

const base64url = (value) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
};

const context = async (action, fields) => {
  const token = getSessionToken();
  if (!token) throw new Error("Your session expired.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = new TextEncoder().encode(
    `nedra/security-step-up-context/v1\0${action}\0${JSON.stringify(canonical(fields))}`
  );
  return base64url(await crypto.subtle.sign("HMAC", key, bytes));
};

export const securityKeyStepUp = async (action, fields) => {
  const { data } = await apiClient.post("/security/step-up/options", {
    action,
    context: await context(action, fields),
  });
  return data.required ? securityKeyAssertion(data.challenge) : undefined;
};
