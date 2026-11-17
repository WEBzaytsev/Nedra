import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeVault } from "./vaultHealth";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const login = (name, value, updated = "2026-10-01T00:00:00Z") => ({
  password_name: name,
  kind: "login",
  password_value: value,
  updated,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analyzeVault", () => {
  it("scores an empty vault as healthy", () => {
    expect(analyzeVault([])).toEqual({ weak: [], reused: [], stale: [], score: 100, total: 0 });
  });

  it("flags weak, reused and stale logins and ignores secure notes", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const strong = "Xk9#mQ2$vL7@pR4!";
    const entries = [
      login("weak", "abc"),
      login("reuse-a", strong),
      login("reuse-b", strong),
      login("old", "Zt8&nW3^yH6*cB1%", "2025-01-01T00:00:00Z"),
      login("fine", "Pq5!rS8@tU2#vW9$"),
      { password_name: "note", kind: "note", password_value: "abc", updated: "2000-01-01" },
    ];
    const report = analyzeVault(entries);
    const names = (list) => list.map((entry) => entry.password_name).sort();
    expect(report.total).toBe(5);
    expect(names(report.weak)).toEqual(["weak"]);
    expect(names(report.reused)).toEqual(["reuse-a", "reuse-b"]);
    expect(names(report.stale)).toEqual(["old"]);
    expect(report.score).toBe(20);
  });
});
