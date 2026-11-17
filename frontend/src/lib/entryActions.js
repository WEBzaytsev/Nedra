export const duplicateEntryName = (name, taken, copyLabel = "copy") => {
  const names = new Set(taken);
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? ` (${copyLabel})` : ` (${copyLabel} ${number})`;
    const candidate = `${name.slice(0, 255 - suffix.length)}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
};
