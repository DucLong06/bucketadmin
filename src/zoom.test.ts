import { expect, test } from "vitest";
import { stepScale, UI_SCALES, zoomShortcut } from "./zoom";

test("stepping walks the allowed sizes and stops at both ends", () => {
  expect(UI_SCALES).toEqual([80, 90, 100, 110, 125, 150]);
  expect(stepScale(100, 1)).toBe(110);
  expect(stepScale(110, 1)).toBe(125);
  expect(stepScale(100, -1)).toBe(90);
  expect(stepScale(150, 1)).toBe(150);
  expect(stepScale(80, -1)).toBe(80);
  // A value that is no step (a hand-edited settings file) counts as the step nearest to it.
  expect(stepScale(120, 1)).toBe(150);
  expect(stepScale(97, -1)).toBe(90);
  expect(stepScale(1000, -1)).toBe(125);
  // Up then down from every step comes back to it.
  for (const step of UI_SCALES.slice(0, -1)) expect(stepScale(stepScale(step, 1), -1)).toBe(step);
});

test("the three zoom chords, and nothing else", () => {
  const key = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: true, altKey: false, ...mods });
  expect(zoomShortcut(key("="), 100)).toBe(110);
  expect(zoomShortcut(key("+"), 100)).toBe(110); // Ctrl+Shift+= and the keypad's plus
  expect(zoomShortcut(key("-"), 100)).toBe(90);
  expect(zoomShortcut(key("0"), 150)).toBe(100);
  expect(zoomShortcut(key("="), 150)).toBe(150);
  expect(zoomShortcut(key("-"), 80)).toBe(80);
  // Without Ctrl these are ordinary typing; AltGr (Ctrl+Alt) chords and the tab shortcuts are not zoom.
  expect(zoomShortcut(key("=", { ctrlKey: false }), 100)).toBeNull();
  expect(zoomShortcut(key("0", { ctrlKey: false }), 100)).toBeNull();
  expect(zoomShortcut(key("-", { altKey: true }), 100)).toBeNull();
  for (const other of ["t", "w", "Tab", "1", "f"]) expect(zoomShortcut(key(other), 100)).toBeNull();
});
