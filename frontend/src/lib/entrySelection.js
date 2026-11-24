export const canActOnEntry = (entry) => entry.access === "owner" || entry.access === "write";

export const actionableEntries = (entries) => entries.filter(canActOnEntry);

export const selectedActionableEntries = (entries, ids) => {
  const selected = new Set(ids);
  return actionableEntries(entries).filter((entry) => selected.has(String(entry.id)));
};

export const reconcileSelection = (ids, entries) => {
  const available = new Set(actionableEntries(entries).map((entry) => String(entry.id)));
  const retained = ids.filter((id) => available.has(id));
  return retained.length === ids.length ? ids : retained;
};

export const commonOwnerFolders = (entries, folders) => {
  const owners = new Set(entries.map((entry) => entry.owner_id));
  return owners.size === 1 ? folders.filter((folder) => owners.has(folder.owner_id)) : [];
};
