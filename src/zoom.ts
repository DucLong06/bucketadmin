/** Sizes the whole interface can be shown at, in percent (the backend's `settings::UI_SCALES`). */
export const UI_SCALES = [80, 90, 100, 110, 125, 150];

/** The step `by` places above (+1) or below (-1) the step nearest to `current`; stops at the ends. */
export function stepScale(current: number, by: 1 | -1): number {
  const diffs = UI_SCALES.map((step) => Math.abs(step - current));
  const at = diffs.indexOf(Math.min(...diffs));
  return UI_SCALES[Math.min(Math.max(at + by, 0), UI_SCALES.length - 1)];
}

/** Ctrl+= / Ctrl++ one step bigger, Ctrl+- one step smaller, Ctrl+0 back to 100 %: the size asked for, else null. */
export function zoomShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey">, current: number): number | null {
  if (!e.ctrlKey || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return stepScale(current, 1);
  if (e.key === "-") return stepScale(current, -1);
  return e.key === "0" ? 100 : null;
}
