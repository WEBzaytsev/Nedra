import i18n from "../i18n/index.js";

const russianErrors = {
  "This security key does not support the required PRF extension.":
    "auth.securityKeyPrfUnavailable",
  "WebAuthn is not available in this client.": "auth.deviceUnlockUnavailable",
  "No registered security key matches this vault address.": "auth.securityKeyNoMatch",
  "This security-key relying party does not match this vault address.":
    "auth.securityKeyAddressMismatch",
  "Your session expired.": "auth.sessionEnded",
};

export const errorMessage = (error, fallback) => {
  const message = typeof error === "string" ? error : error?.message;
  const key =
    (i18n.resolvedLanguage ?? i18n.language) === "ru" ? russianErrors[message] : undefined;
  return key ? i18n.t(key) : message || fallback;
};
