import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, LinearProgress, Paper, Stack, Typography } from "@mui/material";
import { invoke } from "./api";
import { formatBytes, TZ, vnTime } from "./format";
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

const STATUS: Record<string, string> = {
  Enabled: "Versioning đang bật: mỗi lần ghi tạo một version mới.",
  Suspended: "Versioning đang tạm dừng: version cũ còn giữ, lần ghi mới đè lên version \"null\".",
  "": "Bucket chưa bật versioning: mỗi key chỉ có một version (\"null\").",
};

export default function VersionsTab({ at, startTransfer, onChanged, versioning }: ObjectTabProps) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
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
    setPending(null);
    await load();
    onChanged();
  }

  const v = pending?.version;
  const confirmText = !v
    ? ""
    : pending.kind === "restore"
      ? `Chép version ${v.version_id} (${vnTime(v.last_modified)} ${TZ}) thành version mới nhất của ${at.key}. Không version nào bị xoá.`
      : v.delete_marker
        ? `Gỡ delete marker ${v.version_id}. Object ${at.key} sẽ hiện lại với version ngay trước đó.`
        : `Xoá vĩnh viễn version ${v.version_id} (${formatBytes(v.size)}) của ${at.key}. Không khôi phục được.`;

  return (
    <Stack spacing={2}>
      <Alert severity="info">{STATUS[versioning.status] ?? `Versioning: ${versioning.status}`}</Alert>
      <Box>
        <Button onClick={load} disabled={busy}>
          Làm mới
        </Button>
      </Box>
      {busy && <LinearProgress aria-label="Đang tải danh sách version" />}
      {pending === null && <ErrorAlert error={error} />}
      <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }} aria-label="Các version">
        {(versions ?? []).map((ver) => (
          <Paper key={ver.version_id} component="li" variant="outlined" sx={{ px: 2, py: 1 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>{ver.version_id}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {vnTime(ver.last_modified, true)} ({TZ}){ver.delete_marker ? "" : ` · ${formatBytes(ver.size)}`}
                </Typography>
              </Stack>
              {ver.is_latest && <Chip size="small" color="success" variant="outlined" label="Mới nhất" />}
              {ver.delete_marker && <Chip size="small" color="warning" label="Delete marker" />}
              {!ver.delete_marker && (
                <Button
                  size="small"
                  onClick={() => download({ ...at, version: ver.version_id }, startTransfer)}
                  aria-label={`Tải về version ${ver.version_id}`}
                >
                  Tải về
                </Button>
              )}
              {!ver.delete_marker && !ver.is_latest && (
                <Button
                  size="small"
                  onClick={() => setPending({ kind: "restore", version: ver })}
                  aria-label={`Khôi phục version ${ver.version_id}`}
                >
                  Khôi phục
                </Button>
              )}
              <Button
                size="small"
                color="error"
                onClick={() => setPending({ kind: "delete", version: ver })}
                aria-label={`${ver.delete_marker ? "Gỡ marker" : "Xoá version"} ${ver.version_id}`}
              >
                {ver.delete_marker ? "Gỡ marker" : "Xoá"}
              </Button>
            </Stack>
          </Paper>
        ))}
      </Stack>
      {versions?.length === 0 && <Typography color="text.secondary">Không có version nào cho key này.</Typography>}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "restore" ? "Khôi phục version?" : v?.delete_marker ? "Gỡ delete marker?" : "Xoá version?"}
        text={confirmText}
        confirmLabel={pending?.kind === "restore" ? "Khôi phục" : v?.delete_marker ? "Gỡ marker" : "Xoá version"}
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
