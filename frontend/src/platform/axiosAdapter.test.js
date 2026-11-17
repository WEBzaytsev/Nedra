import { beforeEach, expect, it, vi } from "vitest";
import axios from "axios";
import { ipcAdapter } from "./axiosAdapter";
import { coreRequest, coreCancel } from "./core";
vi.mock("./core", () => ({ coreRequest: vi.fn(), coreCancel: vi.fn().mockResolvedValue(true) }));
const client = axios.create({ baseURL: "/api", adapter: ipcAdapter });
beforeEach(() => {
  vi.clearAllMocks();
  coreRequest.mockResolvedValue({
    status: 200,
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode('{"ok":true}'),
  });
});
it("forwards the opaque session and encoded name without external HTTP", async () => {
  await client.get("/passwords/a%2Fb", {
    headers: {
      "X-Nedra-Session": "opaque",
      "X-Nedra-Entry": "a%2Fb",
      Authorization: "not forwarded",
    },
    params: { entry_id: 2 },
  });
  expect(coreRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/api/passwords/a%2Fb",
      query: "entry_id=2",
      headers: [
        ["x-nedra-entry", "a%2Fb"],
        ["x-nedra-session", "opaque"],
      ],
    })
  );
});
it("preserves binary blob responses", async () => {
  coreRequest.mockResolvedValue({
    status: 200,
    headers: [["content-type", "application/octet-stream"]],
    body: new Uint8Array([0, 255, 128, 13]),
  });
  const result = await client.get("/passwords/x/attachments/1", { responseType: "blob" });
  expect(new Uint8Array(await result.data.arrayBuffer())).toEqual(
    new Uint8Array([0, 255, 128, 13])
  );
});
it("encodes native webview multipart with its generated boundary", async () => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([0, 255])]), "file.bin");
  await client.post("/passwords/x/attachments", form);
  const request = coreRequest.mock.calls[0][0];
  expect(request.headers[0][1]).toMatch(/^multipart\/form-data; boundary=/);
  expect(request.body).toBeInstanceOf(Uint8Array);
});
it("preserves backend error shape for session revocation", async () => {
  coreRequest.mockResolvedValue({
    status: 401,
    headers: [],
    body: new TextEncoder().encode('{"code":"invalid_session"}'),
  });
  await expect(client.get("/passwords")).rejects.toMatchObject({
    response: { status: 401, data: { code: "invalid_session" } },
  });
});
it("does not send requests already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(client.get("/passwords", { signal: controller.signal })).rejects.toMatchObject({
    code: "ERR_CANCELED",
  });
  expect(coreRequest).not.toHaveBeenCalled();
});
it("forwards cancellation with the original private request id", async () => {
  const controller = new AbortController();
  let finish;
  coreRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const request = client.get("/passwords", { signal: controller.signal });
  await vi.waitFor(() => expect(coreRequest).toHaveBeenCalled());
  controller.abort();
  finish({ status: 200, headers: [], body: new Uint8Array() });
  await expect(request).rejects.toMatchObject({ code: "ERR_CANCELED" });
  expect(coreCancel).toHaveBeenCalledWith(coreRequest.mock.calls[0][0].clientId);
});
