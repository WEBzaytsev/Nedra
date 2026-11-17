import { AxiosError } from "axios";

export const replyWith = (status, data, seen = []) => {
  return async (config) => {
    seen.push(config);
    const response = { data, status, statusText: "", headers: {}, config, request: {} };
    if (status >= 400) {
      throw new AxiosError(`HTTP ${status}`, "ERR_BAD_RESPONSE", config, {}, response);
    }
    return response;
  };
};

export const routes = (table, seen = []) => {
  return async (config) => {
    seen.push(config);
    const [status, data] = table[`${config.method.toUpperCase()} ${config.url}`] ?? [404, {}];
    return replyWith(status, data)(config);
  };
};
