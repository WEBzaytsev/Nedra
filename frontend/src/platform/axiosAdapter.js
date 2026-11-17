import axios from "axios";
import { coreRequest, coreCancel } from "./core";

const toBytes = async (data, headers) => {
  if (data === undefined || data === null) return { body: undefined };
  if (data instanceof FormData) {
    const encoded = new Response(data);
    return {
      body: new Uint8Array(await encoded.arrayBuffer()),
      contentType: encoded.headers.get("content-type"),
    };
  }
  if (data instanceof Uint8Array) return { body: data };
  if (data instanceof ArrayBuffer) return { body: new Uint8Array(data) };
  if (typeof data === "string") return { body: new TextEncoder().encode(data) };
  return {
    body: new TextEncoder().encode(JSON.stringify(data)),
    contentType: headers["Content-Type"] || "application/json",
  };
};

export async function ipcAdapter(config) {
  const url = new URL(axios.getUri(config), "http://core.invalid");
  const headers = axios.AxiosHeaders.from(config.headers);
  const { body, contentType } = await toBytes(config.data, headers);
  const forwarded = [];
  const type = contentType || headers.get("content-type");
  if (type) forwarded.push(["content-type", type]);
  for (const name of ["x-nedra-entry", "x-nedra-session"]) {
    if (headers.get(name)) forwarded.push([name, headers.get(name)]);
  }
  if (config.signal?.aborted) throw new axios.CanceledError();
  const clientId = crypto.randomUUID();
  const cancel = () => coreCancel(clientId).catch(() => {});
  config.signal?.addEventListener("abort", cancel, { once: true });
  let reply;
  try {
    reply = await coreRequest({
      method: config.method.toUpperCase(),
      path: url.pathname,
      query: url.search.replace(/^\?/, ""),
      headers: forwarded,
      body,
      timeoutMs: config.timeout || 30000,
      clientId,
    });
  } finally {
    config.signal?.removeEventListener("abort", cancel);
  }
  if (config.signal?.aborted) throw new axios.CanceledError();
  const responseHeaders = Object.fromEntries(reply.headers);
  let data =
    config.responseType === "blob"
      ? new Blob([reply.body], { type: responseHeaders["content-type"] })
      : reply.body;
  if (config.responseType !== "arraybuffer" && config.responseType !== "blob") {
    const text = new TextDecoder().decode(reply.body);
    try {
      data = text ? JSON.parse(text) : "";
    } catch {
      data = text;
    }
  }
  const response = {
    data,
    status: reply.status,
    statusText: "",
    headers: responseHeaders,
    config,
    request: null,
  };
  if (config.validateStatus && !config.validateStatus(reply.status)) {
    throw new axios.AxiosError(
      `Request failed with status code ${reply.status}`,
      axios.AxiosError.ERR_BAD_RESPONSE,
      config,
      null,
      response
    );
  }
  return response;
}

export const coreAxios = axios.create({ baseURL: "/api", adapter: ipcAdapter });
