import { describe, expect, it } from "vitest";

import { duplicateEntryName } from "./entryActions";

describe("duplicateEntryName", () => {
  it("keeps the name unique and within the entry limit", () => {
    expect(duplicateEntryName("GitHub", ["GitHub"], "copy")).toBe("GitHub (copy)");
    expect(duplicateEntryName("GitHub", ["GitHub", "GitHub (copy)"], "copy")).toBe(
      "GitHub (copy 2)"
    );
    expect(duplicateEntryName("x".repeat(255), [], "copy")).toHaveLength(255);
  });
});
