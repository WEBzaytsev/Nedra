export const HISTORY_LIMIT = 10;

const parseDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

export const historyTimeline = (entry) => {
  const history = entry?.password_history ?? [];
  const current = entry?.password_value ?? "";
  return [
    { key: "current", current: true, value: current, since: parseDate(history[0]?.changed_at) },
    ...history.map((item, index) => ({
      key: `${item.changed_at}-${index}`,
      value: item.value,
      historyIndex: index,
      changedAt: item.changed_at,
      current: false,
      until: parseDate(item.changed_at),
      since: parseDate(history[index + 1]?.changed_at),
      sameAsCurrent: item.value === current,
    })),
  ];
};

export const historyDuration = (since, until) => {
  if (!since || !until) return null;
  const elapsed = until.getTime() - since.getTime();
  if (elapsed < 0) return null;
  if (elapsed < 24 * 60 * 60 * 1000) return { lessThanDay: true };
  for (const [unit, milliseconds] of [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["week", 7 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
  ]) {
    const count = Math.floor(elapsed / milliseconds);
    if (count) return { unit, count };
  }
  return null;
};

export const reusePayload = (entry, row) => ({
  password_name: entry.password_name,
  history_index: row.historyIndex,
  changed_at: row.changedAt,
});
