import assert from "node:assert/strict";
import test from "node:test";

import {
  actionableEntries,
  canActOnEntry,
  commonOwnerFolders,
  reconcileSelection,
  selectedActionableEntries,
} from "./entrySelection.js";

const entries = [
  { id: 1, access: "owner" },
  { id: 2, access: "write" },
  { id: 3, access: "read" },
  { id: 4, access: "unknown" },
];

test("only owned and writable entries can enter bulk selection", () => {
  assert.deepEqual(
    actionableEntries(entries).map((entry) => entry.id),
    [1, 2]
  );
  assert.equal(canActOnEntry(entries[2]), false);
  assert.equal(canActOnEntry(entries[3]), false);
});

test("zero, one, and all selected entries stay inside the visible access scope", () => {
  assert.deepEqual(selectedActionableEntries(entries, []), []);
  assert.deepEqual(
    selectedActionableEntries(entries, ["1"]).map((entry) => entry.id),
    [1]
  );
  assert.deepEqual(
    selectedActionableEntries(entries, ["1", "2", "3", "4"]).map((entry) => entry.id),
    [1, 2]
  );
  assert.deepEqual(selectedActionableEntries(entries.slice(1), ["1", "2"]), [entries[1]]);
});

test("filter, deletion, or revoked access clears only the unavailable selection", () => {
  const chosen = ["1", "2", "3"];
  assert.deepEqual(reconcileSelection(chosen, entries), ["1", "2"]);
  assert.deepEqual(reconcileSelection(chosen, entries.slice(1)), ["2"]);
  assert.deepEqual(reconcileSelection(chosen, []), []);
  const retained = ["1", "2"];
  assert.equal(reconcileSelection(retained, entries), retained);
});

test("mixed owners cannot be moved into another owner's folder", () => {
  const folders = [
    { id: 10, owner_id: 7 },
    { id: 11, owner_id: 8 },
  ];
  assert.deepEqual(commonOwnerFolders([{ owner_id: 7 }], folders), [folders[0]]);
  assert.deepEqual(commonOwnerFolders([{ owner_id: 7 }, { owner_id: 8 }], folders), []);
});
