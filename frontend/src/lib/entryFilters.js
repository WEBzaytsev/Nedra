// Quick filters stay React-free so their intersection and counts are testable.
export const hasNotes = (entry) => entry.kind !== "note" && Boolean(entry.description?.trim());

export const ENTRY_FILTERS = [
  {
    key: "favorites",
    labelKey: "vault.filters.favorites",
    test: (entry) => Boolean(entry.favorite),
  },
  {
    key: "secure-notes",
    labelKey: "vault.filters.secureNotes",
    test: (entry) => entry.kind === "note",
  },
  { key: "notes", labelKey: "vault.filters.notes", test: hasNotes },
  {
    key: "attachments",
    labelKey: "vault.filters.attachments",
    test: (entry) => (entry.attachment_count ?? 0) > 0,
  },
  { key: "totp", labelKey: "vault.filters.totp", test: (entry) => Boolean(entry.totp_secret) },
];

const byKey = new Map(ENTRY_FILTERS.map((filter) => [filter.key, filter]));

export const applyEntryFilters = (entries, active) => {
  const tests = [...active].map((key) => byKey.get(key)?.test).filter(Boolean);
  return tests.length ? entries.filter((entry) => tests.every((test) => test(entry))) : entries;
};

export const entryFilterCounts = (entries) =>
  new Map(
    ENTRY_FILTERS.map((filter) => [
      filter.key,
      entries.filter((entry) => filter.test(entry)).length,
    ])
  );
