// "Unlock in CipherMoth": the web app unlocks (master password, security key,
// passkey) and hands this extension a session token.
//
// 1. A random 256-bit request nonce is made here and never sent to a server
//    (it travels in the URL fragment).
// 2. The bridge content script is registered for the vault's origin only, for
//    as long as the request is pending, and a tab opens
//    <vault>/#/connect-extension?request=<nonce>&browser=<name>.
// 3. After the user confirms in the web app, it posts the token to its own
//    window; the bridge forwards it here.
// 4. The token is accepted once, only from the top frame of that tab, on that
//    origin, with that nonce, within five minutes, and only after the server
//    confirms it is a live extension session.

import { request } from "./api";
import { adoptToken, browserName } from "./session";
import { getHandoff, getServer, installId, setHandoff } from "./storage";
import { ext, randomToken, sameSecret } from "../shared/browser";
import { HANDOFF_TTL_MS } from "../shared/constants";
import type { MessageOf } from "../shared/messages";

export const HANDOFF_ALARM = "ciphermoth-handoff-expired";
const CLOSE_DELAY_MS = 1500;

const waitForHandoffPage = (tabId: number, vault: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let onVaultOrigin = false;
    const ready = (tab: chrome.tabs.Tab, url?: string) => {
      if (tab.id !== tabId) return;
      if (url) {
        try {
          onVaultOrigin = new URL(url).origin === vault;
        } catch {
          onVaultOrigin = false;
        }
      }
      if (!onVaultOrigin || tab.status !== "complete") return;
      ext.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (_id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) =>
      ready(tab, change.url);
    ext.tabs.onUpdated.addListener(onUpdated);
    ext.tabs.get(tabId).then((tab) => ready(tab, tab.url), reject);
  });

const bridgeInTab = async (tabId: number): Promise<void> => {
  await ext.scripting.executeScript({ target: { tabId }, files: ["bridge.js"] });
};

export const injectHandoffBridge = async (
  tabId: number,
  url: string | undefined
): Promise<void> => {
  const pending = await getHandoff();
  if (!pending || pending.tabId !== tabId || Date.now() >= pending.expires || !url) return;
  try {
    if (new URL(url).origin !== pending.vault) return;
  } catch {
    return;
  }
  await bridgeInTab(tabId).catch(() => {});
};

const clearHandoff = async (): Promise<void> => {
  await setHandoff(null);
  await ext.alarms.clear(HANDOFF_ALARM);
};

export const cancelHandoff = async (): Promise<void> => {
  const [pending, config] = await Promise.all([getHandoff(), getServer()]);
  if (pending && config) {
    await request(config.api, "/extension/handoffs/cancel", {
      body: {
        request: pending.request,
        tab: pending.tab,
        origin: pending.vault,
        browser: browserName(),
        client: await installId(),
      },
    }).catch(() => {});
  }
  await clearHandoff();
};

export const startHandoff = async (): Promise<void> => {
  const config = await getServer();
  if (!config) throw new Error("Connect to your CipherMoth first.");
  await cancelHandoff();
  const requestNonce = randomToken(32);
  const tab = randomToken(32);
  const client = await installId();
  const browser = browserName();
  await request(config.api, "/extension/handoffs/start", {
    body: { request: requestNonce, tab, origin: config.vault, browser, client },
  });
  const url = `${config.vault}/#/connect-extension?request=${requestNonce}&tab=${tab}&browser=${browser}&client=${client}`;
  // Back to this tab when the handoff tab closes (Chrome would otherwise pick a
  // neighbour). Only its id is read: no tabs permission, no address.
  const [current] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  const returnTo = current?.id ?? null;
  const handoffTab = await ext.tabs.create({ url: "about:blank", active: true });
  if (handoffTab.id === undefined) {
    await request(config.api, "/extension/handoffs/cancel", {
      body: { request: requestNonce, tab, origin: config.vault, browser, client },
    }).catch(() => {});
    throw new Error("Could not open CipherMoth.");
  }
  const handoffTabId = handoffTab.id;
  const expires = Date.now() + HANDOFF_TTL_MS;
  await setHandoff({
    request: requestNonce,
    tab,
    tabId: handoffTabId,
    vault: config.vault,
    expires,
    returnTo,
  });
  await ext.alarms.create(HANDOFF_ALARM, { when: expires });
  try {
    const ready = waitForHandoffPage(handoffTabId, config.vault);
    await ext.tabs.update(handoffTabId, { url });
    await ready;
  } catch {
    await request(config.api, "/extension/handoffs/cancel", {
      body: { request: requestNonce, tab, origin: config.vault, browser, client },
    }).catch(() => {});
    await clearHandoff();
    throw new Error("Could not open CipherMoth.");
  }
};

const senderOrigin = (sender: chrome.runtime.MessageSender): string | null => {
  const raw = (sender as { origin?: string }).origin ?? sender.url;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

export const receiveToken = async (
  message: MessageOf<"handoff-token">,
  sender: chrome.runtime.MessageSender
): Promise<boolean> => {
  const pending = await getHandoff();
  if (
    !pending ||
    Date.now() >= pending.expires ||
    sender.id !== ext.runtime.id ||
    sender.tab?.id !== pending.tabId ||
    sender.frameId !== 0 ||
    senderOrigin(sender) !== pending.vault ||
    !sameSecret(message.request, pending.request)
  )
    return false;
  // Single use locally before redeeming the server-bound capability.
  await clearHandoff();
  const config = await getServer();
  if (!config || config.vault !== pending.vault) return false;
  const redeemed = await request(config.api, "/extension/handoffs/redeem", {
    body: {
      request: message.request,
      tab: pending.tab,
      redeem: message.redeem,
      browser: browserName(),
      client: await installId(),
    },
  }).catch(() => null);
  const token =
    typeof redeemed === "object" &&
    redeemed !== null &&
    typeof (redeemed as { session_token?: unknown }).session_token === "string"
      ? (redeemed as { session_token: string }).session_token
      : null;
  const adopted = token !== null && (await adoptToken(token));
  if (adopted) {
    setTimeout(() => {
      ext.tabs.remove(pending.tabId).catch(() => {});
      if (pending.returnTo !== null)
        ext.tabs.update(pending.returnTo, { active: true }).catch(() => {});
    }, CLOSE_DELAY_MS);
  }
  return adopted;
};
