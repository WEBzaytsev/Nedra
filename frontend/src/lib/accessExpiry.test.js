import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings as dateSettings } from "@gravity-ui/date-utils";

import { isInvalidExpiry, toLocalExpiry, toPersistedExpiry, toUtcExpiry } from "./accessExpiry";

const previousTimeZone = dateSettings.getDefaultTimeZone();

beforeEach(() => dateSettings.setDefaultTimeZone("UTC"));
afterEach(() => dateSettings.setDefaultTimeZone(previousTimeZone));

describe("access expiry", () => {
  it("rejects malformed, past, and exact-now values without treating them as clearing", () => {
    const now = Date.parse("2026-11-04T15:45:00.000Z");

    expect(isInvalidExpiry("", now)).toBe(false);
    expect(isInvalidExpiry("not-a-date", now)).toBe(true);
    expect(isInvalidExpiry("2026-11-04T15:44", now)).toBe(true);
    expect(isInvalidExpiry("2026-11-04T15:45", now)).toBe(true);
    expect(isInvalidExpiry("2026-11-04T15:46", now)).toBe(false);
    expect(toUtcExpiry("")).toBeNull();
    expect(() => toUtcExpiry("not-a-date")).toThrow(RangeError);
  });

  it("round-trips local values through UTC in UTC and Europe/Moscow", () => {
    expect(toUtcExpiry("2026-11-04T15:45")).toBe("2026-11-04T15:45:00.000Z");
    expect(toLocalExpiry("2026-11-04T15:45:00Z")).toBe("2026-11-04T15:45");

    dateSettings.setDefaultTimeZone("Europe/Moscow");
    expect(toUtcExpiry("2026-11-04T15:45")).toBe("2026-11-04T12:45:00.000Z");
    expect(toLocalExpiry("2026-11-04T12:45:00Z")).toBe("2026-11-04T15:45");
  });

  it("uses the correct seasonal offset and rejects DST transition ambiguities", () => {
    dateSettings.setDefaultTimeZone("Europe/Berlin");

    expect(toUtcExpiry("2026-01-15T15:45")).toBe("2026-01-15T14:45:00.000Z");
    expect(toUtcExpiry("2026-07-15T15:45")).toBe("2026-07-15T13:45:00.000Z");
    expect(toLocalExpiry("2026-07-15T13:45:00Z")).toBe("2026-07-15T15:45");
    expect(isInvalidExpiry("2026-03-29T02:30", 0)).toBe(true);
    expect(isInvalidExpiry("2026-10-25T02:30", 0)).toBe(true);
  });

  it("treats API timestamps without an offset as UTC", () => {
    dateSettings.setDefaultTimeZone("Europe/Moscow");
    expect(toLocalExpiry("2026-11-04T12:45:00")).toBe("2026-11-04T15:45");
  });

  it("preserves sub-minute precision until the displayed expiry changes", () => {
    const original = "2030-01-02T03:04:37.123Z";

    expect(toPersistedExpiry("2030-01-02T03:04", original)).toBe(original);
    expect(toPersistedExpiry("2030-01-02T03:05", original)).toBe("2030-01-02T03:05:00.000Z");
    expect(toPersistedExpiry("", original)).toBeNull();
  });
});
