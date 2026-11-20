import { type ComponentType, useEffect, useState } from "react";
import { Alert, Box, Button, Divider, Drawer, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { AclTab } from "./AclEditor";
import { invoke, type ObjectEntry } from "./api";
import { formatBytes, TZ, vnTime } from "./format";
import { t, type Key } from "./i18n";
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
  t(!v.supported ? "object.finalUnknown" : v.status === "Suspended" ? "object.finalSuspended" : "object.finalOff");
/** Shown instead of the warning when the delete can be undone. */
export const undeleteHint = () => t("object.undeleteHint");
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
  const dest = await invoke<string | null>("browse_pick_save", { name: suggested, title: t("object.saveTitle") });
  if (!dest) return;
  await startTransfer(
    `↓ ${at.bucket}/${at.key}`,
    (transferId) => invoke<{ path: string; resumed_from: number }>("browse_download", { at, dest, transferId }),
    (r) => (r.resumed_from > 0 ? t("object.savedResumed", { path: r.path, from: formatBytes(r.resumed_from) }) : t("object.saved", { path: r.path })),
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
  // undefined while the HEAD is under way, null when it failed, "" when the object has none.
  const [contentType, setContentType] = useState<string | null>();
  const { busy, error, run, setError } = useAction();
  useEffect(() => {
    // The listing does not carry the content type; a HEAD does.
    invoke<Inspected>("browse_inspect", { at }).then(
      (i) => setContentType(i.head.content_type),
      () => setContentType(null),
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
        {row(t("object.key"), object.key)}
        {row(t("object.size"), t("object.sizeValue", { size: formatBytes(object.size), bytes: object.size }))}
        {row(t("object.modified", { tz: TZ }), vnTime(object.last_modified, true))}
        {row(t("object.etag"), object.etag)}
        {row(t("object.contentType"), contentType === undefined ? "…" : contentType === null ? t("object.contentTypeUnreadable") : contentType || t("object.contentTypeNone"))}
        {object.storage_class && row(t("object.storageClass"), object.storage_class)}
        {object.owner && row(t("object.owner"), object.owner)}
        <Box>
          <Button variant="contained" onClick={() => download(at, startTransfer)}>
            {t("common.download")}
          </Button>
        </Box>
      </Stack>
      <Divider />

      <Stack spacing={1}>
        <Typography variant="subtitle1" component="h3">
          {t("object.presignedUrl")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {at.uid ? t("object.presignHintUser", { uid: at.uid }) : t("object.presignHintMine")}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
          <TextField
            label={t("object.expiresIn")}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            size="small"
            sx={{ width: 140 }}
            error={seconds === null}
            helperText={seconds === null ? t("object.expiryRange") : t("object.seconds", { n: seconds })}
            slotProps={{ htmlInput: { inputMode: "numeric" } }}
          />
          <TextField
            select
            label={t("object.unit")}
            value={unit}
            onChange={(e) => setUnit(e.target.value as PresignUnit)}
            size="small"
            sx={{ width: 120 }}
            slotProps={{ select: { native: true } }}
          >
            <option value="s">{t("object.unitS")}</option>
            <option value="m">{t("object.unitM")}</option>
            <option value="h">{t("object.unitH")}</option>
          </TextField>
          <Button variant="outlined" onClick={presign} disabled={busy || seconds === null || seconds > MAX_PRESIGN_SECS}>
            {t("object.createUrl")}
          </Button>
        </Stack>
        {url && (
          <Stack direction="row" spacing={1}>
            <TextField
              label={t("object.presignedUrl")}
              value={url}
              size="small"
              fullWidth
              slotProps={{ input: { readOnly: true, sx: { fontFamily: "monospace", fontSize: 13 } } }}
            />
            <CopyButton value={url} label={t("object.copyUrl")} />
          </Stack>
        )}
      </Stack>
      <Divider />

      <Box>
        <Button color="error" variant="outlined" onClick={() => setConfirming(true)}>
          {t("object.delete")}
        </Button>
      </Box>
      {!confirming && <ErrorAlert error={error} />}
      <ConfirmDialog
        open={confirming}
        title={t("object.deleteTitle")}
        text={t("object.deleteText", { path: `${at.bucket}/${at.key}` })}
        confirmLabel={t("object.delete")}
        busy={busy}
        error={error}
        onConfirm={remove}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        {canUndelete(versioning) ? <Alert severity="info">{undeleteHint()}</Alert> : <Alert severity="error">{finalDeleteWarning(versioning)}</Alert>}
      </ConfirmDialog>
    </Stack>
  );
}

const allTabs: { id: string; label: Key; Panel: ComponentType<ObjectTabProps> }[] = [
  { id: "preview", label: "object.tab.preview", Panel: PreviewTab },
  { id: "details", label: "object.tab.details", Panel: DetailsTab },
  { id: "headers", label: "object.tab.headers", Panel: HeadersTab },
  { id: "tags", label: "object.tab.tags", Panel: TagsTab },
  { id: "versions", label: "object.tab.versions", Panel: VersionsTab },
  { id: "acl", label: "object.tab.acl", Panel: AclTab },
];

type Props = Omit<ObjectTabProps, "at" | "object"> & {
  clusterId: string;
  uid: string;
  bucket: string;
  object: ObjectEntry | null;
  /** Id of the tab to open on (the context menu asks for "acl" and "versions"; the tab's label on screen works too); the first tab otherwise. */
  startTab?: string;
};

/** The detail sheet of one object: it slides in from the right, with its sections as vertical tabs. */
export default function ObjectDrawer({ clusterId, uid, bucket, object, startTab, ...rest }: Props) {
  const [tab, setTab] = useState(0);
  // A deleted key has nothing but its versions; without versioning there is no such tab.
  const tabs = allTabs.filter((entry) => (object?.deleted ? entry.Panel === VersionsTab : rest.versioning.supported || entry.Panel !== VersionsTab));
  useEffect(() => setTab(Math.max(0, tabs.findIndex((entry) => entry.id === startTab))), [object?.key, startTab]);
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
          <Box sx={{ position: "relative", px: 4, pt: 3, pb: 2.5, borderBottom: 1, borderColor: "divider" }}>
            <Typography variant="overline" color="primary" component="p">
              {t("object.eyebrow", { bucket })}
            </Typography>
            <Typography variant="h4" component="h2" sx={{ pr: 10, fontSize: 29, wordBreak: "break-all" }}>
              {fileName(object.key)}
            </Typography>
            <Button onClick={rest.onClose} sx={{ position: "absolute", top: 22, right: 22 }}>
              {t("common.close")}
            </Button>
          </Box>
          <Box sx={{ display: "flex", flexGrow: 1, minHeight: 0 }}>
            <Tabs
              orientation="vertical"
              value={tab}
              onChange={(_, value) => setTab(value)}
              aria-label={t("object.tabsLabel")}
              textColor="inherit"
              sx={{ flexShrink: 0, width: 156, pt: 1, borderRight: 1, borderColor: "divider", "& .MuiTab-root": { alignItems: "flex-start", pl: 4 } }}
            >
              {tabs.map((entry, i) => (
                <Tab key={entry.id} value={i} label={t(entry.label)} />
              ))}
            </Tabs>
            <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "auto", p: 3.5 }}>
              <Panel key={object.key + tab} at={{ clusterId, uid, bucket, key: object.key }} object={object} {...rest} />
            </Box>
          </Box>
        </Box>
      )}
    </Drawer>
  );
}
