import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import App from "../App";
import Browse from "../Browse";
import Connections from "../Connections";
import { ErrorAlert } from "../ui";
import { applyLang, getLang, systemLang, t, type Key } from "./index";
import { en, vi } from "./strings";

const keys = Object.keys(en) as Key[];
// Letters only Vietnamese has: one of them in a string means the string is Vietnamese.
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
// English UI words the Vietnamese interface must not show, and Vietnamese ones the English must not.
const ENGLISH_WORDS = /\b(download|delete|settings?|connect|upload|copy|copied|close|cancel|save|saved|open|search|browse|remove|restore|undo|apply|folders?|loading|loaded|rename|refresh)\b/i;
const VIETNAMESE_WORDS = /Tải|Xoá|Kết nối|Cài đặt|Đóng|Huỷ|Lưu|Mở|Tìm|Sao chép|Thư mục/i;
/** A language's own name is written in that language in both tables. */
const OWN_NAME: Key[] = ["lang.vi", "lang.en"];

test("both tables have the same keys, no empty value, and the same placeholders", () => {
  expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
  expect(keys.length).toBeGreaterThan(400);
  const holes = (text: string) => [...text.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
  for (const key of keys) {
    expect(en[key].trim(), `en ${key}`).not.toBe("");
    expect(vi[key].trim(), `vi ${key}`).not.toBe("");
    // A variable one language shows and the other drops is a mistake (a plural form may repeat one).
    expect([...new Set(holes(vi[key]))], `placeholders of ${key}`).toEqual([...new Set(holes(en[key]))]);
  }
});

test("no English UI word in the Vietnamese table, no Vietnamese in the English one", () => {
  const strip = (text: string) => text.replace(/\{\w+(:[^}]*)?\}/g, " ");
  for (const key of keys.filter((k) => !OWN_NAME.includes(k))) {
    expect(strip(vi[key]), `vi ${key}`).not.toMatch(ENGLISH_WORDS);
    expect(en[key], `en ${key}`).not.toMatch(VIETNAMESE);
  }
});

test("t() fills variables, picks plural forms, and follows the language", () => {
  applyLang("en");
  expect(getLang()).toBe("en");
  expect(t("common.userNamed", { uid: "alice" })).toBe("user alice");
  expect(t("conn.ok", { n: 1 })).toBe("Connected: the key is valid and its user owns 1 bucket.");
  expect(t("conn.ok", { n: 2 })).toBe("Connected: the key is valid and its user owns 2 buckets.");
  expect(t("conn.ok", { n: 0 })).toMatch(/0 buckets\.$/);
  // A variable nobody passed stays visible instead of vanishing.
  expect(t("common.userNamed")).toBe("user {uid}");
  applyLang("vi");
  expect(t("conn.ok", { n: 2 })).toBe("Kết nối thành công: key hợp lệ, user của key sở hữu 2 bucket.");
  expect(t("common.close")).toBe("Đóng");
});

test("the default follows the system locale: Vietnamese for vi*, English for everything else", () => {
  expect(systemLang("vi")).toBe("vi");
  expect(systemLang("vi-VN")).toBe("vi");
  expect(systemLang("VI_vn")).toBe("vi");
  for (const other of ["en-US", "en", "fr-FR", "zh-CN", ""]) expect(systemLang(other)).toBe("en");
});

// ---- nothing hard-coded: the sources themselves, then what the main views render.
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "../../public/*.{js,html}", "!../**/*.test.ts", "!./strings.ts"], { query: "?raw", import: "default", eager: true });

test("no Vietnamese text outside the string table (code, comments, the preview frame)", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(25);
  for (const [file, code] of Object.entries(sources)) {
    const line = code.split("\n").find((l) => VIETNAMESE.test(l));
    expect(line, `${file} holds Vietnamese text`).toBeUndefined();
  }
});

// Text that is the same in every language: names, symbols, sample values.
const NEUTRAL = new Set(["Bucket", "Admin", "A-", "A+", "VI", "EN", "http://host:7480", "http://proxy:3128", "*.parquet", "×", "+"]);

test("no literal text in JSX: element text and label-like attributes come from t()", () => {
  const found: string[] = [];
  for (const [file, code] of Object.entries(sources).filter(([name]) => name.endsWith(".tsx"))) {
    // label="…", title="…", aria-label="…", placeholder="…", helperText="…", alt="…" with a literal value.
    for (const m of code.matchAll(/\b(?:label|title|aria-label|placeholder|helperText|alt|confirmLabel|text|summary)="([^"]*)"/g)) {
      if (/[A-Za-z]{2}/.test(m[1]) && !NEUTRAL.has(m[1])) found.push(`${file}: ${m[0]}`);
    }
    // >Text< on one line, and a line of bare text right after a tag.
    for (const m of code.matchAll(/>([^<>{}=()]*[A-Za-z]{2}[^<>{}=()]*)<\//g)) {
      if (!NEUTRAL.has(m[1].trim())) found.push(`${file}: >${m[1].trim()}<`);
    }
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      const bare = /^\s+([A-Z][^{}<>=;()`]*)$/.exec(line);
      const before = (lines[i - 1] ?? "").trimEnd();
      if (bare && /[a-z]{2}/.test(bare[1]) && before.endsWith(">") && !before.endsWith("=>") && !NEUTRAL.has(bare[1].trim())) found.push(`${file}:${i + 1}: ${bare[1].trim()}`);
    });
  }
  expect(found).toEqual([]);
});

const profile = { id: "c1", label: "lab", endpoint: "http://rgw.example:7480", access_key: "AKIAEXAMPLE000000001", browse_access_key: "AKIAEXAMPLE000000002" };
const place = { clusterId: "c1", uid: "", bucket: "", prefix: "" };
const nothing = () => {};
// Rendered to a string, without a browser: Browse only asks the window for its height.
Object.assign(globalThis, { window: { innerHeight: 800 } });
const views = (): ReactElement[] => [
  createElement(App),
  createElement(Connections, { profiles: [profile], onChanged: nothing, scale: 110, onScale: nothing }),
  createElement(Connections, { profiles: [], onChanged: nothing, scale: 100, onScale: nothing }),
  createElement(Browse, { profiles: [profile], start: place, active: true, startTransfer: async () => undefined, onPlace: nothing, remember: nothing, recents: [{ ...place, bucket: "logs", prefix: "2026/" }], onRecent: nothing, pins: [{ place: { ...place, bucket: "logs", prefix: "" }, label: "", added: 0 }], pinOps: { toggle: nothing, rename: nothing, move: nothing }, onOpenTab: nothing, onPinPath: nothing }),
  createElement(ErrorAlert, { error: "AccessDenied (403): refused [needs users=read]" }),
  createElement(ErrorAlert, { error: "S3 NoSuchBucket (404): gone" }),
  createElement(ErrorAlert, { error: "keychain: cannot read secret key: locked" }),
  createElement(ErrorAlert, { error: "an error nobody has seen before" }),
];
/** What a user can read or hear: text nodes and the label-like attributes, without the technical detail of an error. */
function shown(view: ReactElement): string {
  const html = renderToString(view).replace(/<code[^>]*>.*?<\/code>/gs, " ");
  const attributes = [...html.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]);
  return [html.replace(/<style[^>]*>.*?<\/style>/gs, " ").replace(/<[^>]*>/g, " "), ...attributes].join(" ");
}

test("the main views in Vietnamese show no English UI word", () => {
  applyLang("vi");
  const all = views().map(shown);
  expect(all.join(" ")).toMatch(/Kết nối/);
  expect(all.join(" ")).toMatch(/Cài đặt chung/);
  all.forEach((text, i) => expect(text, `view ${i}`).not.toMatch(ENGLISH_WORDS));
});

test("the main views in English show no Vietnamese", () => {
  applyLang("en");
  const all = views().map(shown);
  expect(all.join(" ")).toMatch(/Connections/);
  expect(all.join(" ")).toMatch(/General settings/);
  all.forEach((text, i) => {
    // "Tiếng Việt" is the accessible name of the VI button in both languages.
    const rest = text.replaceAll(vi["lang.vi"], " ");
    expect(rest, `view ${i}`).not.toMatch(VIETNAMESE);
    expect(rest, `view ${i}`).not.toMatch(VIETNAMESE_WORDS);
  });
});
