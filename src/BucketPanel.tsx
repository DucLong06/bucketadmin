import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, InputAdornment, List, ListItemButton, ListItemText, Paper, TextField, Typography } from "@mui/material";
import type { BrowseBucket } from "./api";
import { t } from "./i18n";
import { eyebrow, thinScroll, tokens } from "./theme";

/** The filter field is only worth its row above this many buckets. */
export const FILTER_ABOVE = 8;
/** The list never grows past this: about 38 % of the window, and never under five rows. */
export const LIST_MAX_HEIGHT = "max(200px, 38vh)";

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
  const rowAt = (i: number) => list.current?.querySelectorAll<HTMLElement>("[role=button]")[i];
  // A tab that is shown again, or that went to another bucket: its bucket is in view.
  useEffect(() => {
    if (active) reveal(list.current, list.current?.querySelector<HTMLElement>(".Mui-selected"));
  }, [active, current, shown.length]);

  function onFilterKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setFilter("");
      setHighlight(0);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = moveHighlight(cursor.current, e.key, shown.length);
      setHighlight(next);
      // The highlighted row stays in view while the arrow keys walk the list.
      reveal(list.current, rowAt(next));
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
      <List dense aria-label={t("browse.bucketList")} ref={list} style={{ maxHeight: LIST_MAX_HEIGHT }} sx={{ ...thinScroll, mb: filterable ? 1 : 0 }}>
        {shown.map((b, i) => (
          <ListItemButton
            key={b.name}
            selected={b.name === current}
            // The row the filter field's arrow keys are on looks like the focused one.
            className={filtering && i === highlight ? "Mui-focusVisible" : undefined}
            onClick={() => onOpen(b.name, "")}
            onContextMenu={(e: MouseEvent) => onBucketMenu?.(b.name, e)}
          >
            <ListItemText primary={b.name} slotProps={{ primary: { sx: { fontFamily: tokens.mono, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: b.name } }} />
          </ListItemButton>
        ))}
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
      <Box sx={{ px: 2, pb: 2 }}>
        <Button size="small" variant="outlined" fullWidth onClick={onCreate}>
          {t("browse.createBucket")}
        </Button>
      </Box>
      <Box sx={{ px: 2, pt: 2, pb: 2, borderTop: 1, borderColor: "divider" }}>
        {/* For a key that may not list buckets this is the way in, so it is the filled button. */}
        <Button size="small" variant={bucketsError ? "contained" : "outlined"} fullWidth onClick={onPickPath} title={t("browse.openPathHelp")}>
          {t("browse.openPath")}
        </Button>
      </Box>
    </Paper>
  );
}
