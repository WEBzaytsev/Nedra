import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { formatPairingCode, toExtensionStatus } = await import("./extension");

describe("desktop extension status", () => {
  it("normalizes native values without trusting their shape", () => {
    expect(
      toExtensionStatus({
        enabled: true,
        listening: true,
        browsers: ["Chrome", 3],
        pairings: [{ id: "id", browser: "Firefox", created: 1_800_000_000, last_used: null }],
      })
    ).toEqual({
      enabled: true,
      listening: true,
      browsers: ["Chrome"],
      pairings: [
        { id: "id", browser: "Firefox", created: "2027-01-15T08:00:00.000Z", lastUsed: null },
      ],
      error: null,
    });
  });

  it("formats exactly six pairing digits", () => {
    expect(formatPairingCode("004000")).toBe("004 000");
    expect(formatPairingCode("00400")).toBe("");
  });
});
