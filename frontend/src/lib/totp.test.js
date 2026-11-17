import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateTotp, totpRemaining } from "./totp";

const vectors = JSON.parse(
  readFileSync(new URL("../../../testdata/vectors/totp.json", import.meta.url), "utf8")
);

const at = (seconds) => vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateTotp", () => {
  it("has the shared vectors to check against", () => {
    expect(vectors.name).toBe("totp");
    expect(vectors.vectors.length).toBeGreaterThan(10);
  });

  it.each(vectors.vectors)(
    "$secret at $time ($digits digits, $period s) is $code",
    async ({ secret, time, period, digits, code }) => {
      at(time);
      await expect(generateTotp(secret, { digits, period })).resolves.toBe(code);
    }
  );

  it("decodes lowercase, spaced and padded secrets like the stored form", async () => {
    const [{ time, code }] = vectors.vectors.filter(
      (v) => v.secret === "MZXW6YTBOI" && v.digits === 6
    );
    at(time);
    for (const variant of ["mzxw6ytboi", "MZXW 6YTB OI", "MZXW6YTBOI======"]) {
      await expect(generateTotp(variant)).resolves.toBe(code);
    }
  });

  it("rejects secrets that are not base32", async () => {
    at(59);
    await expect(generateTotp("NOT-BASE32!")).rejects.toThrow("Invalid base32 secret.");
    await expect(generateTotp("ABC1")).rejects.toThrow("Invalid base32 secret.");
  });
});

describe("totpRemaining", () => {
  it.each([
    [0, 30],
    [1, 29],
    [29, 1],
    [30, 30],
    [1_760_000_039, 1],
  ])("at %i seconds leaves %i", (seconds, left) => {
    at(seconds);
    expect(totpRemaining()).toBe(left);
  });

  it("honours a custom period", () => {
    at(1_760_000_039);
    expect(totpRemaining(60)).toBe(1);
  });
});
