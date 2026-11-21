import { useSyncExternalStore } from "react";
import { createTheme } from "@mui/material";
import { invoke } from "@tauri-apps/api/core";

export type Mode = "dark" | "light";

// The two palettes of the chosen concept ("B", docs/mockups/concept-b.html): one amber accent,
// serif headings, borders instead of shadows, 12–16 px corners. Dark is warm charcoal, light is
// warm paper. Every colour of the app is here: components name palette roles, never a hex.
// `accent` fills (the main button); `accentText` is the accent where it is text or a thin line,
// deep enough on paper for WCAG AA. Text colours are 4.5:1 or better on bg, paper and raised
// (checked in theme.test.ts). `bg` is also the window colour before the first paint (apply_theme in lib.rs).
export const palettes = {
  dark: {
    bg: "#181512",
    paper: "#201c18",
    raised: "#29241f",
    line: "#3e362e",
    text: "#f1e9dd",
    muted: "#bbad9d",
    accent: "#f0a93b",
    accentText: "#f0a93b",
    accentHover: "#f5bb5e",
    onAccent: "#2b1b03",
    ok: "#abcd8c",
    danger: "#f39280",
    hover: "rgba(241, 233, 221, 0.05)",
    shadow: "0 10px 28px rgba(0, 0, 0, 0.3)",
  },
  light: {
    bg: "#faf7f2",
    paper: "#fffdf9",
    raised: "#f0e9dd",
    line: "#d6cabb",
    text: "#2a231c",
    muted: "#655848",
    accent: "#f0a93b",
    accentText: "#8a5200",
    accentHover: "#e59a26",
    onAccent: "#2b1b03",
    ok: "#3d6b1e",
    danger: "#b3321f",
    hover: "rgba(42, 35, 28, 0.05)",
    shadow: "0 10px 28px rgba(70, 50, 20, 0.14)",
  },
};

/** What does not change with the theme. */
export const tokens = {
  radius: 16,
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif", Georgia, "DejaVu Serif", serif',
  // Only for keys and paths (and file content shown as text or hex).
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  // Colours of the theme in use, for the few rules written outside the MUI palette.
  line: "var(--ba-line)",
  muted: "var(--ba-muted)",
};

const t = tokens;
const heading = { fontFamily: t.serif, fontWeight: 600, letterSpacing: "-0.01em" };
/** Small caps label above a heading or a group ("eyebrow" in the concept), also the table header style. */
export const eyebrow = { fontSize: 12.5, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" as const };

/** A list that scrolls inside its card: a thin bar in the theme's line colour. The WebKit rules
 *  are what the app's webview draws (a bar that stays visible); the standard properties are for an
 *  engine without them, and are kept apart because, where both exist, they switch the WebKit rules off
 *  and the bar becomes the desktop's own, which hides until the list is scrolled. */
export const thinScroll = {
  overflowY: "auto" as const,
  "&::-webkit-scrollbar": { width: 8 },
  "&::-webkit-scrollbar-track": { background: "transparent" },
  "&::-webkit-scrollbar-thumb": { background: t.line, borderRadius: "8px" },
  "&::-webkit-scrollbar-thumb:hover": { background: t.muted },
  "@supports not selector(::-webkit-scrollbar)": { scrollbarWidth: "thin" as const, scrollbarColor: `${t.line} transparent` },
};

const makeTheme = (mode: Mode) => {
  const p = palettes[mode];
  const line = `1px solid ${p.line}`;
  return createTheme({
  palette: {
    mode,
    background: { default: p.bg, paper: p.paper },
    text: { primary: p.text, secondary: p.muted },
    divider: p.line,
    primary: { main: p.accentText, contrastText: p.onAccent },
    success: { main: p.ok },
    warning: { main: p.accentText },
    error: { main: p.danger },
    info: { main: p.muted },
    action: { hover: p.hover, selected: p.raised },
  },
  shape: { borderRadius: 14 },
  typography: {
    fontFamily: t.sans,
    // MUI's base size (14 by default): body2, table cells and buttons follow it; body1, inputs,
    // chips, captions and h1–h3 scale by the same 15/14.
    fontSize: 15,
    h1: heading,
    h2: heading,
    h3: heading,
    h4: { ...heading, fontSize: 35 },
    h5: { ...heading, fontSize: 25 },
    h6: { ...heading, fontSize: 20 },
    overline: { ...eyebrow, lineHeight: 1.8 },
    button: { textTransform: "none", fontWeight: 500, fontSize: 15 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ":root": { "--ba-line": p.line, "--ba-muted": p.muted },
        "code, pre": { fontFamily: t.mono, fontSize: 14 },
        ":focus-visible": { outline: `2px solid ${p.accentText}`, outlineOffset: 2 },
        summary: { cursor: "pointer", color: p.muted },
      },
    },
    // Surfaces are told apart by a border, not by a shadow.
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: "none" }, rounded: { borderRadius: t.radius } } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 14, paddingInline: 16, whiteSpace: "nowrap" },
        sizeSmall: { borderRadius: 12, paddingInline: 12 },
        outlined: { borderColor: p.line, color: p.text },
        contained: { fontWeight: 650 },
      },
      // The main button is filled with the amber itself in both themes (on paper, primary.main is the deeper text amber).
      variants: p.accent === p.accentText ? [] : [{ props: { variant: "contained", color: "primary" }, style: { backgroundColor: p.accent, "&:hover": { backgroundColor: p.accentHover } } }],
    },
    MuiDialog: { styleOverrides: { paper: { border: line, boxShadow: "none" } } },
    MuiDialogTitle: { styleOverrides: { root: { padding: "20px 28px" } } },
    MuiDialogContent: { styleOverrides: { root: { padding: "24px 28px" } } },
    MuiDialogActions: { styleOverrides: { root: { padding: "12px 20px" } } },
    MuiDrawer: { styleOverrides: { paper: { boxShadow: "none" } } },
    // The one place a soft shadow stays: things that float over content.
    MuiPopover: { styleOverrides: { paper: { border: line, boxShadow: p.shadow, borderRadius: 14 } } },
    MuiMenu: { styleOverrides: { paper: { border: line, boxShadow: p.shadow, borderRadius: 14 } } },
    MuiChip: { styleOverrides: { root: { borderRadius: 999 }, outlined: { borderColor: p.line } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 14, minHeight: 40 }, notchedOutline: { borderColor: p.line } } },
    MuiTableCell: {
      styleOverrides: {
        // Checkbox cells keep their own narrow padding.
        root: { borderColor: p.line, "&.MuiTableCell-sizeSmall:not(.MuiTableCell-paddingCheckbox)": { padding: "8px 18px" } },
        head: { ...eyebrow, color: p.muted },
      },
    },
    MuiTab: { styleOverrides: { root: { textTransform: "none", fontSize: 16, minWidth: 0 } } },
    MuiListItemButton: { styleOverrides: { dense: { minHeight: 40 } } },
    MuiTooltip: { styleOverrides: { tooltip: { fontSize: 13 } } },
    MuiAlert: { styleOverrides: { root: { borderRadius: 14 } } },
    MuiAccordion: { styleOverrides: { root: { borderRadius: t.radius, "&::before": { display: "none" } } } },
    MuiLinearProgress: { styleOverrides: { root: { borderRadius: 999 } } },
    MuiSnackbarContent: { styleOverrides: { root: { boxShadow: "none" } } },
  },
  });
};

export const themes = { dark: makeTheme("dark"), light: makeTheme("light") };

// The theme in use is one module-level value, like the language (i18n/index.ts): an explicit
// choice, dark until the user picks light; it never follows the system.
let mode: Mode = "dark";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getMode = () => mode;

/** Switches the theme of everything on screen, at once (nothing is saved). */
export function applyMode(next: Mode) {
  mode = next;
  if (typeof document !== "undefined") document.documentElement.dataset.theme = next;
  listeners.forEach((listener) => listener());
}

/** The user's choice: shown at once and written to settings.json. */
export function setMode(next: Mode) {
  applyMode(next);
  return invoke("set_theme", { theme: next }).catch(() => {});
}

/** At startup, before the first render: the saved theme. */
export const loadMode = () =>
  invoke<string>("get_theme").then(
    (saved) => applyMode(saved === "light" ? "light" : "dark"),
    () => applyMode("dark"),
  );

/** The theme in use; the component re-renders when it changes. */
export const useMode = (): Mode => useSyncExternalStore(subscribe, getMode, getMode);
