import { describe, expect, it } from "vitest";

import { HISTORY_LIMIT, historyDuration, historyTimeline, reusePayload } from "./passwordHistory";

const entry = {
  password_name: "Shared login",
  kind: "login",
  username: "member@example.test",
  password_value: "current",
  url: "https://example.test",
  totp_secret: "JBSWY3DPEHPK3PXP",
  description: "shared",
  tags: ["team"],
  custom_fields: [{ label: "PIN", value: "1234", hidden: true }],
  folder: "Engineering",
  folder_id: 7,
  favorite: true,
  password_history: [
    { value: "previous", changed_at: "2026-11-02T12:00:00Z" },
    { value: "current", changed_at: "2026-10-01T12:00:00Z" },
    { value: "oldest", changed_at: "2026-01-01T12:00:00Z" },
  ],
};

describe("password history", () => {
  it("shows current and previous values with replacement spans and duplicate markers", () => {
    const rows = historyTimeline(entry);
    expect(rows.map((row) => row.value)).toEqual(["current", "previous", "current", "oldest"]);
    expect(rows[0].current).toBe(true);
    expect(rows[1]).toMatchObject({
      since: new Date("2026-10-01T12:00:00Z"),
      until: new Date("2026-11-02T12:00:00Z"),
      sameAsCurrent: false,
    });
    expect(rows[2].sameAsCurrent).toBe(true);
    expect(rows[3].since).toBeNull();
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("calculates only valid password-use durations", () => {
    expect(
      historyDuration(new Date("2026-10-01T00:00:00Z"), new Date("2026-11-02T00:00:00Z"))
    ).toEqual({
      unit: "month",
      count: 1,
    });
    expect(
      historyDuration(new Date("2026-11-02T00:00:00Z"), new Date("2026-11-02T12:00:00Z"))
    ).toEqual({
      lessThanDay: true,
    });
    expect(
      historyDuration(new Date("2026-11-03T00:00:00Z"), new Date("2026-11-02T00:00:00Z"))
    ).toBeNull();
  });

  it("identifies a history item without sending the entry snapshot or password", () => {
    expect(HISTORY_LIMIT).toBe(10);
    expect(reusePayload(entry, historyTimeline(entry)[1])).toEqual({
      password_name: "Shared login",
      history_index: 0,
      changed_at: "2026-11-02T12:00:00Z",
    });
  });
});
