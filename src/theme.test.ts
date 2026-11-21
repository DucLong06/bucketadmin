import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { afterEach, expect, test } from "vitest";
import App from "./App";
import BucketPanel from "./BucketPanel";
import { applyLang } from "./i18n";
import { applyMode, getMode, palettes, themes, type Mode } from "./theme";

afterEach(() => applyMode("dark"));

// WCAG 2 contrast ratio of two #rrggbb colours.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const MODES: Mode[] = ["dark", "light"];

test("both palettes are complete, and every text colour reaches WCAG AA (4.5:1) on every surface", () => {
  expect(Object.keys(palettes.light)).toEqual(Object.keys(palettes.dark));
  expect(palettes.light.bg).toBe("#faf7f2");
  // One amber accent in both themes.
  expect(palettes.light.accent).toBe(palettes.dark.accent);
  for (const mode of MODES) {
    const p = palettes[mode];
    for (const surface of [p.bg, p.paper, p.raised]) {
      for (const text of [p.text, p.muted, p.accentText, p.ok, p.danger]) expect(contrast(text, surface), `${mode}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(p.onAccent, p.accent), `${mode}: text of the main button`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.onAccent, p.accentHover)).toBeGreaterThanOrEqual(4.5);
  }
});

test("the MUI themes take their colours from the palettes; shape and sizes are the same in both", () => {
  for (const mode of MODES) {
    const { palette } = themes[mode];
    expect([palette.mode, palette.background.default, palette.background.paper, palette.text.primary, palette.divider]).toEqual([mode, palettes[mode].bg, palettes[mode].paper, palettes[mode].text, palettes[mode].line]);
  }
  const shared = (mode: Mode) => JSON.stringify([themes[mode].typography, themes[mode].shape, themes[mode].spacing(1)]);
  expect(shared("light")).toBe(shared("dark"));
  // Borders over shadows in both: paper has no elevation.
  for (const mode of MODES) expect(themes[mode].components?.MuiPaper?.defaultProps?.elevation).toBe(0);
});

const app = () => renderToString(createElement(App));

test("toggling the theme switches the page background of the whole app", () => {
  applyLang("en");
  expect(getMode()).toBe("dark");
  const dark = app();
  expect(dark).toContain("background-color:#181512");
  expect(dark).not.toContain("#faf7f2");
  applyMode("light");
  const light = app();
  expect(light).toContain("background-color:#faf7f2");
  expect(light).toContain("--ba-line:#d6cabb");
  expect(light).not.toContain("#181512");
  // The app bar offers the choice.
  expect(light).toMatch(/>Menu</);
  applyMode("dark");
  expect(app()).toContain("background-color:#181512");
});

test("the size floors hold in both themes: body 15 px, rows and inputs at least 40 px, captions at least 12 px", () => {
  const buckets = Array.from({ length: 12 }, (_, i) => ({ name: `bucket-${i}`, created: "" }));
  const nothing = () => {};
  for (const mode of MODES) {
    const theme = themes[mode];
    expect(theme.typography.fontSize).toBe(15);
    expect(parseFloat(String(theme.typography.caption.fontSize)) * 16, `${mode}: caption`).toBeGreaterThanOrEqual(12);
    expect(parseFloat(String(theme.typography.body2.fontSize)) * 16, `${mode}: body`).toBeCloseTo(15, 5);
    const panel = createElement(BucketPanel, { title: "Buckets", buckets, bucketsError: null, current: "", active: true, onOpen: nothing, onCreate: nothing, onPickPath: nothing });
    const html = renderToString(createElement(ThemeProvider, { theme }, createElement(CssBaseline), panel));
    const css = [...html.matchAll(/<style[^>]*>(.*?)<\/style>/gs)].map((m) => m[1]).join("");
    const rule = (tag: RegExp) => {
      const cls = tag.exec(html)?.[1].split(" ").filter((c) => c.startsWith("css-")) ?? [];
      return cls.map((c) => new RegExp(`\\.${c}\\{([^}]*)\\}`).exec(css)?.[1] ?? "").join(";");
    };
    // A bucket row, and the filter field above the list.
    expect(rule(/<div class="([^"]*MuiListItemButton-root[^"]*)"/), `${mode}: bucket row`).toContain("min-height:40px");
    expect(rule(/<div class="([^"]*MuiOutlinedInput-root[^"]*)"/), `${mode}: filter field`).toContain("min-height:40px");
    expect(css).toContain(`background-color:${palettes[mode].bg}`);
  }
});
