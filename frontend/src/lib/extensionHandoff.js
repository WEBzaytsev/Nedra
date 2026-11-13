const HANDOFF_KEY = "nedraExtensionHandoff";
export const HANDOFF_ROUTE = "#/connect-extension";
export const ACK_TIMEOUT_MS = 10_000;
const TTL_MS = 5 * 60 * 1000;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT = /^[A-Za-z0-9_-]{22,43}$/;
const BROWSERS = new Set([
  "Chrome",
  "Chromium",
  "Edge",
  "Brave",
  "Opera",
  "Vivaldi",
  "Firefox",
  "Browser",
]);

export const captureHandoff = ({ location = window.location, history = window.history } = {}) => {
  const hash = location.hash || "";
  if (hash !== HANDOFF_ROUTE && !hash.startsWith(`${HANDOFF_ROUTE}?`)) return null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  const params = new URLSearchParams(hash.slice(HANDOFF_ROUTE.length + 1));
  const request = params.get("request");
  const browser = params.get("browser");
  const client = params.get("client");
  const tab = params.get("tab");
  if (
    !NONCE.test(request ?? "") ||
    !NONCE.test(tab ?? "") ||
    !BROWSERS.has(browser) ||
    (client && !CLIENT.test(client))
  )
    return null;
  const handoff = { request, tab, browser, client: client || null, expires: Date.now() + TTL_MS };
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  return handoff;
};

export const pendingHandoff = () => {
  try {
    const handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null");
    if (
      handoff?.expires > Date.now() &&
      NONCE.test(handoff.request) &&
      NONCE.test(handoff.tab) &&
      BROWSERS.has(handoff.browser) &&
      CLIENT.test(handoff.client ?? "")
    )
      return handoff;
  } catch {
    // Malformed tab-local state is discarded below.
  }
  sessionStorage.removeItem(HANDOFF_KEY);
  return null;
};

export const clearHandoff = () => sessionStorage.removeItem(HANDOFF_KEY);

export const deliverToken = ({ request, redeem }) =>
  new Promise((resolve) => {
    const origin = window.location.origin;
    const onMessage = (event) => {
      if (
        event.source === window &&
        event.origin === origin &&
        event.data?.type === "ciphermoth:extension-connected" &&
        event.data.request === request
      )
        finish(true);
    };
    const finish = (accepted) => {
      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(accepted);
    };
    window.addEventListener("message", onMessage);
    const timeout = setTimeout(() => finish(false), ACK_TIMEOUT_MS);
    window.postMessage({ type: "ciphermoth:extension-session", request, redeem }, origin);
  });
