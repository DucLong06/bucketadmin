import { expect, test } from "vitest";
import { applyLang } from "./i18n";
import { tagsError } from "./InspectTabs";

test("tag list rules: keys present and unique, at most 10, bounded lengths", () => {
  applyLang("vi");
  expect(tagsError([])).toBeNull();
  expect(tagsError([{ key: "env", value: "lab" }, { key: "owner", value: "" }])).toBeNull();
  expect(tagsError([{ key: " ", value: "x" }])).toMatch(/chưa có key/);
  expect(tagsError([{ key: "env", value: "a" }, { key: "env", value: "b" }])).toMatch(/trùng/);
  expect(tagsError([{ key: "k".repeat(129), value: "" }])).toMatch(/128/);
  expect(tagsError(Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: "" })))).toMatch(/tối đa 10/);
  applyLang("en");
  expect(tagsError([{ key: " ", value: "x" }])).toBe("A tag has no key.");
  expect(tagsError([{ key: "env", value: "a" }, { key: "env", value: "b" }])).toMatch(/used twice/);
  expect(tagsError(Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: "" })))).toBe("An object can have at most 10 tags.");
});
