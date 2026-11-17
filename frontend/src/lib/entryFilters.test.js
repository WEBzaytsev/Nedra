import { describe, expect, it } from "vitest";

import { ENTRY_FILTERS, applyEntryFilters, entryFilterCounts, hasNotes } from "./entryFilters";

const entries = [
  { password_name: "a", kind: "login", description: "notes", attachment_count: 2, favorite: true },
  { password_name: "b", kind: "login", description: "   ", attachment_count: 0, totp_secret: "X" },
  { password_name: "c", kind: "note", description: "ignored", attachment_count: 1 },
  { password_name: "d", kind: "login", description: null, favorite: true, totp_secret: "Y" },
  { password_name: "e", kind: "login" },
];

const names = (rows) => rows.map((row) => row.password_name);

describe("entry filters", () => {
  it("matches each facet and intersects active facets", () => {
    const only = (key) => names(applyEntryFilters(entries, new Set([key])));
    expect(only("favorites")).toEqual(["a", "d"]);
    expect(only("secure-notes")).toEqual(["c"]);
    expect(only("notes")).toEqual(["a"]);
    expect(only("attachments")).toEqual(["a", "c"]);
    expect(only("totp")).toEqual(["b", "d"]);
    expect(names(applyEntryFilters(entries, new Set(["favorites", "totp"])))).toEqual(["d"]);
    expect(applyEntryFilters(entries, new Set(["secure-notes", "notes"]))).toEqual([]);
  });

  it("counts facets independently and ignores unknown keys", () => {
    expect(applyEntryFilters(entries, new Set(["unknown"]))).toBe(entries);
    expect(Object.fromEntries(entryFilterCounts(entries))).toEqual({
      favorites: 2,
      "secure-notes": 1,
      notes: 1,
      attachments: 2,
      totp: 2,
    });
    expect([...entryFilterCounts([]).values()]).toEqual(ENTRY_FILTERS.map(() => 0));
    expect(hasNotes({ kind: "login", description: " x " })).toBe(true);
  });
});
