import { IS_DESKTOP } from "./platform";
let desktopSession = null;
const SESSION = "nedraSession";
const USER = "nedraUser";
export const DESKTOP_SERVER_SESSION = "nedraDesktopServerSession";

export const LOGOUT_NOTICE = "logout_notice";

export const setSessionToken = (token) => {
  if (!token) return;
  if (IS_DESKTOP) desktopSession = token;
  else sessionStorage.setItem(SESSION, token);
};

export const getSessionToken = () => {
  if (IS_DESKTOP) return desktopSession;
  return sessionStorage.getItem(SESSION);
};
export const isAuth = () => !!getSessionToken();
export const setCurrentUser = (user) => {
  if (user) sessionStorage.setItem(USER, JSON.stringify(user));
  else sessionStorage.removeItem(USER);
};
export const getCurrentUser = () => {
  try {
    const value = sessionStorage.getItem(USER);
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export const clearSession = () => {
  desktopSession = null;
  sessionStorage.removeItem(SESSION);
  sessionStorage.removeItem(USER);
};

export const isDesktopServerSession = () =>
  !IS_DESKTOP && sessionStorage.getItem(DESKTOP_SERVER_SESSION) === "1";
