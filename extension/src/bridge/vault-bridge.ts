import {
  CONNECTED_MESSAGE,
  HANDOFF_REDEEM_PATTERN,
  SESSION_MESSAGE,
  TOKEN_PATTERN,
} from "../shared/constants";

(() => {
  if (window.top !== window) return;
  const bridgeWindow = window as typeof window & { __nedraVaultBridge?: boolean };
  if (bridgeWindow.__nedraVaultBridge) return;
  bridgeWindow.__nedraVaultBridge = true;
  const runtime =
    (globalThis as unknown as { browser?: typeof chrome }).browser?.runtime ?? chrome.runtime;

  let attempts = 0;
  let done = false;

  const onMessage = (event: MessageEvent) => {
    if (done || event.origin !== location.origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (
      typeof data !== "object" ||
      data === null ||
      Object.keys(data).length !== 3 ||
      data.type !== SESSION_MESSAGE ||
      typeof data.request !== "string" ||
      typeof data.redeem !== "string" ||
      !TOKEN_PATTERN.test(data.request) ||
      !HANDOFF_REDEEM_PATTERN.test(data.redeem)
    )
      return;
    attempts += 1;
    if (attempts > 5) {
      done = true;
      window.removeEventListener("message", onMessage);
      return;
    }
    const request = data.request;
    runtime
      .sendMessage({ type: "handoff-token", request, redeem: data.redeem })
      .then((reply: { ok?: boolean; value?: boolean } | undefined) => {
        if (reply?.ok && reply.value === true) {
          done = true;
          window.removeEventListener("message", onMessage);
          window.postMessage({ type: CONNECTED_MESSAGE, request }, location.origin);
        }
      })
      .catch(() => {});
  };

  window.addEventListener("message", onMessage);
})();
