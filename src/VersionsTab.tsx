import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, LinearProgress, Paper, Stack, Typography } from "@mui/material";
import { invoke } from "./api";
import { formatBytes, TZ, vnTime } from "./format";
import { t, type Key } from "./i18n";
import { download, type ObjectTabProps } from "./ObjectDrawer";
import { ConfirmDialog, ErrorAlert, useAction } from "./ui";

type Version = {
  version_id: string;
  is_latest: boolean;
  last_modified: string;
  size: number;
  etag: string;
  delete_marker: boolean;
};
type Pending = { kind: "restore" | "delete"; version: Version };

const STATUS: Record<string, Key> = {
  Enabled: "versions.status.enabled",
  Suspended: "versions.status.suspended",
  "": "versions.status.off",
};

export default function VersionsTab({ at, startTransfer, onChanged, versioning }: ObjectTabProps) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();

  const load = async () => {
    const loaded = await run(() => invoke<Version[]>("browse_versions", { at }));
    setVersions(loaded ?? null);
  };
  useEffect(() => {
    load();
  }, []);

  async function confirmed() {
    if (!pending) return;
    const target = { ...at, version: pending.version.version_id };
    const command = pending.kind === "restore" ? "browse_restore" : "browse_delete";
    const done = await run(() => invoke(command, { at: target }).then(() => true));
    if (!done) return;
    setRestored(pending.kind === "restore" ? pending.version.version_id : null);
    setPending(null);
    await load();
    onChanged();
  }

  const v = pending?.version;
  const confirmText = !v
    ? ""
    : pending.kind === "restore"
      ? t("versions.confirmRestore", { id: v.version_id, time: vnTime(v.last_modified), tz: TZ, key: at.key })
      : v.delete_marker
        ? t("versions.confirmUnmark", { id: v.version_id, key: at.key })
        : t("versions.confirmDelete", { id: v.version_id, size: formatBytes(v.size), key: at.key });

  const deleted = versions?.[0]?.delete_marker === true;
  return (
    <Stack spacing={2}>
      <Alert severity="info">{versioning.status in STATUS ? t(STATUS[versioning.status]) : t("versions.status.other", { status: versioning.status })}</Alert>
      {deleted && <Alert severity="warning">{t("versions.deletedState")}</Alert>}
      {restored && <Alert severity="success">{t("versions.restored", { id: restored })}</Alert>}
      <Box>
        <Button onClick={load} disabled={busy}>
          {t("versions.refresh")}
        </Button>
      </Box>
      {busy && <LinearProgress aria-label={t("versions.loading")} />}
      {pending === null && <ErrorAlert error={error} />}
      <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }} aria-label={t("versions.list")}>
        {(versions ?? []).map((ver) => (
          <Paper key={ver.version_id} component="li" variant="outlined" sx={{ px: 2, py: 1 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, wordBreak: "break-all" }}>{ver.version_id}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {ver.delete_marker
                    ? t("versions.when", { time: vnTime(ver.last_modified, true), tz: TZ })
                    : t("versions.whenSize", { time: vnTime(ver.last_modified, true), tz: TZ, size: formatBytes(ver.size) })}
                </Typography>
              </Stack>
              {ver.is_latest && <Chip size="small" color="success" variant="outlined" label={t("versions.latest")} />}
              {ver.delete_marker && <Chip size="small" color="warning" label={t("versions.deleteMarker")} />}
              {!ver.delete_marker && (
                <Button
                  size="small"
                  onClick={() => download({ ...at, version: ver.version_id }, startTransfer)}
                  aria-label={t("versions.downloadOne", { id: ver.version_id })}
                >
                  {t("common.download")}
                </Button>
              )}
              {!ver.delete_marker && !ver.is_latest && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => setPending({ kind: "restore", version: ver })}
                  aria-label={t("versions.restoreOne", { id: ver.version_id })}
                >
                  {t("versions.restore")}
                </Button>
              )}
              <Button
                size="small"
                color="error"
                onClick={() => setPending({ kind: "delete", version: ver })}
                aria-label={t(ver.delete_marker ? "versions.unmarkOne" : "versions.deleteOne", { id: ver.version_id })}
              >
                {ver.delete_marker ? t("versions.unmark") : t("common.delete")}
              </Button>
            </Stack>
          </Paper>
        ))}
      </Stack>
      {versions?.length === 0 && <Typography color="text.secondary">{t("versions.none")}</Typography>}

      <ConfirmDialog
        open={pending !== null}
        title={t(pending?.kind === "restore" ? "versions.restoreTitle" : v?.delete_marker ? "versions.unmarkTitle" : "versions.deleteTitle")}
        text={confirmText}
        confirmLabel={t(pending?.kind === "restore" ? "versions.restore" : v?.delete_marker ? "versions.unmark" : "versions.deleteConfirm")}
        busy={busy}
        error={error}
        onConfirm={confirmed}
        onClose={() => {
          setPending(null);
          setError(null);
        }}
      />
    </Stack>
  );
}
