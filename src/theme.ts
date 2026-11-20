import { createTheme } from "@mui/material";

// Design tokens of the chosen concept ("B", docs/mockups/concept-b.html): warm
// charcoal paper, one amber accent, serif headings, borders instead of shadows, 12–16 px corners.
export const tokens = {
  bg: "#181512",
  paper: "#201c18",
  raised: "#29241f",
  line: "#3e362e",
  text: "#f1e9dd",
  muted: "#bbad9d",
  accent: "#f0a93b",
  onAccent: "#2b1b03",
  ok: "#abcd8c",
  danger: "#f39280",
  radius: 16,
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif", Georgia, "DejaVu Serif", serif',
  // Only for keys and paths (and file content shown as text or hex).
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
};

const t = tokens;
const line = `1px solid ${t.line}`;
const heading = { fontFamily: t.serif, fontWeight: 600, letterSpacing: "-0.01em" };
/** Small caps label above a heading or a group ("eyebrow" in the concept), also the table header style. */
export const eyebrow = { fontSize: 12.5, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" as const };

export const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: t.bg, paper: t.paper },
    text: { primary: t.text, secondary: t.muted },
    divider: t.line,
    primary: { main: t.accent, contrastText: t.onAccent },
    success: { main: t.ok },
    warning: { main: t.accent },
    error: { main: t.danger },
    info: { main: t.muted },
    action: { hover: "rgba(241, 233, 221, 0.05)", selected: t.raised },
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
        "code, pre": { fontFamily: t.mono, fontSize: 14 },
        ":focus-visible": { outline: `2px solid ${t.accent}`, outlineOffset: 2 },
        summary: { cursor: "pointer", color: t.muted },
      },
    },
    // Surfaces are told apart by a border, not by a shadow.
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: "none" }, rounded: { borderRadius: t.radius } } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 14, paddingInline: 16, whiteSpace: "nowrap" },
        sizeSmall: { borderRadius: 12, paddingInline: 12 },
        outlined: { borderColor: t.line, color: t.text },
        contained: { fontWeight: 650 },
      },
    },
    MuiDialog: { styleOverrides: { paper: { border: line, boxShadow: "none" } } },
    MuiDialogTitle: { styleOverrides: { root: { padding: "20px 28px" } } },
    MuiDialogContent: { styleOverrides: { root: { padding: "24px 28px" } } },
    MuiDialogActions: { styleOverrides: { root: { padding: "12px 20px" } } },
    MuiDrawer: { styleOverrides: { paper: { boxShadow: "none" } } },
    // The one place a soft shadow stays: things that float over content.
    MuiPopover: { styleOverrides: { paper: { border: line, boxShadow: "0 10px 28px rgba(0, 0, 0, 0.3)", borderRadius: 14 } } },
    MuiMenu: { styleOverrides: { paper: { border: line, boxShadow: "0 10px 28px rgba(0, 0, 0, 0.3)", borderRadius: 14 } } },
    MuiChip: { styleOverrides: { root: { borderRadius: 999 }, outlined: { borderColor: t.line } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 14, minHeight: 40 }, notchedOutline: { borderColor: t.line } } },
    MuiTableCell: {
      styleOverrides: {
        // Checkbox cells keep their own narrow padding.
        root: { borderColor: t.line, "&.MuiTableCell-sizeSmall:not(.MuiTableCell-paddingCheckbox)": { padding: "8px 18px" } },
        head: { ...eyebrow, color: t.muted },
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
