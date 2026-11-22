// Typing a path with the key's reach in sight: the places this connection is known to open
// (start paths, pins, recent places, what a bucket policy grants) as chips, and under the field
// what S3 says about the path being typed: its folders, or that it may not be listed there.
// In the sidebar the same picker is a field with a dropdown: the same places and folders as rows.
import { createContext, type FormEvent, type KeyboardEvent, type ReactNode, type Ref, useContext, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemIcon, ListItemText, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { invoke, type Profile } from "./api";
import { moveHighlight } from "./BucketPanel";
import { explain } from "./errors";
import { t, type Key } from "./i18n";
import { badReason, joinPath, splitPath, splitPathList } from "./paths";
import type { Pin, PinSummary } from "./pins";
import type { Place } from "./tabs";
import { thinScroll, tokens } from "./theme";
import { PinIcon } from "./ui";

/** Answer of the backend's `path_probe`. `children`: folders right below the typed prefix. */
export type Probe = { status: "ok"; bucket: string; prefix: string; children: string[] } | { status: "denied" } | { status: "error"; message: string };
export type ChipSource = "start" | "pin" | "recent" | "policy";
/** `path` is the stored form: "bucket" or "bucket/prefix/". */
export type AccessChip = { path: string; source: ChipSource };

/** What the app knows of each connection's places; App provides it, the picker reads it. */
export const AccessContext = createContext<{ profiles: Profile[]; pins: Pin[]; recents: Place[] }>({ profiles: [], pins: [], recents: [] });

/** Chips shown at most: the picker is for picking, not for scrolling. */
const MAX_CHIPS = 24;
/** Buckets whose policy is asked for when the picker opens (each is one small request, answered once). */
const MAX_SCANNED = 6;

/** The chips of one connection and key, in the order start paths, pins, recent places, policy;
 *  a path named by two sources is shown once, under the first. */
export function accessChips(known: { startPaths?: string[]; pins: Pin[]; recents: Place[]; policy: Record<string, string[]> }, clusterId: string, uid = ""): AccessChip[] {
  const mine = (place: Place) => place.clusterId === clusterId && place.uid === uid && !!place.bucket;
  // The start paths belong to the connection's own key.
  const starts = (uid === "" ? (known.startPaths ?? []) : []).map(splitPath);
  const all: AccessChip[] = [
    ...starts.flatMap((start) => (start.error ? [] : [{ path: joinPath(start.bucket, start.prefix), source: "start" as const }])),
    ...known.pins.filter((pin) => mine(pin.place)).map((pin) => ({ path: joinPath(pin.place.bucket, pin.place.prefix), source: "pin" as const })),
    ...known.recents.filter(mine).map((place) => ({ path: joinPath(place.bucket, place.prefix), source: "recent" as const })),
    ...Object.entries(known.policy).flatMap(([bucket, prefixes]) => prefixes.map((prefix) => ({ path: joinPath(bucket, prefix), source: "policy" as const }))),
  ];
  return all.filter((chip, i) => all.findIndex((other) => other.path === chip.path) === i);
}

/** The path after a click on a suggested folder: what is typed up to its last "/", then the folder. */
export const appendChild = (probe: { bucket: string; prefix: string }, child: string) => `${probe.bucket}/${probe.prefix.slice(0, probe.prefix.lastIndexOf("/") + 1)}${child}/`;

/** A row of the dropdown under the sidebar's path field: `path` is what the field holds once the row is taken. */
export type Suggestion = { path: string; label: string; source: ChipSource | "folder" | "bucket" };
/** What is typed, as the path it will be read as: no scheme, no leading slash. */
const typedPath = (value: string) => value.trim().replace(/^s3:\/\//i, "").replace(/^\/+/, "");
/** A list of paths in the field: what comes before the item being typed (the last one), and that item. */
export function lastItem(value: string, multiline?: boolean): [string, string] {
  const at = multiline ? value.search(/[^\n\r\t,;]*$/) : 0;
  return [value.slice(0, at), value.slice(at)];
}
/** The places of the ticked folder rows, on the picker's connection and key. */
export const tickedPlaces = (ticked: string[], clusterId: string, uid: string): Place[] =>
  ticked.map(splitPath).flatMap((at) => (at.error ? [] : [{ clusterId, uid, bucket: at.bucket, prefix: at.prefix }]));
/** The ticked paths after a click on the box of `path`. */
const toggled = (ticked: string[], path: string) => (ticked.includes(path) ? ticked.filter((p) => p !== path) : [...ticked, path]);

/** The rows of that dropdown. First what continues the typed text: the folders S3 lists there or, while
 *  the bucket's name is still being typed, the listed buckets that start with it. Then the known places
 *  that contain it. A row that would change nothing is left out. */
export function suggestions(value: string, probe: Probe | null, chips: AccessChip[], buckets: string[] = []): Suggestion[] {
  const typed = typedPath(value);
  const wanted = typed.toLowerCase();
  const next: Suggestion[] =
    probe?.status === "ok"
      ? probe.children.map((name) => ({ path: appendChild(probe, name), label: name, source: "folder" as const }))
      : wanted && !typed.includes("/")
        ? buckets.filter((name) => name.toLowerCase().startsWith(wanted)).map((name) => ({ path: `${name}/`, label: `${name}/`, source: "bucket" as const }))
        : [];
  const known: Suggestion[] = chips.filter((chip) => chip.path.toLowerCase().includes(wanted)).slice(0, MAX_CHIPS).map((chip) => ({ path: chip.path, label: chip.path, source: chip.source }));
  const all = [...next, ...known].filter((row) => row.path !== typed);
  return all.filter((row, i) => all.findIndex((other) => other.path === row.path) === i);
}

/** What a key pressed in that field does while the rows are shown: the arrows move the highlight; Tab, and
 *  → with the caret at the end of the text, take the highlighted row into the field (the rows stay, now
 *  for the next level); Space right after the arrows ticks the highlighted folder (else it types a space,
 *  folder names may have one). null: the key is not for the rows (Enter opens what is typed; Tab with no rows moves on). */
export function suggestKey(key: string, rows: Suggestion[], highlight: number, caretAtEnd = true, navigating = false): { highlight: number } | { value: string } | { toggle: string } | null {
  if (rows.length === 0) return null;
  if (key === "ArrowDown" || key === "ArrowUp") return { highlight: moveHighlight(highlight, key, rows.length) };
  const row = rows[moveHighlight(highlight, "", rows.length)];
  if (key === " " && navigating && row.source === "folder") return { toggle: row.path };
  if (key === "Tab" || (key === "ArrowRight" && caretAtEnd)) return { value: rows[moveHighlight(highlight, "", rows.length)].path };
  return null;
}

const icon = (path: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
    {path}
  </svg>
);
const FolderIcon = () => icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
export const SOURCE_ICON: Record<ChipSource, ReactNode> = {
  start: icon(<path d="M5 21V4m0 1h11l-2 3.5 2 3.5H5" />),
  pin: <PinIcon filled />,
  recent: icon(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>,
  ),
  policy: icon(<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />),
};
const SOURCE_TIP: Record<ChipSource, Key> = { start: "pathPicker.source.start", pin: "pathPicker.source.pin", recent: "pathPicker.source.recent", policy: "pathPicker.source.policy" };

type ViewProps = {
  value: string;
  onChange: (path: string) => void;
  label: string;
  /** Under the field while the path is fine; the M9 sentence unless the screen has its own. */
  helperText?: string;
  /** Accessible name of the input when the label alone does not tell fields apart. */
  ariaLabel?: string;
  chips: AccessChip[];
  /** S3's answer for `value`; null while there is none (not asked, or still on its way). */
  probe: Probe | null;
  /** An empty path is fine (the start path of a connection is optional). */
  optional?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** A button inside the field, at its end. */
  action?: ReactNode;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** The sidebar's form: no chips; the known places and the folders are rows under the field while it is
   *  `open` (it has the keyboard), `highlight` being the row Tab or → takes. `buckets`: the key's listed buckets. */
  dropdown?: { open: boolean; highlight: number; buckets?: string[] };
  /** A list of paths, one per line (3 rows, growing to 8): the chips and the folders are for the last one. */
  multiline?: boolean;
  /** Folder rows can be ticked (M14): which are, and what ticking changes; `onPinSelected` pins the ticked ones. */
  pick?: { ticked: string[]; onTicked: (paths: string[]) => void; onPinSelected: () => void };
};

/** The picker as it looks for a given state; `PathPicker` adds the asking. */
export function PathPickerView({ value, onChange, label, helperText, ariaLabel, chips, probe, optional, autoFocus, inputRef, action, onFocus, onBlur, onKeyDown, dropdown, multiline, pick }: ViewProps) {
  // In a list, the chips and folders replace the item being typed; the others stay as they are.
  const [head, current] = lastItem(value, multiline);
  const take = (path: string) => onChange(head + path);
  const split = splitPath(current);
  const bad = multiline ? splitPathList(value).filter((item) => splitPath(item).error) : [];
  const why = badReason(bad);
  // One bad line also gets its reason, as a single path always did (M15).
  const problem = multiline ? (bad.length ? t("pathPicker.notValid", { list: bad.join(", ") }) + (why ? ` — ${t(why)}` : "") : "") : value.trim() && split.error ? t(split.error) : "";
  const rows = dropdown?.open ? suggestions(current, probe, chips, dropdown.buckets) : [];
  // Without the dropdown, tickable folders are rows too (the chips have no room for a box).
  const childRows: Suggestion[] = !dropdown && pick && probe?.status === "ok" ? probe.children.map((name) => ({ path: appendChild(probe, name), label: name, source: "folder" })) : [];
  // The rows in groups, numbered through: what continues the typed text, then the known places.
  const group = (title: string, list: Suggestion[], from: number) =>
    list.length > 0 && (
      <>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 1.5, pt: 0.75 }}>
          {title}
        </Typography>
        <List dense disablePadding role="list" aria-label={title}>
          {list.map((row, n) => (
            <ListItemButton
              key={row.path}
              role="listitem"
              // The row Tab takes looks like the focused one (the keyboard itself stays in the field).
              className={from + n === dropdown?.highlight ? "Mui-focusVisible" : undefined}
              title={row.path}
              aria-label={t(row.source === "folder" ? "pathPicker.child" : "pathPicker.pick", row.source === "folder" ? { name: row.label } : { path: row.path })}
              onClick={() => take(row.path)}
              sx={{ minHeight: 40, px: 1.5, pl: pick && row.source === "folder" ? 0 : 1.5 }}
            >
              {pick && row.source === "folder" && (
                // The box fills its cell, the row's whole height: a click there ticks, it does not go into the folder.
                <Checkbox
                  checked={pick.ticked.includes(row.path)}
                  onChange={() => pick.onTicked(toggled(pick.ticked, row.path))}
                  onClick={(e) => e.stopPropagation()}
                  tabIndex={-1}
                  size="small"
                  slotProps={{ input: { "aria-label": t("pathPicker.tick", { name: row.label }) } }}
                  sx={{ alignSelf: "stretch", width: 40, flexShrink: 0, p: 0, borderRadius: 0 }}
                />
              )}
              <ListItemIcon sx={{ minWidth: 26, color: row.source === "policy" ? "primary.main" : "text.secondary" }}>
                <Box component="span" data-source={row.source} sx={{ display: "inline-flex" }}>
                  {row.source === "folder" || row.source === "bucket" ? <FolderIcon /> : SOURCE_ICON[row.source]}
                </Box>
              </ListItemIcon>
              <ListItemText primary={row.label} slotProps={{ primary: { sx: { fontFamily: tokens.mono, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } } }} />
            </ListItemButton>
          ))}
        </List>
      </>
    );
  const continuing = rows.filter((row) => row.source === "folder" || row.source === "bucket").length;
  const folders = [...rows, ...childRows].filter((row) => row.source === "folder").map((row) => row.path);
  const all = folders.length > 0 && folders.every((path) => pick?.ticked.includes(path));
  // Sticky under the rows while something is ticked, and scrolled into sight: in the sidebar the rows run past its bottom.
  // One line even there (M15: on two it hid a row and a half): the box that rules the row boxes, the count, the button.
  const footer = pick && pick.ticked.length > 0 && (
    <Stack direction="row" ref={(el: HTMLDivElement | null) => el?.scrollIntoView?.({ block: "nearest" })} sx={{ position: "sticky", bottom: 0, zIndex: 1, bgcolor: "background.paper", borderTop: 1, borderColor: "divider", pr: 1.5, py: 0.5, columnGap: 1, alignItems: "center", flexWrap: "wrap" }}>
      <Checkbox
        checked={all}
        indeterminate={!all}
        onChange={() => pick.onTicked(all ? [] : folders)}
        tabIndex={-1}
        size="small"
        title={t(all ? "pathPicker.selectNone" : "pathPicker.selectAll")}
        slotProps={{ input: { "aria-label": t(all ? "pathPicker.selectNone" : "pathPicker.selectAll") } }}
        sx={{ width: 40, height: 40, flexShrink: 0, p: 0, borderRadius: 0 }}
      />
      <Typography variant="body2" role="status" sx={{ flexGrow: 1 }}>
        {t("pathPicker.selected", { n: pick.ticked.length })}
      </Typography>
      <Button size="small" variant="contained" onClick={pick.onPinSelected} sx={{ minHeight: 40 }}>
        {t("pathPicker.pinSelected")}
      </Button>
    </Stack>
  );
  const caption = (text: string) => (
    <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
      {text}
    </Typography>
  );
  const chipSx = { maxWidth: "100%", fontFamily: tokens.mono, fontSize: 13.5 };
  return (
    <Stack spacing={1.25} sx={{ minWidth: 0, flexGrow: 1 }}>
      {!dropdown && chips.length > 0 && (
        <Box>
          {caption(t("pathPicker.chips"))}
          <Stack direction="row" role="list" aria-label={t("pathPicker.chips")} sx={{ flexWrap: "wrap", gap: 0.75 }}>
            {chips.slice(0, MAX_CHIPS).map((chip) => (
              <Tooltip key={chip.path} title={t(SOURCE_TIP[chip.source])}>
                <Chip
                  role="listitem"
                  variant="outlined"
                  icon={<Box component="span" data-source={chip.source} sx={{ display: "inline-flex", color: chip.source === "policy" ? "primary.main" : "text.secondary" }}>{SOURCE_ICON[chip.source]}</Box>}
                  label={chip.path}
                  aria-label={t("pathPicker.pick", { path: chip.path })}
                  onClick={() => take(chip.path)}
                  sx={chipSx}
                />
              </Tooltip>
            ))}
          </Stack>
        </Box>
      )}
      <TextField
        label={label}
        // The sidebar's field is narrow (a 1100 px window at 150 %): a sample that fits; the tooltip has the whole one.
        placeholder={t(dropdown ? "browse.openPathShort" : "browse.openPathSample")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        size="small"
        fullWidth
        multiline={multiline}
        minRows={multiline ? 3 : undefined}
        maxRows={multiline ? 8 : undefined}
        autoFocus={autoFocus}
        error={!!problem}
        // In the sidebar the help is the field's tooltip: the card keeps its height.
        title={dropdown ? `${t("browse.openPathHelp")}. ${t("pathPicker.keys")}` : undefined}
        helperText={problem || (dropdown ? undefined : (helperText ?? t("browse.openPathHelp")))}
        inputRef={inputRef}
        slotProps={{
          // On the input, not the TextField (whose root is a div): the handler reads the caret.
          htmlInput: { style: { fontFamily: tokens.mono }, spellCheck: false, autoComplete: "off", "aria-label": ariaLabel, required: !optional, onKeyDown },
          inputLabel: { shrink: true },
          input: action ? { sx: { pr: 0.5 }, endAdornment: action } : undefined,
        }}
      />
      {rows.length > 0 && (
        // A click on a row must not take the keyboard from the field (the rows would close under the pointer).
        <Paper variant="outlined" onMouseDown={(e) => e.preventDefault()} sx={{ ...thinScroll, maxHeight: 264, borderRadius: "12px", pb: footer ? 0 : 0.5 }}>
          {group(t("pathPicker.children"), rows.slice(0, continuing), 0)}
          {group(t("pathPicker.chips"), rows.slice(continuing), continuing)}
          {footer}
        </Paper>
      )}
      {childRows.length > 0 && (
        <Paper variant="outlined" sx={{ ...thinScroll, maxHeight: 264, borderRadius: "12px", pb: footer ? 0 : 0.5 }}>
          {group(t("pathPicker.children"), childRows, 0)}
          {footer}
        </Paper>
      )}
      {!dropdown && !pick && probe?.status === "ok" && probe.children.length > 0 && (
        <Box>
          {caption(t("pathPicker.children"))}
          <Stack direction="row" role="list" aria-label={t("pathPicker.children")} sx={{ flexWrap: "wrap", gap: 0.75 }}>
            {probe.children.map((name) => (
              <Chip key={name} role="listitem" icon={<FolderIcon />} label={name} aria-label={t("pathPicker.child", { name })} onClick={() => take(appendChild(probe, name))} sx={chipSx} />
            ))}
          </Stack>
        </Box>
      )}
      {!dropdown && probe?.status === "ok" && probe.children.length === 0 && caption(t("pathPicker.noChildren"))}
      {/* Amber, not red: the path may still be the right one. */}
      {probe?.status === "denied" && <Alert severity="warning">{t("pathPicker.deniedHint")}</Alert>}
      {probe?.status === "error" && caption(t("pathPicker.error", { message: explain(probe.message).message }))}
    </Stack>
  );
}

type Props = Omit<ViewProps, "chips" | "probe" | "onFocus" | "onBlur" | "onKeyDown" | "dropdown" | "pick"> & {
  /** Folder rows get a box to tick, and the ticked ones can be pinned at once with this (M14). */
  onPinMany?: (places: Place[]) => Promise<PinSummary | void>;
  /** Told which folder rows are ticked, whenever that changes. */
  onTicked?: (paths: string[]) => void;
  /** The sidebar's form of the picker: a field with the suggestions in a dropdown under it. */
  dropdown?: boolean;
  /** The buckets the key lists: suggested while a bucket's name is being typed (dropdown only). */
  buckets?: string[];
  /** The key may not list buckets: while only a bucket's name is typed, a refusal or an error of the probe
   *  is the expected answer and is not shown. */
  quietBucket?: boolean;
  /** The connection the path is on; "" while there is none yet (a connection being added): nothing is asked then. */
  clusterId: string;
  /** Whose key: "" for the connection's own. */
  uid?: string;
  /** Ask nothing until the field has had the keyboard (a screen with one picker per connection). */
  lazy?: boolean;
};

/** The inline picker: chips of the connection's known places, and a live probe of what is typed
 *  (300 ms after the last key; an answer for an older text is dropped). Nothing here ever blocks
 *  or toasts: a path the key may not list can still be the one to open. */
export function PathPicker({ clusterId, uid = "", lazy, dropdown, buckets, quietBucket, onPinMany, onTicked, ...view }: Props) {
  const { profiles, pins, recents } = useContext(AccessContext);
  const [awake, setAwake] = useState(!lazy);
  const [answer, setProbe] = useState<Probe | null>(null);
  // In a list, what is asked about is the item being typed.
  const current = lastItem(view.value, view.multiline)[1];
  // Nothing is said about a bucket name half typed by a key that cannot list buckets.
  const probe = quietBucket && answer?.status !== "ok" && !typedPath(current).includes("/") ? null : answer;
  // The dropdown: open while the field has the keyboard, until Esc; typing opens it again.
  const [focused, setFocused] = useState(false);
  const [closed, setClosed] = useState(false);
  const [highlight, showHighlight] = useState(0);
  // The same position for key presses that arrive before the next render.
  const cursor = useRef(0);
  // The last key moved the highlight: Space ticks the row then, it does not type.
  const navigating = useRef(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const setHighlight = (next: number) => {
    cursor.current = next;
    showHighlight(next);
  };
  useEffect(() => {
    setHighlight(0);
    setClosed(false);
    // Ticks are for one level: another path, other folders.
    setTicked([]);
  }, [view.value]);
  useEffect(() => onTicked?.(ticked), [ticked]);
  // Prefixes each bucket's policy grants this key, as far as the key may read the policy.
  const [policy, setPolicy] = useState<Record<string, string[]>>({});
  const startPaths = profiles.find((p) => p.id === clusterId)?.start_paths;
  const split = splitPath(current);
  // The bucket being typed counts once its name is finished (a "/" follows, or S3 answered for it).
  const typedBucket = !split.error && (typedPath(current).includes("/") || probe?.status === "ok") ? split.bucket : "";
  const known = accessChips({ startPaths, pins, recents, policy: {} }, clusterId, uid).map((chip) => chip.path.split("/")[0]);
  const scanned = [...new Set([...known.slice(0, MAX_SCANNED), ...(typedBucket ? [typedBucket] : [])])].join("/");
  useEffect(() => setPolicy({}), [clusterId, uid]);
  useEffect(() => {
    // The policy is read with the connection's own key, so it says nothing about another user's.
    if (!awake || !clusterId || uid) return;
    let stale = false;
    for (const bucket of scanned.split("/").filter((name) => name && !(name in policy)))
      invoke<string[]>("accessible_prefixes", { clusterId, bucket }).then(
        (prefixes) => stale || setPolicy((old) => ({ ...old, [bucket]: prefixes })),
        () => {},
      );
    return () => {
      stale = true;
    };
  }, [awake, clusterId, uid, scanned]);
  useEffect(() => {
    setProbe(null);
    if (!awake || !clusterId || split.error) return;
    let stale = false;
    const timer = setTimeout(() => {
      invoke<Probe>("path_probe", { clusterId, path: current, uid }).then(
        (answer) => stale || setProbe(answer),
        () => {},
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [awake, clusterId, uid, current]);
  const chips = clusterId && awake ? accessChips({ startPaths, pins, recents, policy }, clusterId, uid) : [];
  const open = !!dropdown && focused && !closed;
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "Escape") return setClosed(true);
    // Shift+Tab leaves the field as it does anywhere.
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    // Tab completes what is being typed; in an empty field it moves on (tabbing through the sidebar must not fill it).
    if (e.key === "Tab" && !view.value.trim()) return;
    const act = suggestKey(e.key, suggestions(view.value, probe, chips, buckets), cursor.current, e.currentTarget.selectionStart === e.currentTarget.value.length, navigating.current && !!onPinMany);
    navigating.current = e.key === "ArrowDown" || e.key === "ArrowUp" || (!!act && "toggle" in act);
    if (!act) return;
    e.preventDefault();
    if ("value" in act) view.onChange(act.value);
    else if ("toggle" in act) setTicked((old) => toggled(old, act.toggle));
    else setHighlight(act.highlight);
  }
  const pick = onPinMany && {
    ticked,
    onTicked: setTicked,
    onPinSelected: () => {
      // A refusal (the list is full) leaves the ticks: they show what was asked for.
      onPinMany(tickedPlaces(ticked, clusterId, uid)).then((done) => done?.stopped || setTicked([]), () => {});
    },
  };
  return (
    <PathPickerView
      {...view}
      chips={chips}
      probe={probe}
      onFocus={() => {
        setAwake(true);
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={dropdown ? onKeyDown : undefined}
      dropdown={dropdown ? { open, highlight, buckets } : undefined}
      pick={pick || undefined}
    />
  );
}

type DialogProps = {
  open: boolean;
  title: string;
  submitLabel: string;
  clusterId: string;
  uid?: string;
  /** Set when the path is pinned from no tab's connection: the dialog asks which connection, and says so here. */
  onCluster?: (clusterId: string) => void;
  /** Every place of the list typed or pasted, and the folders ticked under it; `invalid`: how many of its items were no place. */
  onSubmit: (places: { bucket: string; prefix: string }[], invalid: number) => Promise<PinSummary>;
  onClose: () => void;
};

/** The paths of the pin dialog's list: the places in it, and the items that are none. */
export function pathList(text: string) {
  const items = splitPathList(text).map((item) => ({ item, at: splitPath(item) }));
  return {
    places: items.flatMap(({ at }) => (at.error ? [] : [{ bucket: at.bucket, prefix: at.prefix }])),
    bad: items.filter(({ at }) => at.error).map(({ item }) => item),
  };
}

/** What the pin dialog pins: every place of its list, and the folders ticked under the field in place of the
 *  line they are under (the one being typed, which was only the way to them). */
export function dialogPins(text: string, ticked: string[]) {
  if (ticked.length === 0) return pathList(text);
  const before = pathList(lastItem(text, true)[0]);
  return { places: [...before.places, ...pathList(ticked.join("\n")).places], bad: before.bad };
}

/** The picker as a dialog, for pinning paths: one per line, or a pasted list. */
export function PathPickerDialog({ open, title, submitLabel, clusterId, uid, onCluster, onSubmit, onClose }: DialogProps) {
  const { profiles } = useContext(AccessContext);
  const [path, setPath] = useState("");
  const ticked = useRef<string[]>([]);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setPath("");
  }, [open]);
  // M15: the footer's Pin and the dialog's own do the same, so neither leaves the other's half undone.
  async function pin() {
    const { places, bad } = dialogPins(path, ticked.current);
    if (places.length === 0) return;
    const done = await onSubmit(places, bad.length);
    // What was not pinned stays in the field (the summary says why), with the keyboard; all done closes the dialog.
    const left = done.stopped ? places.slice(places.length - done.stopped.left).map((place) => joinPath(place.bucket, place.prefix)) : [];
    if (bad.length || left.length) {
      setPath([...bad, ...left].join("\n"));
      field.current?.focus();
    } else onClose();
    return done;
  }
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="path-picker-title">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          pin();
        }}
      >
        <DialogTitle id="path-picker-title">{title}</DialogTitle>
        <DialogContent>
          {onCluster && (
            <TextField
              select
              label={t("common.connection")}
              value={clusterId}
              onChange={(e) => onCluster(e.target.value)}
              size="small"
              fullWidth
              sx={{ mt: 1 }}
              slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </TextField>
          )}
          <Box sx={{ pt: onCluster ? 2 : 1 }}>{open && <PathPicker key={clusterId} clusterId={clusterId} uid={uid} value={path} onChange={setPath} label={t("browse.openPath")} helperText={t("pins.addHelp")} multiline onPinMany={pin} onTicked={(paths) => (ticked.current = paths)} inputRef={field} autoFocus />}</Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="contained" disabled={pathList(path).places.length === 0}>
            {submitLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
