import { IS_DESKTOP } from "./platform";
let desktopSession = null;
const SESSION = "nedraSession";
const USER = "nedraUser";
const LEGACY_SESSION = "ciphermothSession";
const LEGACY_USER = "ciphermothUser";
const LEGACY_KEY = "keyDerivation";
export const LOGOUT_NOTICE = "logout_notice";

export const setSessionToken = (token) => {
  if (!token) return;
  if (IS_DESKTOP) desktopSession = token;
  else sessionStorage.setItem(SESSION, token);
};

export const getSessionToken = () => {
  if (IS_DESKTOP) return desktopSession;
  const token = sessionStorage.getItem(SESSION) ?? sessionStorage.getItem(LEGACY_SESSION);
  if (token && !sessionStorage.getItem(SESSION)) sessionStorage.setItem(SESSION, token);
  sessionStorage.removeItem(LEGACY_SESSION);
  return token;
};
export const isAuth = () => !!getSessionToken();
export const setCurrentUser = (user) => {
  if (user) sessionStorage.setItem(USER, JSON.stringify(user));
  else sessionStorage.removeItem(USER);
};
export const getCurrentUser = () => {
  try {
    const value = sessionStorage.getItem(USER) ?? sessionStorage.getItem(LEGACY_USER);
    if (value && !sessionStorage.getItem(USER)) sessionStorage.setItem(USER, value);
    sessionStorage.removeItem(LEGACY_USER);
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export const forgetLegacyKey = () => sessionStorage.removeItem(LEGACY_KEY);

export const clearSession = () => {
  desktopSession = null;
  sessionStorage.removeItem(SESSION);
  sessionStorage.removeItem(USER);
  sessionStorage.removeItem(LEGACY_SESSION);
  sessionStorage.removeItem(LEGACY_USER);
  forgetLegacyKey();
};
