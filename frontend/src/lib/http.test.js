import { afterEach, describe, expect, it } from "vitest";

import i18n from "../i18n";

import { errorDetail } from "./http";

const withData = (data) => ({ response: { status: 400, data } });

describe("errorDetail", () => {
  afterEach(() => i18n.changeLanguage("en"));

  it.each(["en", "ru"])(
    "identifies username errors in %s without echoing input",
    async (language) => {
      await i18n.changeLanguage(language);
      const detail = [
        {
          loc: ["body", "username"],
          type: "string_pattern_mismatch",
          msg: "String should match pattern '^[a-z0-9][a-z0-9._@-]*$'",
          input: "invalid user input",
        },
      ];
      await expect(errorDetail(withData({ detail }), "fallback")).resolves.toBe(
        `${i18n.t("auth.username")}: ${i18n.t("auth.usernameRules")}`
      );
    }
  );

  it("preserves nested field locations and body-level messages without echoing input", async () => {
    const detail = [
      {
        loc: ["body", "custom_fields", 0, "label"],
        msg: "Value error, Label required.",
        input: "private",
      },
      { loc: ["body"], msg: "Value error, Invalid request." },
    ];
    await expect(errorDetail(withData({ detail }), "fallback")).resolves.toBe(
      "custom_fields.0.label: Label required.; Invalid request."
    );
  });
  it("returns a string detail as is", async () => {
    await expect(errorDetail(withData({ detail: "Name taken." }), "fallback")).resolves.toBe(
      "Name taken."
    );
  });

  it("joins pydantic validation messages without the value error prefix", async () => {
    const detail = [
      { loc: ["body", "url"], msg: "String should have at most 2048 characters" },
      { loc: ["body", "totp_secret"], msg: "Value error, TOTP secret must be valid base32." },
      { loc: ["body"], msg: 42 },
    ];
    await expect(errorDetail(withData({ detail }), "fallback")).resolves.toBe(
      "url: String should have at most 2048 characters; totp_secret: TOTP secret must be valid base32."
    );
  });

  it("reads JSON error bodies delivered as Blobs", async () => {
    const blob = new Blob([JSON.stringify({ detail: "Incorrect master password." })]);
    await expect(errorDetail(withData(blob), "Backup failed.")).resolves.toBe(
      "Incorrect master password."
    );
  });

  it.each([
    ["no response", {}],
    ["an empty body", withData(undefined)],
    ["an object detail", withData({ detail: { nested: true } })],
    ["an empty list", withData({ detail: [] })],
    ["a non-JSON Blob", withData(new Blob(["Bad Gateway"]))],
  ])("falls back on %s", async (_, err) => {
    await expect(errorDetail(err, "fallback")).resolves.toBe("fallback");
  });
});
