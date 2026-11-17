import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { IS_DESKTOP } from "./index";

const handlers = new Map();
const ANYTIME = new Set(["lock", "toggle-theme"]);
const dialogOpen = () => Boolean(document.querySelector('[role="dialog"], [role="menu"]'));

export const dispatchMenuAction = (id) => {
  const handler = handlers.get(id);
  if (!handler || (!ANYTIME.has(id) && dialogOpen())) return false;
  handler();
  return true;
};

export const onMenuAction = (id, handler) => {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
};

export const listenForMenuActions = () =>
  listen("menu-action", (event) => dispatchMenuAction(event.payload));

export const setMenuUnlocked = (unlocked) =>
  IS_DESKTOP ? invoke("menu_state", { unlocked }).catch(() => {}) : Promise.resolve();
