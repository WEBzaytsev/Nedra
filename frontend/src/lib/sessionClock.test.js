import { describe, expect, it } from "vitest";

import {
  deadlineFromStatus,
  earlierDeadline,
  heartbeatInterval,
  hiddenTooLong,
  shouldReport,
  warningLead,
} from "./sessionClock";

describe("heartbeat interval", () => {
  it.each([
    [30_000, 3_000],
    [120_000, 12_000],
    [3_600_000, 15_000],
    [5_000, 1_000],
  ])("for a %i ms timeout reports at most every %i ms", (inactivity, interval) => {
    expect(heartbeatInterval(inactivity)).toBe(interval);
  });

  it("keeps the effective timeout within 10% of the setting", () => {
    for (const inactivity of [30_000, 120_000, 600_000, 3_600_000]) {
      expect(heartbeatInterval(inactivity)).toBeLessThanOrEqual(inactivity / 10);
    }
  });
});

describe("reporting activity", () => {
  it("waits for the interval, unless the warning is showing", () => {
    const base = { lastReportedMs: 0, inactivityMs: 120_000, warning: false };
    expect(shouldReport({ ...base, now: 11_999 })).toBe(false);
    expect(shouldReport({ ...base, now: 12_000 })).toBe(true);
    expect(shouldReport({ ...base, now: 1, warning: true })).toBe(true);
  });
});

describe("deadlines come from the server", () => {
  const status = { idle_timeout_ms: 120_000, expires_in_ms: 30_000 };

  it("counts from when the request was sent", () => {
    expect(deadlineFromStatus(100_000, status)).toBe(130_000);
  });

  it("adopts a shorter server deadline, e.g. after another device lowered the timeout", () => {
    expect(earlierDeadline(200_000, 100_000, status)).toBe(130_000);
  });

  it("never extends the local deadline from a status check", () => {
    expect(earlierDeadline(120_000, 100_000, status)).toBe(120_000);
  });
});

describe("warning", () => {
  it("always leaves time between the warning and the lock", () => {
    expect(warningLead(60_000, 120_000)).toBe(60_000);
    expect(warningLead(60_000, 60_000)).toBe(30_000);
    expect(warningLead(90_000, 60_000)).toBe(30_000);
  });
});

describe("hidden tabs", () => {
  it("lock when they were hidden longer than allowed, even if timers were frozen", () => {
    expect(hiddenTooLong({ hiddenAt: null, now: 10_000_000, hiddenMs: 60_000 })).toBe(false);
    expect(hiddenTooLong({ hiddenAt: 0, now: 59_999, hiddenMs: 60_000 })).toBe(false);
    expect(hiddenTooLong({ hiddenAt: 0, now: 60_000, hiddenMs: 60_000 })).toBe(true);
  });
});
