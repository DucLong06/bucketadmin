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
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { invoke, keyOwner, maskKey, type BrowseBucket, type Listing, type Marker, type ObjectEntry, type Profile } from "./api";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { formatBytes, TZ, vnTime } from "./format";
import AclEditor from "./AclEditor";
import { CreateBucketDialog, CreateFolderDialog } from "./BrowseDialogs";
import { accessLevel, type Access } from "./caps";
import MyInfo from "./MyInfo";
import ObjectDrawer, { canUndelete, finalDeleteWarning, UNDELETE_HINT, type Versioning } from "./ObjectDrawer";
import { TaskPanel, useTransfers } from "./transfers";
import { explain } from "./errors";
import { CallerContext, ClusterSelect, ConfirmDialog, copyText, ErrorAlert, useAction } from "./ui";
import { VirtualTable, type Column } from "./virtual";

type Props = {
  profiles: Profile[];
  clusterId: string;
  onClusterChange: (id: string) => void;
};
/** `uid` is empty while browsing with the caller's own saved key. */
type Session = { uid: string; access_key: string; buckets: BrowseBucket[] };
type Row = { folder: string } | { object: ObjectEntry };
type DeleteReport = { objects: number; deleted: number; failed: { key: string; error: string }[]; markers: Marker[] };
/** `undo`: delete markers a "Hoàn tác" button in the toast removes again. */
type Notice = { severity: "success" | "error" | "info"; text: string; undo?: Marker[] };
type Deleted = { prefixes: string[]; objects: ObjectEntry[]; truncated: boolean };
const VERSIONING_LABEL: Record<string, string> = { Enabled: "Bật", Suspended: "Tạm dừng", "": "Chưa bật" };
type Found = { matches: ObjectEntry[]; scanned: number; stopped: "done" | "results" | "time" };
// Limits of one search; the backend enforces its own caps on top.
const SEARCH_RESULTS = 500;
const SEARCH_SECONDS = 20;
const STOPPED: Record<Found["stopped"], string> = {
  done: "đã quét hết",
  results: `dừng vì đủ ${SEARCH_RESULTS} kết quả`,
  time: `dừng vì hết ${SEARCH_SECONDS} giây`,
};
// Expiry of a URL made by the Copy URL button (the Properties tab offers other expiries).
const COPY_URL_SECS = 900;
const NO_VERSIONING: Versioning = { supported: false, status: "", reason: null };

/** "a/b/c.txt" under prefix "a/b/" is shown as "c.txt". */
const baseName = (key: string, prefix: string) => key.slice(prefix.length);

export default function Browse({ profiles, clusterId, onClusterChange }: Props) {
  // What this connection's key may read on the Admin API, asked once per connection. It only
  // decides two extras: the "Thông tin của tôi" box, and browsing with another user's key.
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
  // Deleted but restorable keys of the open folder, while "Hiện object đã xoá" is on.
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

  // A presigned GET URL of the one ticked object, straight to the clipboard.
  async function copyUrl() {
    if (!session) return;
    const key = pickedOf("o")[0];
    const at = { clusterId, uid: session.uid, bucket, key };
    const url = await run(() => invoke<string>("browse_presign", { at, expiresSecs: COPY_URL_SECS }));
    if (!url) return;
    await copyText(url);
    setNotice({ severity: "success", text: `Đã copy presigned URL của ${key}. URL hết hạn sau ${COPY_URL_SECS / 60} phút; ai có URL đều tải được object.` });
  }

  // First a dry run: the confirmation states how many objects the selection really stands for.
  async function planDelete() {
    if (!session) return;
    const [keys, prefixes] = [pickedOf("o"), pickedOf("f")];
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
            text: `Đã xoá ${report.deleted}/${report.objects} object; ${report.failed.length} object không xoá được. Lỗi đầu tiên (${first.key}): ${explain(first.error).message}`,
            undo,
          }
        : deletedNotice(report.deleted, undo),
    );
    load(bucket, prefix, null);
  }
  const deletedNotice = (count: number, undo?: Marker[]): Notice =>
    undo
      ? { severity: "success", text: `Đã đánh dấu xoá ${count} object — khôi phục được từ tab Phiên bản.`, undo }
      : { severity: "success", text: `Đã xoá ${count} object.` };
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
        ? { severity: "error", text: `Khôi phục được ${report.deleted}/${report.objects} object. Lỗi đầu tiên (${first.key}): ${explain(first.error).message}` }
        : { severity: "success", text: `Đã khôi phục ${report.deleted} object.` },
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
  const transfers = useTransfers();
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
        return transfers.start(`↑ ${toBucket}/${key}`, (transferId) => invoke<number>("browse_upload", { at, path, transferId }));
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
      if (e.payload.type === "drop") uploadNow.current(e.payload.paths);
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
    if (opened) setSession({ uid: target, ...opened });
  }
  useEffect(() => {
    setUidInput("");
    open("");
  }, [clusterId]);

  async function load(toBucket: string, toPrefix: string, token: string | null) {
    if (!session) return;
    const mine = ++request.current;
    if (token === null) {
      if (toBucket !== bucket) {
        // Asked once per bucket; a key that may not ask simply gets no Versions tab.
        setVersioning(NO_VERSIONING);
        setShowDeleted(false);
        const at = { clusterId, uid: session.uid, bucket: toBucket };
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
      invoke<Listing>("browse_list", { clusterId, uid: session.uid, bucket: toBucket, prefix: toPrefix, token }),
    );
    // A slower answer for a folder the user already left must not overwrite the table.
    if (!page || mine !== request.current) return;
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
  // With "Hiện object đã xoá": deleted keys, and folders that hold nothing but deleted keys.
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
          slotProps={{ input: { "aria-label": "Chọn tất cả các dòng đang hiện" } }}
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
            slotProps={{ input: { "aria-label": `Chọn ${nameOf(r)}` } }}
          />
        ),
    },
    {
      header: "Tên",
      width: "minmax(240px, 4fr)",
      cell: (r) =>
        "folder" in r ? (
          <Link component="button" onClick={() => load(bucket, r.folder, null)} aria-label={`Mở thư mục ${r.folder}`}>
            {baseName(r.folder, prefix)}
          </Link>
        ) : (
          <Link
            component="button"
            color="inherit"
            underline="hover"
            sx={{ fontFamily: "monospace" }}
            onClick={() => setSelected(r.object)}
            aria-label={`Mở object ${r.object.key}`}
          >
            {baseName(r.object.key, prefix)}
            {r.object.deleted && <Chip size="small" color="warning" variant="outlined" label="Đã xoá" sx={{ ml: 1 }} />}
          </Link>
        ),
    },
    { header: "Size", width: "100px", align: "right", cell: (r) => ("object" in r && !r.object.deleted ? formatBytes(r.object.size) : "—") },
    { header: `Sửa lần cuối (${TZ})`, width: "160px", cell: (r) => ("object" in r ? vnTime(r.object.last_modified) : "") },
    { header: "Storage class", width: "110px", cell: (r) => ("object" in r ? r.object.storage_class : "") },
    { header: "Owner", width: "minmax(100px, 1fr)", cell: (r) => ("object" in r ? r.object.owner : "") },
  ];

  // Breadcrumb: bucket, then one link per folder level of the prefix.
  const parts = prefix.split("/").filter(Boolean);
  const crumbs = parts.map((name, i) => ({ name, prefix: `${parts.slice(0, i + 1).join("/")}/` }));

  function openByName(e: FormEvent) {
    e.preventDefault();
    if (bucketInput.trim()) load(bucketInput.trim(), "", null);
  }

  if (profiles.length === 0) {
    return <Alert severity="info">Chưa có kết nối nào. Hãy thêm một kết nối ở mục Kết nối trước.</Alert>;
  }
  return (
    <CallerContext.Provider value={access?.uid ?? ""}>
      <Typography variant="h5" component="h1" gutterBottom>
        Browse
      </Typography>
      <Stack
        component="form"
        direction="row"
        spacing={2}
        sx={{ mb: 2, alignItems: "center" }}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setError(null);
          open(uidInput.trim());
        }}
      >
        <ClusterSelect profiles={profiles} value={clusterId} onChange={onClusterChange} />
        {canBrowseAs && (
          <>
            <TextField label="Duyệt thay user (uid)" value={uidInput} onChange={(e) => setUidInput(e.target.value)} size="small" />
            <Button type="submit" variant="outlined" disabled={busy || !uidInput.trim()}>
              Mở
            </Button>
            {session?.uid && (
              <Button
                disabled={busy}
                onClick={() => {
                  setUidInput("");
                  open("");
                }}
              >
                Về key của tôi
              </Button>
            )}
          </>
        )}
      </Stack>
      {session && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {session.uid
            ? `Đang dùng key ${maskKey(session.access_key)} của chính user ${session.uid}.`
            : `Đang dùng key ${maskKey(session.access_key)} của bạn (secret nằm trong keychain).`}
        </Typography>
      )}
      {access && (access.users || access.usage) && (
        // Keyed by cluster: another cluster's answer never shows under this one's name.
        <MyInfo key={clusterId} clusterId={clusterId} access={access} defaultOpen={accessLevel(access) === "self"} />
      )}
      {busy && <LinearProgress aria-label="Đang tải" />}
      {plan === null && switching === null && <ErrorAlert error={error} sx={{ mb: 2 }} />}
      <TaskPanel tasks={transfers} />

      {session && (
        <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
          <Paper variant="outlined" sx={{ width: 260, flexShrink: 0 }}>
            <Typography variant="subtitle2" component="h2" sx={{ px: 2, pt: 1.5 }}>
              Bucket của {keyOwner(session.uid)}
            </Typography>
            <List dense aria-label="Danh sách bucket">
              {session.buckets.map((b) => (
                <ListItemButton key={b.name} selected={b.name === bucket} onClick={() => load(b.name, "", null)}>
                  <ListItemText primary={b.name} slotProps={{ primary: { sx: { fontFamily: "monospace", fontSize: 14 } } }} />
                </ListItemButton>
              ))}
            </List>
            {session.buckets.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1 }}>
                User không sở hữu bucket nào.
              </Typography>
            )}
            <Box sx={{ px: 2, pb: 1.5 }}>
              <Button size="small" variant="outlined" fullWidth onClick={() => setCreating("bucket")}>
                Tạo bucket
              </Button>
            </Box>
            <Stack component="form" onSubmit={openByName} spacing={1} sx={{ p: 2, borderTop: 1, borderColor: "divider" }}>
              <TextField
                label="Mở bucket theo tên"
                value={bucketInput}
                onChange={(e) => setBucketInput(e.target.value)}
                size="small"
                helperText="Cho bucket được chia sẻ, S3 không liệt kê"
              />
              <Button type="submit" size="small" variant="outlined" disabled={!bucketInput.trim()}>
                Mở bucket
              </Button>
            </Stack>
          </Paper>

          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            {!bucket && <Typography color="text.secondary">Chọn một bucket để xem nội dung.</Typography>}
            {bucket && (
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Breadcrumbs aria-label="Đường dẫn" sx={{ flexGrow: 1 }}>
                    <Link component="button" onClick={() => load(bucket, "", null)} sx={{ fontFamily: "monospace" }}>
                      {bucket}
                    </Link>
                    {crumbs.map((c) => (
                      <Link key={c.prefix} component="button" onClick={() => load(bucket, c.prefix, null)} sx={{ fontFamily: "monospace" }}>
                        {c.name}
                      </Link>
                    ))}
                  </Breadcrumbs>
                  {versioning.supported && (
                    <>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={versioning.status === "Enabled" ? "success" : versioning.status === "Suspended" ? "warning" : "default"}
                        label={`Versioning: ${VERSIONING_LABEL[versioning.status] ?? versioning.status}`}
                      />
                      <Button size="small" disabled={busy} onClick={() => setSwitching(versioning.status !== "Enabled")}>
                        {versioning.status === "Enabled" ? "Tắt versioning" : "Bật versioning"}
                      </Button>
                    </>
                  )}
                  <Button size="small" onClick={() => setAclOf("")}>
                    ACL của bucket
                  </Button>
                  {prefix && (
                    <Button size="small" onClick={() => setAclOf(prefix)} title="Đặt một ACL cho mọi object trong thư mục đang mở">
                      ACL thư mục
                    </Button>
                  )}
                  <Button
                    size="small"
                    disabled={busy || picked.size !== 1 || pickedOf("o").length !== 1}
                    onClick={copyUrl}
                    title="Chọn đúng một object để copy presigned URL của nó"
                  >
                    Copy URL
                  </Button>
                  <Button size="small" color="error" disabled={busy || picked.size === 0} onClick={planDelete}>
                    Xoá ({picked.size})
                  </Button>
                  <Button size="small" onClick={() => setCreating("folder")}>
                    Tạo thư mục
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={async () => upload(await invoke<string[]>("browse_pick_upload"))}
                  >
                    Upload
                  </Button>
                  <Button size="small" onClick={() => load(bucket, prefix, null)} disabled={busy}>
                    Làm mới
                  </Button>
                </Stack>
                <Stack component="form" onSubmit={search} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <TextField
                    label="Tìm trong thư mục này và các thư mục con"
                    placeholder="*.parquet"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    size="small"
                    sx={{ minWidth: 340 }}
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                  <Button type="submit" size="small" variant="outlined" disabled={busy || !pattern.trim()}>
                    Tìm
                  </Button>
                  <Typography variant="body2" color="text.secondary">
                    * = chuỗi bất kỳ, ? = một ký tự. Mẫu không có / so với tên file, có / so với đường dẫn; một từ thường thì tìm
                    trong cả đường dẫn. Tối đa {SEARCH_RESULTS} kết quả hoặc {SEARCH_SECONDS} giây.
                  </Typography>
                </Stack>
                {found && (
                  <Alert
                    severity={found.stopped === "done" ? "success" : "warning"}
                    action={
                      <Button color="inherit" size="small" onClick={() => setFound(null)}>
                        Đóng kết quả
                      </Button>
                    }
                  >
                    {found.matches.length} object khớp · đã quét {found.scanned} key · {STOPPED[found.stopped]}
                    {found.stopped === "done" ? "." : " — có thể còn object khớp chưa được quét tới."}
                  </Alert>
                )}
                <VirtualTable
                  columns={columns}
                  rows={rows}
                  height={420}
                  label="Danh sách object"
                  empty={<Typography color="text.secondary">{found ? "Không có object nào khớp." : listing ? "Thư mục trống." : ""}</Typography>}
                />
                <Typography variant="body2" color="text.secondary">
                  Kéo thả file vào cửa sổ để upload vào thư mục đang mở. File lớn hơn 8 MiB được upload theo từng phần.
                </Typography>
                {listing && !found && (
                  <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                    <Typography variant="body2" color="text.secondary">
                      {listing.prefixes.length} thư mục, {objects.length} object đã tải
                      {listing.next_token ? " — còn nữa." : "."}
                    </Typography>
                    {listing.next_token && (
                      <Button size="small" variant="outlined" disabled={busy} onClick={() => load(bucket, prefix, listing.next_token)}>
                        Tải thêm
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
                        {showDeleted ? "Ẩn object đã xoá" : "Hiện object đã xoá"}
                      </Button>
                    )}
                    {gone && (
                      <Typography variant="body2" color="text.secondary">
                        {gone.objects.length} object đã xoá còn khôi phục được{gone.truncated ? " (thư mục có quá nhiều version, danh sách chưa đủ)" : ""}.
                      </Typography>
                    )}
                  </Stack>
                )}
              </Stack>
            )}
          </Box>
        </Stack>
      )}
      <ConfirmDialog
        open={plan !== null}
        title="Xoá các mục đã chọn?"
        text={
          plan
            ? `Xoá ${plan.objects} object trong bucket ${bucket}: ${plan.keys.length} object được chọn${
                plan.prefixes.length ? ` và toàn bộ nội dung của ${plan.prefixes.length} thư mục (${plan.prefixes.join(", ")})` : ""
              }.`
            : ""
        }
        confirmLabel={`Xoá ${plan?.objects ?? 0} object`}
        busy={busy}
        error={error}
        onConfirm={deletePicked}
        onClose={() => {
          setPlan(null);
          setError(null);
        }}
      >
        {canUndelete(versioning) ? <Alert severity="info">{UNDELETE_HINT}</Alert> : <Alert severity="error">{finalDeleteWarning(versioning)}</Alert>}
      </ConfirmDialog>
      <ConfirmDialog
        open={switching !== null}
        title={switching ? "Bật versioning?" : "Tắt versioning?"}
        text={
          switching
            ? `Bật versioning cho bucket ${bucket}: từ giờ mỗi lần ghi đè hoặc xoá đều giữ lại version cũ, nên khôi phục được (và tốn thêm dung lượng).`
            : `Tạm dừng versioning của bucket ${bucket}: các version cũ vẫn được giữ, nhưng từ giờ ghi đè và xoá không còn khôi phục được. S3 không có trạng thái "tắt hẳn" sau khi đã bật.`
        }
        confirmLabel={switching ? "Bật versioning" : "Tắt versioning"}
        busy={busy}
        error={error}
        onConfirm={switchVersioning}
        onClose={() => {
          setSwitching(null);
          setError(null);
        }}
      />
      {/* An undo stays on screen longer: it is the quick way back. */}
      <Snackbar open={notice !== null} autoHideDuration={notice?.undo ? 20000 : 8000} onClose={() => setNotice(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert
          severity={notice?.severity ?? "info"}
          variant="filled"
          onClose={() => setNotice(null)}
          action={
            notice?.undo && (
              <Button color="inherit" size="small" onClick={() => undoDelete(notice.undo ?? [])}>
                Hoàn tác
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
        <DialogTitle id="bucket-acl-title">{aclOf ? `ACL cho object trong thư mục ${aclOf}` : `ACL của bucket ${bucket}`}</DialogTitle>
        <DialogContent>
          {aclOf !== null && <AclEditor key={aclOf} at={{ clusterId, uid: session?.uid ?? "", bucket, key: aclOf }} recursive />}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAclOf(null)}>Đóng</Button>
        </DialogActions>
      </Dialog>
      <ObjectDrawer
        clusterId={clusterId}
        uid={session?.uid ?? ""}
        bucket={bucket}
        object={selected}
        versioning={versioning}
        startTransfer={transfers.start}
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
