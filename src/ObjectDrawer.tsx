import { type ComponentType, useEffect, useState } from "react";
import { Alert, Box, Button, Divider, Drawer, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { AclTab } from "./AclEditor";
import { invoke, keyOwner, type ObjectEntry } from "./api";
import { formatBytes, TZ, vnTime } from "./format";
import { HeadersTab, TagsTab, type Inspected } from "./InspectTabs";
import PreviewTab from "./preview/Preview";
import { MAX_PRESIGN_SECS, presignSeconds, type PresignUnit } from "./presign";
import type { StartTransfer } from "./transfers";
import { ConfirmDialog, CopyButton, ErrorAlert, useAction } from "./ui";
import VersionsTab from "./VersionsTab";

/** What the backend needs to find the object and to know whose key to sign with. */
export type ObjectAt = { clusterId: string; uid: string; bucket: string; key: string; version?: string | null };
/** Versioning state of the open bucket; `supported` false hides everything about versions. */
export type Versioning = { supported: boolean; status: string; reason: string | null };
/** Only with versioning on does a delete leave something to restore. */
export const canUndelete = (v: Versioning) => v.supported && v.status === "Enabled";
/** Why a delete in this bucket is final; shown in red before the delete is confirmed. */
export const finalDeleteWarning = (v: Versioning) =>
  `${
    !v.supported
      ? "Không đọc được trạng thái versioning của bucket"
      : v.status === "Suspended"
        ? "Versioning của bucket đang tạm dừng"
        : "Bucket chưa bật versioning"
  }: object bị xoá là mất vĩnh viễn, KHÔNG THỂ HOÀN TÁC.`;
export const UNDELETE_HINT = "Bucket đang bật versioning: object chỉ bị đánh dấu xoá, khôi phục được từ tab Phiên bản.";
export type ObjectTabProps = {
  at: ObjectAt;
  object: ObjectEntry;
  versioning: Versioning;
  startTransfer: StartTransfer;
  /** The object was changed or removed: the listing should reload. */
  onChanged: () => void;
  /** The object was deleted; `marker` is the delete marker to remove for an undo (versioning on), else null. */
  onDeleted: (key: string, marker: string | null) => void;
  onClose: () => void;
};

const fileName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

/** Asks where to save, then downloads there with progress (resuming an interrupted attempt). */
export async function download(at: ObjectAt, startTransfer: StartTransfer) {
  const suggested = at.version ? `${at.version.slice(0, 8)}-${fileName(at.key)}` : fileName(at.key);
  const dest = await invoke<string | null>("browse_pick_save", { name: suggested });
  if (!dest) return;
  await startTransfer(
    `↓ ${at.bucket}/${at.key}`,
    (transferId) => invoke<{ path: string; resumed_from: number }>("browse_download", { at, dest, transferId }),
    (r) => `Đã lưu vào ${r.path}${r.resumed_from > 0 ? ` (tải tiếp từ ${formatBytes(r.resumed_from)} đã có)` : ""}`,
  );
}

const row = (label: string, value: string) => (
  <Stack direction="row" spacing={2}>
    <Typography variant="body2" color="text.secondary" sx={{ width: 140, flexShrink: 0 }}>
      {label}
    </Typography>
    <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
      {value}
    </Typography>
  </Stack>
);

function DetailsTab({ at, object, startTransfer, versioning, onDeleted, onClose }: ObjectTabProps) {
  const [amount, setAmount] = useState("15");
  const [unit, setUnit] = useState<PresignUnit>("m");
  const [url, setUrl] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [contentType, setContentType] = useState("…");
  const { busy, error, run, setError } = useAction();
  useEffect(() => {
    // The listing does not carry the content type; a HEAD does.
    invoke<Inspected>("browse_inspect", { at }).then(
      (i) => setContentType(i.head.content_type || "(không có)"),
      () => setContentType("(không đọc được)"),
    );
  }, []);

  const seconds = presignSeconds(amount, unit);
  async function presign() {
    setUrl("");
    const made = await run(() => invoke<string>("browse_presign", { at, expiresSecs: seconds }));
    if (made) setUrl(made);
  }
  async function remove() {
    const deleted = await run(() => invoke<string | null>("browse_delete", { at }).then((marker) => ({ marker })));
    if (deleted) {
      onDeleted(at.key, deleted.marker);
      onClose();
    }
  }

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        {row("Key", object.key)}
        {row("Kích thước", `${formatBytes(object.size)} (${object.size} byte)`)}
        {row(`Sửa lần cuối (${TZ})`, vnTime(object.last_modified, true))}
        {row("ETag", object.etag)}
        {row("Content-Type", contentType)}
        {object.storage_class && row("Storage class", object.storage_class)}
        {object.owner && row("Chủ sở hữu", object.owner)}
        <Box>
          <Button variant="contained" onClick={() => download(at, startTransfer)}>
            Tải xuống
          </Button>
        </Box>
      </Stack>
      <Divider />

      <Stack spacing={1}>
        <Typography variant="subtitle1" component="h3">
          Presigned URL
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Ai có URL này đều tải được object cho đến khi hết hạn, không cần key. URL ký bằng key của {keyOwner(at.uid)}.
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
          <TextField
            label="Hết hạn sau"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            size="small"
            sx={{ width: 140 }}
            error={seconds === null}
            helperText={seconds === null ? "Từ 1 giây đến 7 ngày" : `${seconds} giây`}
            slotProps={{ htmlInput: { inputMode: "numeric" } }}
          />
          <TextField
            select
            label="Đơn vị"
            value={unit}
            onChange={(e) => setUnit(e.target.value as PresignUnit)}
            size="small"
            sx={{ width: 120 }}
            slotProps={{ select: { native: true } }}
          >
            <option value="s">giây</option>
            <option value="m">phút</option>
            <option value="h">giờ</option>
          </TextField>
          <Button variant="outlined" onClick={presign} disabled={busy || seconds === null || seconds > MAX_PRESIGN_SECS}>
            Tạo URL
          </Button>
        </Stack>
        {url && (
          <Stack direction="row" spacing={1}>
            <TextField
              label="Presigned URL"
              value={url}
              size="small"
              fullWidth
              slotProps={{ input: { readOnly: true, sx: { fontFamily: "monospace", fontSize: 12 } } }}
            />
            <CopyButton value={url} label="Copy presigned URL" />
          </Stack>
        )}
      </Stack>
      <Divider />

      <Box>
        <Button color="error" variant="outlined" onClick={() => setConfirming(true)}>
          Xoá object
        </Button>
      </Box>
      {!confirming && <ErrorAlert error={error} />}
      <ConfirmDialog
        open={confirming}
        title="Xoá object?"
        text={`Xoá ${at.bucket}/${at.key}.`}
        confirmLabel="Xoá object"
        busy={busy}
        error={error}
        onConfirm={remove}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        {canUndelete(versioning) ? <Alert severity="info">{UNDELETE_HINT}</Alert> : <Alert severity="error">{finalDeleteWarning(versioning)}</Alert>}
      </ConfirmDialog>
    </Stack>
  );
}

const allTabs: { label: string; Panel: ComponentType<ObjectTabProps> }[] = [
  { label: "Xem trước", Panel: PreviewTab },
  { label: "Thuộc tính", Panel: DetailsTab },
  { label: "Header", Panel: HeadersTab },
  { label: "Tag", Panel: TagsTab },
  { label: "Phiên bản", Panel: VersionsTab },
  { label: "ACL", Panel: AclTab },
];

type Props = Omit<ObjectTabProps, "at" | "object"> & {
  clusterId: string;
  uid: string;
  bucket: string;
  object: ObjectEntry | null;
  /** Label of the tab to open on (the context menu's "ACL" and "Phiên bản"); the first tab otherwise. */
  startTab?: string;
};

/** The detail sheet of one object: it slides in from the right, with its sections as vertical tabs. */
export default function ObjectDrawer({ clusterId, uid, bucket, object, startTab, ...rest }: Props) {
  const [tab, setTab] = useState(0);
  // A deleted key has nothing but its versions; without versioning there is no such tab.
  const tabs = allTabs.filter((t) => (object?.deleted ? t.Panel === VersionsTab : rest.versioning.supported || t.Panel !== VersionsTab));
  useEffect(() => setTab(Math.max(0, tabs.findIndex((t) => t.label === startTab))), [object?.key, startTab]);
  const Panel = (tabs[tab] ?? tabs[0]).Panel;
  return (
    <Drawer
      anchor="right"
      open={object !== null}
      onClose={rest.onClose}
      slotProps={{
        paper: {
          sx: { width: 920, maxWidth: "100vw", my: 2, height: "calc(100% - 32px)", border: 1, borderRight: 0, borderColor: "divider", borderRadius: "16px 0 0 16px" },
        },
      }}
    >
      {object && (
        <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Box sx={{ position: "relative", px: 3.5, pt: 2.5, pb: 2, borderBottom: 1, borderColor: "divider" }}>
            <Typography variant="overline" color="primary" component="p">
              Object · {bucket}
            </Typography>
            <Typography variant="h4" component="h2" sx={{ pr: 10, fontSize: 28, wordBreak: "break-all" }}>
              {fileName(object.key)}
            </Typography>
            <Button onClick={rest.onClose} sx={{ position: "absolute", top: 18, right: 18 }}>
              Đóng
            </Button>
          </Box>
          <Box sx={{ display: "flex", flexGrow: 1, minHeight: 0 }}>
            <Tabs
              orientation="vertical"
              value={tab}
              onChange={(_, value) => setTab(value)}
              aria-label="Chi tiết object"
              textColor="inherit"
              sx={{ flexShrink: 0, width: 148, pt: 1, borderRight: 1, borderColor: "divider", "& .MuiTab-root": { alignItems: "flex-start", pl: 3.5 } }}
            >
              {tabs.map((t, i) => (
                <Tab key={t.label} value={i} label={t.label} />
              ))}
            </Tabs>
            <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "auto", p: 3 }}>
              <Panel key={object.key + tab} at={{ clusterId, uid, bucket, key: object.key }} object={object} {...rest} />
            </Box>
          </Box>
        </Box>
      )}
    </Drawer>
  );
}
