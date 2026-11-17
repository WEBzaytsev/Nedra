import { afterEach, describe, expect, it, vi } from "vitest";

import { generatePassword, secureRandBelow } from "./passwordGenerator";

const POOLS = {
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{}|;:,.<>?",
};

const ALL = { uppercase: true, lowercase: true, numbers: true, symbols: true };

const feed = (...values) => {
  const queue = [...values];
  return vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    array[0] = queue.shift();
    return array;
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secureRandBelow", () => {
  it.each([1, 2, 7, 26, 62, 88, 1000, 2 ** 31 + 11])("stays below %i", (max) => {
    for (let i = 0; i < 500; i += 1) {
      const value = secureRandBelow(max);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(max);
    }
  });

  it("rejects draws below the bias threshold and keeps drawing", () => {
    const max = 2 ** 31 + 11;
    const threshold = 0x100000000 % max;
    const source = feed(threshold - 1, 0, threshold + 5);
    expect(secureRandBelow(max)).toBe((threshold + 5) % max);
    expect(source).toHaveBeenCalledTimes(3);
  });

  it("accepts the first draw at the threshold", () => {
    const max = 26;
    const threshold = 0x100000000 % max;
    const source = feed(threshold);
    expect(secureRandBelow(max)).toBe(threshold % max);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("never touches Math.random", () => {
    const random = vi.spyOn(Math, "random");
    secureRandBelow(62);
    generatePassword({ length: 64, ...ALL });
    expect(random).not.toHaveBeenCalled();
  });
});

describe("generatePassword", () => {
  it("defaults to a 16-character password containing every character class", () => {
    const password = generatePassword();
    expect(password).toHaveLength(16);
    for (const pool of Object.values(POOLS)) {
      expect([...password].some((c) => pool.includes(c))).toBe(true);
    }
  });

  it.each([4, 16, 32, 128])("returns exactly %i characters", (length) => {
    expect(generatePassword({ length, ...ALL })).toHaveLength(length);
  });

  it("always includes one character from every selected pool", () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword({ length: 4, ...ALL });
      for (const pool of Object.values(POOLS)) {
        expect([...password].some((c) => pool.includes(c))).toBe(true);
      }
    }
  });

  it("only uses characters from the selected pools", () => {
    const password = generatePassword({
      length: 500,
      uppercase: false,
      lowercase: false,
      numbers: true,
      symbols: true,
    });
    const allowed = POOLS.numbers + POOLS.symbols;
    expect([...password].every((c) => allowed.includes(c))).toBe(true);
  });

  it("falls back to lowercase letters when nothing is selected", () => {
    const password = generatePassword({
      length: 40,
      uppercase: false,
      lowercase: false,
      numbers: false,
      symbols: false,
    });
    expect(password).toMatch(/^[a-z]{40}$/);
  });
});
