import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Link,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { invoke, maskKey, type BrowseBucket, type Listing, type Marker, type ObjectEntry, type Profile } from "./api";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { formatBytes, TZ, vnTime } from "./format";
import AclEditor from "./AclEditor";
import { CreateBucketDialog, CreateFolderDialog } from "./BrowseDialogs";
import { accessLevel, type Access } from "./caps";
import MyInfo from "./MyInfo";
import ObjectDrawer, { canUndelete, download, finalDeleteWarning, undeleteHint, type Versioning } from "./ObjectDrawer";
import { placeLabel, type Place } from "./tabs";
import { eyebrow, tokens } from "./theme";
import type { StartTransfer } from "./transfers";
import { explain } from "./errors";
import { t, type Key } from "./i18n";
import { CallerContext, ClusterSelect, ConfirmDialog, copyText, ErrorAlert, useAction } from "./ui";
import { VirtualTable, type Column } from "./virtual";

type Props = {
  profiles: Profile[];
  /** Where the tab starts; read once, when the tab is created. */
  start: Place;
  /** Whether this tab is the one on screen: only that one takes dropped files and shows toasts. */
  active: boolean;
  startTransfer: StartTransfer;
  /** The tab is somewhere else now (also "no bucket open"): its title follows. */
  onPlace: (at: Place) => void;
  /** A place worth finding again was opened. */
  remember: (at: Place) => void;
  recents: Place[];
  /** Go to a recent place (the app picks the tab). */
  onRecent: (at: Place) => void;
};
const RECENT_IN_SIDEBAR = 6;
/** `uid` is empty while browsing with the caller's own saved key. */
type Session = { uid: string; access_key: string; buckets: BrowseBucket[] };
type Row = { folder: string } | { object: ObjectEntry };
type DeleteReport = { objects: number; deleted: number; failed: { key: string; error: string }[]; markers: Marker[] };
/** `undo`: delete markers the toast's undo button removes again. */
type Notice = { severity: "success" | "error" | "info"; text: string; undo?: Marker[] };
type Deleted = { prefixes: string[]; objects: ObjectEntry[]; truncated: boolean };
const VERSIONING_LABEL: Record<string, Key> = { Enabled: "browse.versioning.on", Suspended: "browse.versioning.suspended", "": "browse.versioning.off" };
type Found = { matches: ObjectEntry[]; scanned: number; stopped: "done" | "results" | "time" };
// Limits of one search; the backend enforces its own caps on top.
const SEARCH_RESULTS = 500;
const SEARCH_SECONDS = 20;
const FOUND: Record<Found["stopped"], Key> = { done: "browse.found.done", results: "browse.found.results", time: "browse.found.time" };
// Expiry of a URL made by the Copy URL button (the Properties tab offers other expiries).
const COPY_URL_SECS = 900;
const NO_VERSIONING: Versioning = { supported: false, status: "", reason: null };

/** Rows of the object table that fit the window (the page itself scrolls for the rest). */
function useTableHeight() {
  const fit = () => Math.max(308, window.innerHeight - 500);
  const [height, setHeight] = useState(fit);
  useEffect(() => {
    const onResize = () => setHeight(fit());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}
const th = (text: string) => (
  <Box component="span" sx={{ ...eyebrow, color: "text.secondary" }}>
    {text}
  </Box>
);

/** "a/b/c.txt" under prefix "a/b/" is shown as "c.txt". */
const baseName = (key: string, prefix: string) => key.slice(prefix.length);

export default function Browse({ profiles, start, active, startTransfer, onPlace, remember, recents, onRecent }: Props) {
  const [clusterId, setClusterId] = useState(start.clusterId);
  useEffect(() => {
    // The tab's connection was removed (or there was none yet): fall back to the first one.
    if (!profiles.some((p) => p.id === clusterId)) setClusterId(profiles[0]?.id ?? "");
  }, [profiles]);
  // Where to go once the first session is open; used up by that.
  const first = useRef<Place | null>(start);
  // What this connection's key may read on the Admin API, asked once per connection. It only
  // decides two extras: the "my info" box, and browsing with another user's key.
  const [access, setAccess] = useState<Access | null>(null);
  useEffect(() => {
    setAccess(null);
    if (!clusterId) return;
    let stale = false;
    // A key without caps (the normal case) or an unreachable cluster: no extras, no error.
    invoke<Access>("caller_access", { clusterId }).then(
      (answer) => stale || setAccess(answer),
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [clusterId]);
  const canBrowseAs = access?.users === true;
  const [uidInput, setUidInput] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [bucket, setBucket] = useState("");
  const [bucketInput, setBucketInput] = useState("");
  const [prefix, setPrefix] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const { busy, error, run, setError } = useAction();
  const request = useRef(0);
  const opening = useRef(0);
  const [selected, setSelected] = useState<ObjectEntry | null>(null);
  // The tab (its id in ObjectDrawer) the object sheet opens on, when the context menu asked for one.
  const [startTab, setStartTab] = useState<string | undefined>();
  const openObject = (object: ObjectEntry, tab?: string) => {
    setStartTab(tab);
    setSelected(object);
  };
  // Right-clicked row and where the pointer was.
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number } | null>(null);
  const tableHeight = useTableHeight();
  const [versioning, setVersioning] = useState<Versioning>(NO_VERSIONING);
  // The prefix whose ACL dialog is open ("" = the bucket itself); null when closed.
  const [aclOf, setAclOf] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [creating, setCreating] = useState<"bucket" | "folder" | null>(null);
  // Ticked rows: "f:<prefix>" for folders, "o:<key>" for objects.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<{ objects: number; keys: string[]; prefixes: string[] } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Deleted but restorable keys of the open folder, while "show deleted objects" is on.
  const [showDeleted, setShowDeleted] = useState(false);
  const [gone, setGone] = useState<Deleted | null>(null);
  // The versioning state the user asked to switch to, while its confirmation is open.
  const [switching, setSwitching] = useState<boolean | null>(null);
  const rowId = (r: Row) => ("folder" in r ? `f:${r.folder}` : `o:${r.object.key}`);
  const pickedOf = (kind: "f" | "o") => [...picked].filter((id) => id.startsWith(`${kind}:`)).map((id) => id.slice(2));
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // A presigned GET URL of one object, straight to the clipboard.
  async function copyUrl(key: string) {
    if (!session) return;
    const at = { clusterId, uid: session.uid, bucket, key };
    const url = await run(() => invoke<string>("browse_presign", { at, expiresSecs: COPY_URL_SECS }));
    if (!url) return;
    await copyText(url);
    setNotice({ severity: "success", text: t("browse.urlCopied", { key, minutes: COPY_URL_SECS / 60 }) });
  }

  // First a dry run: the confirmation states how many objects the selection really stands for.
  async function planDelete(keys: string[], prefixes: string[]) {
    if (!session) return;
    const at = { clusterId, uid: session.uid, bucket };
    const report = await run(() => invoke<DeleteReport>("browse_delete_many", { at, keys, prefixes, dryRun: true }));
    if (report) setPlan({ objects: report.objects, keys, prefixes });
  }
  async function deletePicked() {
    if (!session || !plan) return;
    const at = { clusterId, uid: session.uid, bucket };
    const { keys, prefixes } = plan;
    const report = await run(() => invoke<DeleteReport>("browse_delete_many", { at, keys, prefixes, dryRun: false }));
    if (!report) return;
    setPlan(null);
    const first = report.failed[0];
    const undo = report.markers.length > 0 ? report.markers : undefined;
    setNotice(
      first
        ? {
            severity: "error",
            text: t("browse.deletedSome", { deleted: report.deleted, objects: report.objects, failed: report.failed.length, key: first.key, error: explain(first.error).message }),
            undo,
          }
        : deletedNotice(report.deleted, undo),
    );
    load(bucket, prefix, null);
  }
  const deletedNotice = (count: number, undo?: Marker[]): Notice =>
    undo
      ? { severity: "success", text: t("browse.deletedMarked", { n: count }), undo }
      : { severity: "success", text: t("browse.deletedFinal", { n: count }) };
  // Removing the delete markers a delete just left makes the objects current again.
  async function undoDelete(markers: Marker[]) {
    if (!session) return;
    setNotice(null);
    const at = { clusterId, uid: session.uid, bucket };
    const report = await run(() => invoke<DeleteReport>("browse_undelete", { at, markers }));
    if (!report) return;
    const first = report.failed[0];
    setNotice(
      first
        ? { severity: "error", text: t("browse.restoredSome", { restored: report.deleted, objects: report.objects, key: first.key, error: explain(first.error).message }) }
        : { severity: "success", text: t("browse.restored", { n: report.deleted }) },
    );
    load(bucket, prefix, null);
  }
  async function switchVersioning() {
    if (!session || switching === null) return;
    const at = { clusterId, uid: session.uid, bucket };
    const now = await run(() => invoke<Versioning>("browse_set_versioning", { at, enabled: switching }));
    if (!now) return;
    setVersioning(now);
    setSwitching(null);
  }
  function loadGone(toBucket: string, toPrefix: string, mine: number) {
    if (!session) return;
    const at = { clusterId, uid: session.uid, bucket: toBucket, key: toPrefix };
    // Shown next to the listing when it arrives; a failure only means nothing extra is shown.
    invoke<Deleted>("browse_deleted", { at }).then(
      (found) => mine === request.current && setGone(found),
      () => {},
    );
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!session || !pattern.trim()) return;
    const at = { clusterId, uid: session.uid, bucket };
    const result = await run(() =>
      invoke<Found>("browse_search", { at, prefix, pattern, maxResults: SEARCH_RESULTS, maxSecs: SEARCH_SECONDS }),
    );
    setFound(result ?? null);
  }
  const activeNow = useRef(active);
  activeNow.current = active;
  // Where a dropped file goes: read by the drop listener, which outlives renders.
  const here = useRef({ open: false, uid: "", bucket: "", prefix: "" });
  here.current = { open: session !== null, uid: session?.uid ?? "", bucket, prefix };

  async function upload(paths: string[]) {
    const { open: isOpen, uid: asUid, bucket: toBucket, prefix: toPrefix } = here.current;
    if (!isOpen || !toBucket) return;
    // All queued at once: the task panel runs a few in parallel and holds the rest.
    await Promise.all(
      paths.map((path) => {
        const key = toPrefix + path.slice(path.lastIndexOf("/") + 1);
        const at = { clusterId, uid: asUid, bucket: toBucket, key };
        return startTransfer(`↑ ${toBucket}/${key}`, (transferId) => invoke<number>("browse_upload", { at, path, transferId }));
      }),
    );
    const now = here.current;
    if (now.bucket === toBucket && now.prefix === toPrefix) load(toBucket, toPrefix, null);
  }
  // The drop listener is registered once; it must call this render's `upload`, not the first
  // render's (which has no session and so would upload but never refresh the listing).
  const uploadNow = useRef(upload);
  uploadNow.current = upload;
  useEffect(() => {
    // The webview reports dropped files with their paths (not their content).
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      // Every tab listens; the drop belongs to the one on screen.
      if (e.payload.type === "drop" && activeNow.current) uploadNow.current(e.payload.paths);
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // An empty target is the connection's own key: the backend signs with it and makes no Admin
  // API call. Any other target is a uid whose key the backend looks up (needs users=read).
  // Either way the UI never sees a secret.
  async function open(target: string) {
    const mine = ++opening.current;
    setSession(null);
    setBucket("");
    setListing(null);
    if (!clusterId) return;
    const opened = await run(() => invoke<Omit<Session, "uid">>("browse_open", { clusterId, uid: target }));
    // An answer for a connection or user that was left meanwhile must not become the session.
    if (mine !== opening.current) return;
    if (!opened) return;
    setSession({ uid: target, ...opened });
    const goTo = first.current;
    first.current = null;
    if (goTo?.bucket && goTo.clusterId === clusterId) load(goTo.bucket, goTo.prefix, null, target);
    else onPlace({ clusterId, uid: target, bucket: "", prefix: "" });
  }
  useEffect(() => {
    // The first session of a tab is the one its starting place names.
    const as = first.current?.clusterId === clusterId ? first.current.uid : "";
    setUidInput(as);
    open(as);
  }, [clusterId]);

  // `as`: the session's uid when the session was opened in this very call (state not updated yet).
  async function load(toBucket: string, toPrefix: string, token: string | null, as?: string) {
    const uid = as ?? session?.uid;
    if (uid === undefined) return;
    const mine = ++request.current;
    if (token === null) {
      if (toBucket !== bucket) {
        // Asked once per bucket; a key that may not ask simply gets no Versions tab.
        setVersioning(NO_VERSIONING);
        setShowDeleted(false);
        const at = { clusterId, uid, bucket: toBucket };
        invoke<Versioning>("browse_versioning", { at }).then(setVersioning, () => {});
      }
      setBucket(toBucket);
      setPrefix(toPrefix);
      setListing(null);
      setFound(null);
      setPicked(new Set());
      setGone(null);
      if (showDeleted && toBucket === bucket) loadGone(toBucket, toPrefix, mine);
    }
    const page = await run(() =>
      invoke<Listing>("browse_list", { clusterId, uid, bucket: toBucket, prefix: toPrefix, token }),
    );
    // A slower answer for a folder the user already left must not overwrite the table.
    if (!page || mine !== request.current) return;
    if (token === null) {
      const at = { clusterId, uid, bucket: toBucket, prefix: toPrefix };
      onPlace(at);
      remember(at);
    }
    setListing((old) =>
      token === null || !old
        ? page
        : { prefixes: [...old.prefixes, ...page.prefixes], objects: [...old.objects, ...page.objects], next_token: page.next_token },
    );
  }

  function onBucketCreated(name: string) {
    const byName = (a: BrowseBucket, b: BrowseBucket) => a.name.localeCompare(b.name);
    setSession((s) => s && { ...s, buckets: [...s.buckets, { name, created: "" }].sort(byName) });
    load(name, "", null);
  }

  // A folder made by an S3 tool has a zero-byte marker object named like the folder itself: not content.
  const objects = (listing?.objects ?? []).filter((o) => o.key !== prefix);
  // Search results replace the folder view until they are closed; keys stay relative to the open folder.
  // With "show deleted objects": deleted keys, and folders that hold nothing but deleted keys.
  const goneFolders = (gone?.prefixes ?? []).filter((p) => !listing?.prefixes.includes(p));
  const goneObjects = (gone?.objects ?? []).map((o) => ({ ...o, deleted: true }));
  const rows: Row[] = found
    ? found.matches.map((object) => ({ object }))
    : listing
      ? [...[...listing.prefixes, ...goneFolders].map((folder) => ({ folder })), ...[...objects, ...goneObjects].map((object) => ({ object }))]
      : [];
  // A deleted key cannot be ticked: there is nothing to delete or to make a URL of.
  const isGone = (r: Row) => "object" in r && r.object.deleted === true;
  const tickable = rows.filter((r) => !isGone(r));
  const allPicked = tickable.length > 0 && tickable.every((r) => picked.has(rowId(r)));
  const nameOf = (r: Row) => baseName("folder" in r ? r.folder : r.object.key, prefix);
  const columns: Column<Row>[] = [
    {
      header: (
        <Checkbox
          size="small"
          sx={{ p: 0 }}
          checked={allPicked}
          indeterminate={picked.size > 0 && !allPicked}
          onChange={(e) => setPicked(e.target.checked ? new Set(tickable.map(rowId)) : new Set())}
          slotProps={{ input: { "aria-label": t("browse.selectAll") } }}
        />
      ),
      width: "28px",
      cell: (r) =>
        isGone(r) ? null : (
          <Checkbox
            size="small"
            sx={{ p: 0 }}
            checked={picked.has(rowId(r))}
            onChange={() => toggle(rowId(r))}
            slotProps={{ input: { "aria-label": t("browse.selectRow", { name: nameOf(r) }) } }}
          />
        ),
    },
    {
      header: th(t("browse.col.name")),
      width: "minmax(240px, 4fr)",
      cell: (r) =>
        "folder" in r ? (
          <Link component="button" onClick={() => load(bucket, r.folder, null)} aria-label={t("browse.openFolder", { folder: r.folder })} sx={{ fontFamily: tokens.mono, fontSize: 15 }}>
            {baseName(r.folder, prefix)}
          </Link>
        ) : (
          <Link
            component="button"
            color="inherit"
            underline="hover"
            sx={{ fontFamily: tokens.mono, fontSize: 15 }}
            onClick={() => {
              openObject(r.object);
              // Reached through a search: the folder it lies in is worth finding again.
              if (found && session) remember({ clusterId, uid: session.uid, bucket, prefix: r.object.key.slice(0, r.object.key.lastIndexOf("/") + 1) });
            }}
            aria-label={t("browse.openObject", { key: r.object.key })}
          >
            {baseName(r.object.key, prefix)}
            {r.object.deleted && <Chip size="small" color="warning" variant="outlined" label={t("browse.deletedChip")} sx={{ ml: 1 }} />}
          </Link>
        ),
    },
    { header: th(t("browse.col.size")), width: "110px", align: "right", cell: (r) => ("object" in r && !r.object.deleted ? formatBytes(r.object.size) : "—") },
    { header: th(t("browse.col.modified", { tz: TZ })), width: "190px", cell: (r) => ("object" in r ? vnTime(r.object.last_modified) : "") },
    // The owner is in the object's properties; the concept's table stops at the storage class.
    { header: th(t("browse.col.storageClass")), width: "140px", cell: (r) => ("object" in r ? r.object.storage_class : "") },
  ];

  // Breadcrumb: bucket, then one link per folder level of the prefix.
  const parts = prefix.split("/").filter(Boolean);
  const crumbs = parts.map((name, i) => ({ name, prefix: `${parts.slice(0, i + 1).join("/")}/` }));

  function openByName(e: FormEvent) {
    e.preventDefault();
    if (bucketInput.trim()) load(bucketInput.trim(), "", null);
  }

  if (profiles.length === 0) {
    return <Alert severity="info">{t("browse.noConnection")}</Alert>;
  }
  const label = profiles.find((p) => p.id === clusterId)?.label ?? "";
  const card = { borderRadius: "16px" };
  // What the context menu offers for the row under the pointer.
  const menuRow = menu?.row;
  const menuObject = menuRow && "object" in menuRow ? menuRow.object : null;
  const menuFolder = menuRow && "folder" in menuRow ? menuRow.folder : null;
  const pick = (action: () => void) => () => {
    setMenu(null);
    action();
  };
  return (
    <CallerContext.Provider value={access?.uid ?? ""}>
      <Box sx={{ display: "grid", gridTemplateColumns: "264px minmax(0, 1fr)", gap: 3, alignItems: "start" }}>
        <Stack component="aside" spacing={2} aria-label={t("browse.sidebar")}>
          <ClusterSelect profiles={profiles} value={clusterId} onChange={setClusterId} />
          {canBrowseAs && (
            <Stack
              component="form"
              direction="row"
              spacing={1}
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                setError(null);
                open(uidInput.trim());
              }}
            >
              <TextField label={t("browse.browseAs")} value={uidInput} onChange={(e) => setUidInput(e.target.value)} size="small" fullWidth />
              <Button type="submit" variant="outlined" disabled={busy || !uidInput.trim()}>
                {t("common.open")}
              </Button>
            </Stack>
          )}
          {session && (
            <Typography variant="body2" color="text.secondary">
              {t("browse.usingKey")}{" "}
              <Box component="span" sx={{ fontFamily: tokens.mono, fontSize: 14 }}>
                {maskKey(session.access_key)}
              </Box>{" "}
              {session.uid ? t("browse.usingKeyOfUser", { uid: session.uid }) : t("browse.usingKeyMine")}
              {session.uid && (
                <Link
                  component="button"
                  sx={{ ml: 0.5 }}
                  onClick={() => {
                    setUidInput("");
                    open("");
                  }}
                >
                  {t("browse.backToMyKey")}
                </Link>
              )}
            </Typography>
          )}
          {session && (
            <Paper variant="outlined" sx={card}>
              <Typography component="h2" sx={{ ...eyebrow, color: "text.secondary", px: 2, pt: 2 }}>
                {session.uid ? t("browse.bucketsOfUser", { uid: session.uid }) : t("browse.bucketsMine")}
              </Typography>
              <List dense aria-label={t("browse.bucketList")}>
                {session.buckets.map((b) => (
                  <ListItemButton key={b.name} selected={b.name === bucket} onClick={() => load(b.name, "", null)}>
                    <ListItemText primary={b.name} slotProps={{ primary: { sx: { fontFamily: tokens.mono, fontSize: 15 } } }} />
                  </ListItemButton>
                ))}
              </List>
              {session.buckets.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1 }}>
                  {t("browse.noBuckets")}
                </Typography>
              )}
              <Box sx={{ px: 2, pb: 2 }}>
                <Button size="small" variant="outlined" fullWidth onClick={() => setCreating("bucket")}>
                  {t("browse.createBucket")}
                </Button>
              </Box>
              <Stack component="form" onSubmit={openByName} spacing={1} sx={{ p: 2, borderTop: 1, borderColor: "divider" }}>
                <TextField
                  label={t("browse.openByName")}
                  value={bucketInput}
                  onChange={(e) => setBucketInput(e.target.value)}
                  size="small"
                  helperText={t("browse.openByNameHelp")}
                />
                <Button type="submit" size="small" variant="outlined" disabled={!bucketInput.trim()}>
                  {t("browse.openBucket")}
                </Button>
              </Stack>
            </Paper>
          )}
          {recents.length > 0 && (
            <Paper variant="outlined" sx={card}>
              <Typography component="h2" sx={{ ...eyebrow, color: "text.secondary", px: 2, pt: 2 }}>
                {t("browse.recent")}
              </Typography>
              <List dense aria-label={t("browse.recentList")}>
                {recents.slice(0, RECENT_IN_SIDEBAR).map((place) => (
                  <ListItemButton key={JSON.stringify(place)} onClick={() => onRecent(place)}>
                    <ListItemText primary={placeLabel(place, profiles)} slotProps={{ primary: { sx: { fontSize: 14, wordBreak: "break-all" } } }} />
                  </ListItemButton>
                ))}
              </List>
            </Paper>
          )}
        </Stack>

        <Stack spacing={2} sx={{ minWidth: 0 }}>
          {busy && <LinearProgress aria-label={t("browse.loading")} />}
          {plan === null && switching === null && <ErrorAlert error={error} />}
          {session && !bucket && (
            <Box>
              <Typography variant="overline" color="primary" component="p">
                {t("browse.eyebrow", { label })}
              </Typography>
              <Typography variant="h4" component="h1">
                {t("browse.chooseBucket")}
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2.5 }}>
                {t(session.buckets.length > 0 ? "browse.chooseBucketHint" : "browse.chooseBucketNone")}
              </Typography>
              <Box component="ul" aria-label={t("browse.bucketCards")} sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 1.75, listStyle: "none", p: 0, m: 0 }}>
                {session.buckets.map((b) => (
                  <li key={b.name}>
                    <Paper
                      component="button"
                      variant="outlined"
                      onClick={() => load(b.name, "", null)}
                      sx={{ ...card, display: "block", width: "100%", p: "14px 18px", textAlign: "left", color: "inherit", cursor: "pointer", "&:hover": { borderColor: "text.secondary" } }}
                    >
                      <Box component="strong" sx={{ display: "block", fontFamily: tokens.mono, fontSize: 16 }}>
                        {b.name}
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {b.created ? t("browse.bucketCreated", { date: vnTime(b.created).slice(0, 10) }) : t("browse.bucketJustCreated")}
                      </Typography>
                    </Paper>
                  </li>
                ))}
              </Box>
            </Box>
          )}
          {session && bucket && (
            <>
              <Stack direction="row" sx={{ alignItems: "flex-end", justifyContent: "space-between", gap: 3, flexWrap: "wrap" }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="overline" color="primary" component="p">
                    {t("browse.eyebrow", { label })}
                  </Typography>
                  <Breadcrumbs aria-label={t("browse.path")} separator="/" sx={{ fontFamily: tokens.serif, fontSize: 29, fontWeight: 600, lineHeight: 1.25, "& .MuiBreadcrumbs-separator": { color: "divider" } }}>
                    <Link component="button" underline="none" color={crumbs.length ? "text.secondary" : "text.primary"} onClick={() => load(bucket, "", null)} sx={{ font: "inherit" }}>
                      {bucket}
                    </Link>
                    {crumbs.map((c, i) => (
                      <Link
                        key={c.prefix}
                        component="button"
                        underline="none"
                        color={i === crumbs.length - 1 ? "text.primary" : "text.secondary"}
                        onClick={() => load(bucket, c.prefix, null)}
                        sx={{ font: "inherit" }}
                      >
                        {c.name}
                      </Link>
                    ))}
                  </Breadcrumbs>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button variant="contained" onClick={async () => upload(await invoke<string[]>("browse_pick_upload", { title: t("browse.pickUploadTitle") }))}>
                    {t("common.upload")}
                  </Button>
                  <Button variant="outlined" onClick={() => setCreating("folder")}>
                    {t("browse.createFolder")}
                  </Button>
                  <Button
                    variant="outlined"
                    disabled={busy || picked.size !== 1 || pickedOf("o").length !== 1}
                    onClick={() => copyUrl(pickedOf("o")[0])}
                    title={t("browse.copyUrlHint")}
                  >
                    {t("browse.copyUrl")}
                  </Button>
                  <Button variant="outlined" color="error" disabled={busy || picked.size === 0} onClick={() => planDelete(pickedOf("o"), pickedOf("f"))}>
                    {t("browse.deleteCount", { n: picked.size })}
                  </Button>
                </Stack>
              </Stack>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
                {versioning.supported && (
                  <>
                    <Chip
                      variant="outlined"
                      color={versioning.status === "Enabled" ? "success" : versioning.status === "Suspended" ? "warning" : "default"}
                      label={t("browse.versioningChip", { status: VERSIONING_LABEL[versioning.status] ? t(VERSIONING_LABEL[versioning.status]) : versioning.status })}
                    />
                    <Button size="small" disabled={busy} onClick={() => setSwitching(versioning.status !== "Enabled")}>
                      {t(versioning.status === "Enabled" ? "browse.versioningOff" : "browse.versioningOn")}
                    </Button>
                  </>
                )}
                <Button size="small" onClick={() => setAclOf("")}>
                  {t("browse.bucketAcl")}
                </Button>
                {prefix && (
                  <Button size="small" onClick={() => setAclOf(prefix)} title={t("browse.folderAclHint")}>
                    {t("browse.folderAcl")}
                  </Button>
                )}
                <Button size="small" onClick={() => load(bucket, prefix, null)} disabled={busy}>
                  {t("browse.refresh")}
                </Button>
                <Box sx={{ flexGrow: 1 }} />
                <Stack component="form" onSubmit={search} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <TextField
                    label={t("browse.searchLabel")}
                    placeholder="*.parquet"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    size="small"
                    sx={{ width: 340 }}
                    title={t("browse.searchHint", { results: SEARCH_RESULTS, seconds: SEARCH_SECONDS })}
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                  <Button type="submit" variant="outlined" disabled={busy || !pattern.trim()}>
                    {t("browse.search")}
                  </Button>
                </Stack>
              </Stack>
              {found && (
                <Alert
                  severity={found.stopped === "done" ? "success" : "warning"}
                  action={
                    <Button color="inherit" size="small" onClick={() => setFound(null)}>
                      {t("browse.closeResults")}
                    </Button>
                  }
                >
                  {t(FOUND[found.stopped], { n: found.matches.length, scanned: found.scanned, results: SEARCH_RESULTS, seconds: SEARCH_SECONDS })}
                </Alert>
              )}
              <VirtualTable
                columns={columns}
                rows={rows}
                height={tableHeight}
                rowHeight={44}
                label={t("browse.objectList")}
                onRowMenu={(row, e) => {
                  e.preventDefault();
                  setMenu({ row, x: e.clientX, y: e.clientY });
                }}
                empty={<Typography color="text.secondary">{found ? t("browse.noMatch") : listing ? t("browse.emptyFolder") : ""}</Typography>}
              />
              {listing && !found && (
                <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
                  <Typography variant="body2" color="text.secondary">
                    {t(listing.next_token ? "browse.loadedMore" : "browse.loaded", { folders: listing.prefixes.length, objects: objects.length })} {t("browse.dropHint")}
                  </Typography>
                  {listing.next_token && (
                    <Button size="small" variant="outlined" disabled={busy} onClick={() => load(bucket, prefix, listing.next_token)}>
                      {t("common.loadMore")}
                    </Button>
                  )}
                  {versioning.supported && versioning.status !== "" && (
                    <Button
                      size="small"
                      onClick={() => {
                        setShowDeleted(!showDeleted);
                        setGone(null);
                        if (!showDeleted) loadGone(bucket, prefix, request.current);
                      }}
                    >
                      {t(showDeleted ? "browse.hideDeleted" : "browse.showDeleted")}
                    </Button>
                  )}
                  {gone && (
                    <Typography variant="body2" color="text.secondary">
                      {t(gone.truncated ? "browse.goneTruncated" : "browse.gone", { n: gone.objects.length })}
                    </Typography>
                  )}
                </Stack>
              )}
            </>
          )}
          {access && (access.users || access.usage) && (
            // Keyed by connection: another connection's answer never shows under this one's name.
            <MyInfo key={clusterId} clusterId={clusterId} access={access} defaultOpen={false} />
          )}
        </Stack>
      </Box>
      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
        slotProps={{ list: { "aria-label": t("browse.rowMenu") } }}
      >
        {menuObject && !menuObject.deleted && session && (
          <MenuItem onClick={pick(() => download({ clusterId, uid: session.uid, bucket, key: menuObject.key }, startTransfer))}>{t("common.download")}</MenuItem>
        )}
        {menuObject && !menuObject.deleted && <MenuItem onClick={pick(() => copyUrl(menuObject.key))}>{t("browse.copyUrl")}</MenuItem>}
        {menuObject && !menuObject.deleted && <MenuItem onClick={pick(() => openObject(menuObject, "acl"))}>{t("browse.acl")}</MenuItem>}
        {menuObject && (
          <MenuItem disabled={!versioning.supported} onClick={pick(() => openObject(menuObject, "versions"))}>
            {t("browse.versions")}
          </MenuItem>
        )}
        {menuObject && !menuObject.deleted && (
          <MenuItem onClick={pick(() => planDelete([menuObject.key], []))} sx={{ color: "error.main" }}>
            {t("common.delete")}
          </MenuItem>
        )}
        {menuFolder && <MenuItem onClick={pick(() => load(bucket, menuFolder, null))}>{t("common.open")}</MenuItem>}
        {menuFolder && <MenuItem onClick={pick(() => setAclOf(menuFolder))}>{t("browse.acl")}</MenuItem>}
        {menuFolder && (
          <MenuItem onClick={pick(() => planDelete([], [menuFolder]))} sx={{ color: "error.main" }}>
            {t("common.delete")}
          </MenuItem>
        )}
      </Menu>
      <ConfirmDialog
        open={plan !== null}
        title={t("browse.deleteTitle")}
        text={
          plan
            ? t(plan.prefixes.length ? "browse.deletePlanFolders" : "browse.deletePlan", {
                objects: plan.objects,
                bucket,
                keys: plan.keys.length,
                folders: plan.prefixes.length,
                list: plan.prefixes.join(", "),
              })
            : ""
        }
        confirmLabel={t("browse.deleteConfirm", { n: plan?.objects ?? 0 })}
        busy={busy}
        error={error}
        onConfirm={deletePicked}
        onClose={() => {
          setPlan(null);
          setError(null);
        }}
      >
        {canUndelete(versioning) ? <Alert severity="info">{undeleteHint()}</Alert> : <Alert severity="error">{finalDeleteWarning(versioning)}</Alert>}
      </ConfirmDialog>
      <ConfirmDialog
        open={switching !== null}
        title={t(switching ? "browse.versioningOnTitle" : "browse.versioningOffTitle")}
        text={t(switching ? "browse.versioningOnText" : "browse.versioningOffText", { bucket })}
        confirmLabel={t(switching ? "browse.versioningOn" : "browse.versioningOff")}
        busy={busy}
        error={error}
        onConfirm={switchVersioning}
        onClose={() => {
          setSwitching(null);
          setError(null);
        }}
      />
      {/* An undo stays on screen longer: it is the quick way back. */}
      <Snackbar open={notice !== null && active} autoHideDuration={notice?.undo ? 20000 : 8000} onClose={() => setNotice(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert
          severity={notice?.severity ?? "info"}
          variant="filled"
          onClose={() => setNotice(null)}
          action={
            notice?.undo && (
              <Button color="inherit" size="small" onClick={() => undoDelete(notice.undo ?? [])}>
                {t("browse.undo")}
              </Button>
            )
          }
        >
          {notice?.text}
        </Alert>
      </Snackbar>
      <CreateBucketDialog
        clusterId={clusterId}
        uid={session?.uid ?? ""}
        open={creating === "bucket"}
        onClose={() => setCreating(null)}
        onCreated={onBucketCreated}
      />
      <CreateFolderDialog
        clusterId={clusterId}
        uid={session?.uid ?? ""}
        bucket={bucket}
        prefix={prefix}
        open={creating === "folder"}
        onClose={() => setCreating(null)}
        onCreated={() => load(bucket, prefix, null)}
      />
      <Dialog open={aclOf !== null} onClose={() => setAclOf(null)} maxWidth="md" fullWidth aria-labelledby="bucket-acl-title">
        <DialogTitle id="bucket-acl-title">{aclOf ? t("browse.aclOfFolder", { folder: aclOf }) : t("browse.aclOfBucket", { bucket })}</DialogTitle>
        <DialogContent>
          {aclOf !== null && <AclEditor key={aclOf} at={{ clusterId, uid: session?.uid ?? "", bucket, key: aclOf }} recursive />}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAclOf(null)}>{t("common.close")}</Button>
        </DialogActions>
      </Dialog>
      <ObjectDrawer
        clusterId={clusterId}
        uid={session?.uid ?? ""}
        bucket={bucket}
        object={selected}
        versioning={versioning}
        startTab={startTab}
        startTransfer={startTransfer}
        onChanged={() => load(bucket, prefix, null)}
        onDeleted={(key, marker) => {
          setNotice(deletedNotice(1, marker ? [{ key, version: marker }] : undefined));
          load(bucket, prefix, null);
        }}
        onClose={() => setSelected(null)}
      />
    </CallerContext.Provider>
  );
}
