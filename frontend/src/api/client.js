import axios from "axios";
import { IS_DESKTOP, clearClipboard } from "../platform";
import { ipcAdapter } from "../platform/axiosAdapter";

import { LOGOUT_NOTICE, clearSession, getSessionToken, isAuth } from "../utils";

export const SESSION_ENDED = "auth.sessionEnded";
export const SESSION_HEADER = "x-nedra-session";

const apiClient = axios.create({
  baseURL: IS_DESKTOP ? "/api" : import.meta.env.VITE_API_URL || "http://localhost:8000/api",
  ...(IS_DESKTOP ? { adapter: ipcAdapter } : {}),
});

apiClient.interceptors.request.use((config) => {
  const token = getSessionToken();
  if (token && !config.headers[SESSION_HEADER]) {
    config.headers[SESSION_HEADER] = token;
  }
  return config;
});

const errorCode = async (data) => {
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text()).code;
    } catch {
      return undefined;
    }
  }
  return data?.code;
};

const endsSession = async (response) => {
  if (!response || ![401, 403].includes(response.status)) return false;
  const code = await errorCode(response.data);
  return (
    (response.status === 401 && code === "invalid_session") ||
    (response.status === 403 && code === "invalid_key")
  );
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (isAuth() && (await endsSession(error.response))) {
      clearSession();
      await clearClipboard();
      sessionStorage.setItem(LOGOUT_NOTICE, SESSION_ENDED);
      window.location.reload();
    }
    return Promise.reject(error);
  }
);

export default apiClient;
