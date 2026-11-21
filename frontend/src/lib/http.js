import { IS_DESKTOP, saveFile } from "../platform";
import i18n from "../i18n";

const detailMessage = (detail, fallback) => {
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .filter((e) => typeof e?.msg === "string")
      .map((e) => {
        const field = Array.isArray(e.loc) ? e.loc.slice(1).join(".") : "";
        const message = e.msg.replace(/^Value error,\s*/i, "");
        if (field === "username") {
          return `${i18n.t("auth.username")}: ${
            e.type === "string_pattern_mismatch" ? i18n.t("auth.usernameRules") : message
          }`;
        }
        return field ? `${field}: ${message}` : message;
      });
    return msgs.length ? msgs.join("; ") : fallback;
  }
  return fallback;
};

export const errorDetail = async (err, fallback) => {
  const data = err.response?.data;
  if (data instanceof Blob) {
    try {
      return detailMessage(JSON.parse(await data.text()).detail, fallback);
    } catch {
      return fallback;
    }
  }
  return detailMessage(data?.detail, fallback);
};

export const triggerDownload = (blob, filename) => {
  if (IS_DESKTOP) return saveFile(blob, filename);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
