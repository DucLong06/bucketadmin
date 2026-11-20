import { type FormEvent, type KeyboardEvent, type Ref, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, InputAdornment, List, ListItemButton, ListItemText, Paper, Stack, TextField, Typography } from "@mui/material";
import type { BrowseBucket } from "./api";
import { t } from "./i18n";
import { splitPath } from "./paths";
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
  /** The Open-path field, so other parts of the page can send the user there. */
  pathRef?: Ref<HTMLInputElement>;
};

/** The sidebar's bucket card: the key's buckets in a list of bounded height with a filter, and a
 *  field that opens any path the key may use. Only the list scrolls; the controls stay put. */
export default function BucketPanel({ title, buckets, bucketsError, current, active, onOpen, onCreate, pathRef }: Props) {
  const [path, setPath] = useState("");
  const split = splitPath(path);
  const field = useRef<HTMLInputElement | null>(null);
  // A key that may not list buckets has one thing to do here: type the path it was given.
  useEffect(() => {
    if (bucketsError && active && !current) field.current?.focus();
  }, [bucketsError]);

  // The filter belongs to this tab and is not saved.
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);
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
      const next = moveHighlight(highlight, e.key, shown.length);
      setHighlight(next);
      reveal(list.current, rowAt(next));
    } else if (e.key === "Enter") {
      const picked = shown[moveHighlight(highlight, "", shown.length)];
      if (picked) onOpen(picked.name, "");
    } else return;
    e.preventDefault();
  }
  function openPath(e: FormEvent) {
    e.preventDefault();
    if (!split.error) onOpen(split.bucket, split.prefix);
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
      <List dense aria-label={t("browse.bucketList")} ref={list} style={{ maxHeight: LIST_MAX_HEIGHT }} sx={thinScroll}>
        {shown.map((b, i) => (
          <ListItemButton
            key={b.name}
            selected={b.name === current}
            // The row the filter field's arrow keys are on looks like the focused one.
            className={filtering && i === highlight ? "Mui-focusVisible" : undefined}
            onClick={() => onOpen(b.name, "")}
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
      <Stack component="form" onSubmit={openPath} sx={{ px: 2, pt: 2, pb: 1.5, borderTop: 1, borderColor: "divider" }}>
        <TextField
          label={t("browse.openPath")}
          placeholder={t("browse.openPathSample")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          size="small"
          error={!!path.trim() && !!split.error}
          helperText={path.trim() && split.error ? t(split.error) : t("browse.openPathHelp")}
          inputRef={(input: HTMLInputElement | null) => {
            field.current = input;
            if (typeof pathRef === "function") pathRef(input);
            else if (pathRef) pathRef.current = input;
          }}
          slotProps={{
            htmlInput: { style: { fontFamily: tokens.mono }, spellCheck: false },
            inputLabel: { shrink: true },
            // The button sits in the field: one row less in a column that has none to spare.
            input: {
              sx: { pr: 0.5 },
              endAdornment: (
                <InputAdornment position="end">
                  <Button type="submit" size="small" disabled={!!split.error} sx={{ minWidth: 0 }}>
                    {t("common.open")}
                  </Button>
                </InputAdornment>
              ),
            },
          }}
        />
      </Stack>
    </Paper>
  );
}
