import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  LinearProgress,
  Link,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { invoke, maskKey, type BrowseBucket, type Listing, type ObjectEntry, type Profile } from "./api";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { formatBytes, shortTime } from "./format";
import ObjectDrawer from "./ObjectDrawer";
import { TransferList, useTransfers } from "./transfers";
import { ClusterSelect, ErrorAlert, useAction } from "./ui";
import { VirtualTable, type Column } from "./virtual";

type Props = {
  profiles: Profile[];
  clusterId: string;
  onClusterChange: (id: string) => void;
  /** uid to browse as, when the page was opened from a user's drawer. */
  uid: string;
  onUid: (uid: string) => void;
};
type Session = { uid: string; access_key: string; buckets: BrowseBucket[] };
type Row = { folder: string } | { object: ObjectEntry };

/** "a/b/c.txt" under prefix "a/b/" is shown as "c.txt". */
const baseName = (key: string, prefix: string) => key.slice(prefix.length);

export default function Browse({ profiles, clusterId, onClusterChange, uid, onUid }: Props) {
  const [uidInput, setUidInput] = useState(uid);
  const [session, setSession] = useState<Session | null>(null);
  const [bucket, setBucket] = useState("");
  const [bucketInput, setBucketInput] = useState("");
  const [prefix, setPrefix] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const { busy, error, run, setError } = useAction();
  const request = useRef(0);
  const [selected, setSelected] = useState<ObjectEntry | null>(null);
  const transfers = useTransfers();
  // Where a dropped file goes: read by the drop listener, which outlives renders.
  const here = useRef({ uid: "", bucket: "", prefix: "" });
  here.current = { uid: session?.uid ?? "", bucket, prefix };

  async function upload(paths: string[]) {
    const { uid: asUid, bucket: toBucket, prefix: toPrefix } = here.current;
    if (!asUid || !toBucket) return;
    for (const path of paths) {
      const key = toPrefix + path.slice(path.lastIndexOf("/") + 1);
      const at = { clusterId, uid: asUid, bucket: toBucket, key };
      await transfers.start(`↑ ${toBucket}/${key}`, (transferId) => invoke<number>("browse_upload", { at, path, transferId }));
    }
    const now = here.current;
    if (now.bucket === toBucket && now.prefix === toPrefix) load(toBucket, toPrefix, null);
  }
  useEffect(() => {
    // The webview reports dropped files with their paths (not their content).
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") upload(e.payload.paths);
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [clusterId]);

  // Every S3 call is signed with this user's own key, looked up by the backend; the UI never sees a secret.
  async function open(target: string) {
    setSession(null);
    setBucket("");
    setListing(null);
    if (!clusterId || !target) return;
    const opened = await run(() => invoke<Omit<Session, "uid">>("browse_open", { clusterId, uid: target }));
    if (opened) {
      setSession({ uid: target, ...opened });
      onUid(target);
    }
  }
  useEffect(() => {
    setUidInput(uid);
    open(uid);
  }, [clusterId, uid]);

  async function load(toBucket: string, toPrefix: string, token: string | null) {
    if (!session) return;
    const mine = ++request.current;
    if (token === null) {
      setBucket(toBucket);
      setPrefix(toPrefix);
      setListing(null);
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

  const rows: Row[] = listing
    ? [...listing.prefixes.map((folder) => ({ folder })), ...listing.objects.map((object) => ({ object }))]
    : [];
  const columns: Column<Row>[] = [
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
          </Link>
        ),
    },
    { header: "Size", width: "100px", align: "right", cell: (r) => ("object" in r ? formatBytes(r.object.size) : "—") },
    { header: "Sửa lần cuối (UTC)", width: "150px", cell: (r) => ("object" in r ? shortTime(r.object.last_modified) : "") },
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
    return <Alert severity="info">Chưa có cluster nào. Hãy thêm cluster ở tab Clusters trước.</Alert>;
  }
  return (
    <>
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
        <TextField label="Browse với user (uid)" value={uidInput} onChange={(e) => setUidInput(e.target.value)} size="small" />
        <Button type="submit" variant="contained" disabled={busy || !uidInput.trim()}>
          Mở
        </Button>
        {session && (
          <Typography variant="body2" color="text.secondary">
            Đang dùng key {maskKey(session.access_key)} của chính user {session.uid}. Admin secret không được dùng để browse.
          </Typography>
        )}
      </Stack>
      {busy && <LinearProgress aria-label="Đang tải" />}
      <ErrorAlert error={error} sx={{ mb: 2 }} />
      <TransferList items={transfers.items} onClear={transfers.clear} />
      {!session && !busy && !error && (
        <Alert severity="info">
          Nhập uid của user cần browse rồi bấm Mở, hoặc bấm "Browse" trong chi tiết user ở tab Users. Bạn chỉ thấy và làm
          được đúng những gì key của user đó được phép.
        </Alert>
      )}

      {session && (
        <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
          <Paper variant="outlined" sx={{ width: 260, flexShrink: 0 }}>
            <Typography variant="subtitle2" component="h2" sx={{ px: 2, pt: 1.5 }}>
              Bucket của {session.uid}
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
                <VirtualTable
                  columns={columns}
                  rows={rows}
                  height={420}
                  label="Danh sách object"
                  empty={<Typography color="text.secondary">{listing ? "Thư mục trống." : ""}</Typography>}
                />
                <Typography variant="body2" color="text.secondary">
                  Kéo thả file vào cửa sổ để upload vào thư mục đang mở. File lớn hơn 8 MiB được upload theo từng phần.
                </Typography>
                {listing && (
                  <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                    <Typography variant="body2" color="text.secondary">
                      {listing.prefixes.length} thư mục, {listing.objects.length} object đã tải
                      {listing.next_token ? " — còn nữa." : "."}
                    </Typography>
                    {listing.next_token && (
                      <Button size="small" variant="outlined" disabled={busy} onClick={() => load(bucket, prefix, listing.next_token)}>
                        Tải thêm
                      </Button>
                    )}
                  </Stack>
                )}
              </Stack>
            )}
          </Box>
        </Stack>
      )}
      <ObjectDrawer
        clusterId={clusterId}
        uid={session?.uid ?? ""}
        bucket={bucket}
        object={selected}
        startTransfer={transfers.start}
        onChanged={() => load(bucket, prefix, null)}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
