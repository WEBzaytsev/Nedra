import { afterEach, describe, expect, it, vi } from "vitest";

import en from "./en";
import ru from "./ru";

const leafKeys = (value, prefix = "") =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object"
      ? leafKeys(child, path)
      : [path.replace(/_(zero|one|two|few|many|other)$/, "")];
  });

afterEach(() => vi.unstubAllGlobals());

describe("translations", () => {
  it("keeps English and Russian translation keys aligned", () => {
    expect([...new Set(leafKeys(ru))].sort()).toEqual([...new Set(leafKeys(en))].sort());
  });

  it("syncs the selected language to the document", async () => {
    const setAttribute = vi.fn();
    vi.stubGlobal("document", { documentElement: { setAttribute } });
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    vi.resetModules();

    const { default: i18n } = await import("./index");
    await i18n.changeLanguage("ru");

    expect(setAttribute).toHaveBeenLastCalledWith("lang", "ru");
  });
});
