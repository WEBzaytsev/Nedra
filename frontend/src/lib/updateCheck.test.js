import { describe, expect, it } from "vitest";

import { compareVersions } from "./updateCheck";

describe("compareVersions", () => {
  it.each([
    ["v1.4.7", "1.4.6", 1],
    ["1.4.10", "1.4.9", 1],
    ["v2.0.0", "1.99.99", 1],
    ["v1.4.6", "1.4.6", 0],
    ["1.4", "1.4.0", 0],
    ["V1.4.6", "v1.4.6", 0],
    ["v1.4.5", "1.4.6", -1],
    ["v1.3.99", "1.4.0", -1],
    ["", "1.0.0", -1],
  ])("%s vs %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
