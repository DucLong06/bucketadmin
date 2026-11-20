// Typing a path with the key's reach in sight: the places this connection is known to open
// (start path, pins, recent places, what a bucket policy grants) as chips, and under the field
// what S3 says about the path being typed: its folders, or that it may not be listed there.
import { createContext, type FormEvent, type ReactNode, type Ref, useContext, useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { invoke, type Profile } from "./api";
import { explain } from "./errors";
import { t, type Key } from "./i18n";
import { joinPath, splitPath } from "./paths";
import type { Pin } from "./pins";
import type { Place } from "./tabs";
import { tokens } from "./theme";
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

/** The chips of one connection and key, in the order start path, pins, recent places, policy;
 *  a path named by two sources is shown once, under the first. */
export function accessChips(known: { startPath?: string; pins: Pin[]; recents: Place[]; policy: Record<string, string[]> }, clusterId: string, uid = ""): AccessChip[] {
  const mine = (place: Place) => place.clusterId === clusterId && place.uid === uid && !!place.bucket;
  const start = uid === "" ? splitPath(known.startPath ?? "") : { error: "paths.empty" as Key };
  const all: AccessChip[] = [
    ...(start.error ? [] : [{ path: joinPath(start.bucket, start.prefix), source: "start" as const }]),
    ...known.pins.filter((pin) => mine(pin.place)).map((pin) => ({ path: joinPath(pin.place.bucket, pin.place.prefix), source: "pin" as const })),
    ...known.recents.filter(mine).map((place) => ({ path: joinPath(place.bucket, place.prefix), source: "recent" as const })),
    ...Object.entries(known.policy).flatMap(([bucket, prefixes]) => prefixes.map((prefix) => ({ path: joinPath(bucket, prefix), source: "policy" as const }))),
  ];
  return all.filter((chip, i) => all.findIndex((other) => other.path === chip.path) === i);
}

/** The path after a click on a suggested folder: what is typed up to its last "/", then the folder. */
export const appendChild = (probe: { bucket: string; prefix: string }, child: string) => `${probe.bucket}/${probe.prefix.slice(0, probe.prefix.lastIndexOf("/") + 1)}${child}/`;

const icon = (path: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
    {path}
  </svg>
);
const FolderIcon = () => icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
const SOURCE_ICON: Record<ChipSource, ReactNode> = {
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
};

/** The picker as it looks for a given state; `PathPicker` adds the asking. */
export function PathPickerView({ value, onChange, label, helperText, ariaLabel, chips, probe, optional, autoFocus, inputRef, action, onFocus }: ViewProps) {
  const split = splitPath(value);
  const wrong = !!value.trim() && !!split.error;
  const caption = (text: string) => (
    <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
      {text}
    </Typography>
  );
  const chipSx = { maxWidth: "100%", fontFamily: tokens.mono, fontSize: 13.5 };
  return (
    <Stack spacing={1.25} sx={{ minWidth: 0, flexGrow: 1 }}>
      {chips.length > 0 && (
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
                  onClick={() => onChange(chip.path)}
                  sx={chipSx}
                />
              </Tooltip>
            ))}
          </Stack>
        </Box>
      )}
      <TextField
        label={label}
        placeholder={t("browse.openPathSample")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        size="small"
        fullWidth
        autoFocus={autoFocus}
        error={wrong}
        helperText={wrong && split.error ? t(split.error) : (helperText ?? t("browse.openPathHelp"))}
        inputRef={inputRef}
        slotProps={{
          htmlInput: { style: { fontFamily: tokens.mono }, spellCheck: false, "aria-label": ariaLabel, required: !optional },
          inputLabel: { shrink: true },
          input: action ? { sx: { pr: 0.5 }, endAdornment: action } : undefined,
        }}
      />
      {probe?.status === "ok" && probe.children.length > 0 && (
        <Box>
          {caption(t("pathPicker.children"))}
          <Stack direction="row" role="list" aria-label={t("pathPicker.children")} sx={{ flexWrap: "wrap", gap: 0.75 }}>
            {probe.children.map((name) => (
              <Chip key={name} role="listitem" icon={<FolderIcon />} label={name} aria-label={t("pathPicker.child", { name })} onClick={() => onChange(appendChild(probe, name))} sx={chipSx} />
            ))}
          </Stack>
        </Box>
      )}
      {probe?.status === "ok" && probe.children.length === 0 && caption(t("pathPicker.noChildren"))}
      {/* Amber, not red: the path may still be the right one. */}
      {probe?.status === "denied" && <Alert severity="warning">{t("pathPicker.deniedHint")}</Alert>}
      {probe?.status === "error" && caption(t("pathPicker.error", { message: explain(probe.message).message }))}
    </Stack>
  );
}

type Props = Omit<ViewProps, "chips" | "probe" | "onFocus"> & {
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
export function PathPicker({ clusterId, uid = "", lazy, ...view }: Props) {
  const { profiles, pins, recents } = useContext(AccessContext);
  const [awake, setAwake] = useState(!lazy);
  const [probe, setProbe] = useState<Probe | null>(null);
  // Prefixes each bucket's policy grants this key, as far as the key may read the policy.
  const [policy, setPolicy] = useState<Record<string, string[]>>({});
  const startPath = profiles.find((p) => p.id === clusterId)?.start_path;
  const split = splitPath(view.value);
  // The bucket being typed counts once its name is finished (a "/" follows, or S3 answered for it).
  const typedBucket = !split.error && (view.value.trim().replace(/^s3:\/\//i, "").replace(/^\/+/, "").includes("/") || probe?.status === "ok") ? split.bucket : "";
  const known = accessChips({ startPath, pins, recents, policy: {} }, clusterId, uid).map((chip) => chip.path.split("/")[0]);
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
      invoke<Probe>("path_probe", { clusterId, path: view.value, uid }).then(
        (answer) => stale || setProbe(answer),
        () => {},
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [awake, clusterId, uid, view.value]);
  const chips = clusterId && awake ? accessChips({ startPath, pins, recents, policy }, clusterId, uid) : [];
  return <PathPickerView {...view} chips={chips} probe={probe} onFocus={() => setAwake(true)} />;
}

type DialogProps = {
  open: boolean;
  title: string;
  submitLabel: string;
  clusterId: string;
  uid?: string;
  onSubmit: (bucket: string, prefix: string) => void;
  onClose: () => void;
};

/** The picker as a dialog: for opening a path and for pinning one. */
export function PathPickerDialog({ open, title, submitLabel, clusterId, uid, onSubmit, onClose }: DialogProps) {
  const [path, setPath] = useState("");
  useEffect(() => {
    if (open) setPath("");
  }, [open]);
  const split = splitPath(path);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (split.error) return;
    onSubmit(split.bucket, split.prefix);
    onClose();
  }
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="path-picker-title">
      <form onSubmit={submit}>
        <DialogTitle id="path-picker-title">{title}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>{open && <PathPicker clusterId={clusterId} uid={uid} value={path} onChange={setPath} label={t("browse.openPath")} autoFocus />}</Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="contained" disabled={!!split.error}>
            {submitLabel}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
