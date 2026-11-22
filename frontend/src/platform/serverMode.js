export const SERVER_SELECTION = "nedraServerSelection";

export const serverFailure = (reason) =>
  String(reason).includes("WebView2") ? "webviewUnavailable" : "serverFailed";

export const validServerAddress = (value) => {
  if (
    [...value].some((char) => {
      const code = char.codePointAt(0);
      return code < 32 || (code >= 127 && code <= 159) || char === "\\";
    })
  )
    return false;
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed);
    return (
      /^https:\/\//i.test(trimmed) &&
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !value.includes("?") &&
      !value.includes("#")
    );
  } catch {
    return false;
  }
};

export const initialDesktopMode = (saved, selecting = false) => {
  if (selecting || !saved.selected) {
    return {
      screen: saved.origin && !selecting ? "server" : "choose",
      autoConnect: false,
    };
  }
  if (saved.origin) return { screen: "server", autoConnect: true };
  return { screen: "local", autoConnect: false };
};

export const statusMatchesOrigin = (payloadOrigin, expectedOrigin) => {
  if (!payloadOrigin || !expectedOrigin) return true;
  try {
    return new URL(payloadOrigin).origin === expectedOrigin;
  } catch {
    return false;
  }
};
