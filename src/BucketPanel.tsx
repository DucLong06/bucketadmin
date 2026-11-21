import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, InputAdornment, List, ListItemButton, ListItemText, Paper, Stack, TextField, Typography } from "@mui/material";
import type { BrowseBucket } from "./api";
import { t } from "./i18n";
import { eyebrow, thinScroll, tokens } from "./theme";
import { visibleRange } from "./virtual";

/** The filter field is only worth its row above this many buckets. */
export const FILTER_ABOVE = 8;
/** The list never grows past this: about 38 % of the window, never under five rows, and in a low
 *  window (700 px) only as much as leaves the whole card, with its two buttons, above the fold. */
export const LIST_MAX_HEIGHT = "clamp(200px, calc(100vh - 500px), 38vh)";

/** Above this many rows the list only mounts the rows in view (and a few around them). */
export const WINDOW_ABOVE = 100;
/** Height of a bucket row (the theme's floor for dense rows), and the list's own padding above the first. */
const ROW = 40;
const LIST_PAD = 8;

/** Buckets whose name contains `text`, whatever the case. */
export const filterBuckets = <B extends { name: string }>(buckets: B[], text: string): B[] => {
  const wanted = text.trim().toLowerCase();
  return wanted ? buckets.filter((b) => b.name.toLowerCase().includes(wanted)) : buckets;
};

/** Where the highlight goes for a key pressed in the filter field: one row up or down, staying inside the list. */
export const moveHighlight = (at: number, key: string, rows: number) =>
  rows === 0 ? 0 : key === "ArrowDown" ? Math.min(at + 1, rows - 1) : key === "ArrowUp" ? Math.max(at - 1, 0) : Math.min(at, rows - 1);

/** Scrolls `list` (and nothing else: the page keeps its place) just far enough to show `row`. */
function reveal(list: HTMLElement | null, row: HTMLElement | null | undefined) {
  if (!list || !row) return;
  const [top, bottom] = [row.offsetTop, row.offsetTop + row.offsetHeight];
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

type Props = {
  /** Whose buckets these are, as the panel's heading. */
  title: string;
  buckets: BrowseBucket[];
  /** S3's error code when the key may not list buckets; a normal state for a key granted one folder. */
  bucketsError: string | null;
  /** The bucket that is open ("" for none). */
  current: string;
  /** Whether this panel's tab is the one on screen. */
  active: boolean;
  onOpen: (bucket: string, prefix: string) => void;
  onCreate: () => void;
  /** A bucket row was right-clicked. */
  onBucketMenu?: (bucket: string, e: MouseEvent) => void;
  /** Go to the path picker: any path the key may use is typed (or picked) there. */
  onPickPath: () => void;
};

/** The sidebar's bucket card: the key's buckets in a list of bounded height with a filter, and the
 *  way to the path picker. Only the list scrolls; the controls stay put. */
export default function BucketPanel({ title, buckets, bucketsError, current, active, onOpen, onCreate, onBucketMenu, onPickPath }: Props) {

  // The filter belongs to this tab and is not saved.
  const [filter, setFilter] = useState("");
  const [highlight, showHighlight] = useState(0);
  // The same position for key presses that arrive before the next render: two quick presses are two steps.
  const cursor = useRef(0);
  const setHighlight = (next: number) => {
    cursor.current = next;
    showHighlight(next);
  };
  // The highlight is the filter field's cursor in the list: shown while that field has the keyboard.
  const [filtering, setFiltering] = useState(false);
  const filterable = buckets.length > FILTER_ABOVE;
  const shown = filterable ? filterBuckets(buckets, filter) : buckets;
  const list = useRef<HTMLUListElement | null>(null);
  // A long list is windowed: rows of a known height, placed by two spacers, so 5000 buckets cost what 30 do.
  const windowed = shown.length > WINDOW_ABOVE;
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = Math.max(200, 0.38 * (globalThis.innerHeight ?? 800));
  const [from, to] = windowed ? visibleRange(scrollTop, viewport, ROW, shown.length) : [0, shown.length];
  /** Scrolls the list just far enough to show row `i`; in a windowed list the row need not be mounted. */
  function revealAt(i: number) {
    const el = list.current;
    if (!el || i < 0) return;
    if (!windowed) return reveal(el, el.querySelectorAll<HTMLElement>("[role=button]")[i]);
    const top = LIST_PAD + i * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }
  // A tab that is shown again, or that went to another bucket: its bucket is in view.
  useEffect(() => {
    if (active) revealAt(shown.findIndex((b) => b.name === current));
  }, [active, current, shown.length]);

  function onFilterKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setFilter("");
      setHighlight(0);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = moveHighlight(cursor.current, e.key, shown.length);
      setHighlight(next);
      // The highlighted row stays in view while the arrow keys walk the list.
      revealAt(next);
    } else if (e.key === "Enter") {
      const picked = shown[moveHighlight(cursor.current, "", shown.length)];
      if (picked) onOpen(picked.name, "");
    } else return;
    e.preventDefault();
  }
  return (
    <Paper variant="outlined" sx={{ borderRadius: "16px" }}>
      <Typography component="h2" sx={{ ...eyebrow, color: "text.secondary", px: 2, pt: 2, pb: filterable ? 1 : 0 }}>
        {bucketsError ? title : t("browse.bucketsCount", { title, n: buckets.length })}
      </Typography>
      {filterable && (
        <Box sx={{ px: 1.5 }}>
          <TextField
            placeholder={t("browse.filterBuckets")}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setHighlight(0);
              // Another list: from its top.
              if (list.current) list.current.scrollTop = 0;
              setScrollTop(0);
            }}
            onKeyDown={onFilterKey}
            onFocus={() => setFiltering(true)}
            onBlur={() => setFiltering(false)}
            size="small"
            fullWidth
            title={t("browse.filterBucketsHint")}
            slotProps={{
              htmlInput: { "aria-label": t("browse.filterBuckets"), spellCheck: false },
              input: {
                endAdornment: filter.trim() && (
                  <InputAdornment position="end">
                    <Typography variant="caption" color="text.secondary" aria-live="polite" sx={{ whiteSpace: "nowrap" }}>
                      {t("browse.filterCount", { n: shown.length, m: buckets.length })}
                    </Typography>
                  </InputAdornment>
                ),
              },
            }}
          />
        </Box>
      )}
      {/* The height limit is on the element itself (not in a class): it is what keeps the rest of the sidebar in reach. */}
      <List
        dense
        aria-label={t("browse.bucketList")}
        ref={list}
        onScroll={windowed ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
        style={{ maxHeight: LIST_MAX_HEIGHT }}
        sx={{ ...thinScroll, mb: filterable ? 1 : 0 }}
      >
        {from > 0 && <li aria-hidden style={{ height: from * ROW }} />}
        {shown.slice(from, to).map((b, n) => [b, from + n] as const).map(([b, i]) => (
          <ListItemButton
            key={b.name}
            selected={b.name === current}
            aria-setsize={windowed ? shown.length : undefined}
            aria-posinset={windowed ? i + 1 : undefined}
            // The row the filter field's arrow keys are on looks like the focused one.
            className={filtering && i === highlight ? "Mui-focusVisible" : undefined}
            onClick={() => onOpen(b.name, "")}
            onContextMenu={(e: MouseEvent) => onBucketMenu?.(b.name, e)}
          >
            <ListItemText primary={b.name} slotProps={{ primary: { sx: { fontFamily: tokens.mono, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: b.name } }} />
          </ListItemButton>
        ))}
        {to < shown.length && <li aria-hidden style={{ height: (shown.length - to) * ROW }} />}
      </List>
      {bucketsError ? (
        <Alert severity="info" sx={{ mx: 1.5, mb: 1.5 }}>
          {t("browse.bucketsDenied")}
        </Alert>
      ) : (
        shown.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1 }}>
            {t(buckets.length === 0 ? "browse.noBuckets" : "browse.filterNone")}
          </Typography>
        )
      )}
      {/* One compact footer: in a 700 px window the whole card, both buttons included, stays above the fold. */}
      <Stack spacing={1} sx={{ px: 2, pb: 2 }}>
        <Button size="small" variant="outlined" fullWidth onClick={onCreate}>
          {t("browse.createBucket")}
        </Button>
        {/* For a key that may not list buckets this is the way in, so it is the filled button. */}
        <Button size="small" variant={bucketsError ? "contained" : "outlined"} fullWidth onClick={onPickPath} title={t("browse.openPathHelp")}>
          {t("browse.openPath")}
        </Button>
      </Stack>
    </Paper>
  );
}
