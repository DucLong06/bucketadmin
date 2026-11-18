import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Divider, Drawer, LinearProgress, Stack, Typography } from "@mui/material";
import { bucketObjects, bucketSize, invoke, type BucketDetail } from "./api";
import { formatBytes, prettyJson } from "./format";
import { ConfirmDialog, ErrorAlert, useAction } from "./ui";

type Props = {
  clusterId: string;
  /** `bucket` or `tenant/bucket`; null keeps the drawer closed. */
  bucket: string | null;
  onClose: () => void;
  /** The bucket was changed or removed: lists showing it should reload. */
  onChanged: () => void;
};

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

export default function BucketDrawer({ clusterId, bucket, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<BucketDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run, setError } = useAction();

  const load = async () => {
    if (!bucket) return;
    const loaded = await run(() => invoke<BucketDetail>("bucket_get", { clusterId, bucket }));
    setDetail(loaded ?? null);
  };
  useEffect(() => {
    setDetail(null);
    setConfirming(false);
    setError(null);
    load();
  }, [bucket, clusterId]);

  async function remove() {
    const done = await run(() => invoke("bucket_delete", { clusterId, bucket }).then(() => true));
    if (done) {
      setConfirming(false);
      onChanged();
      onClose();
    }
  }

  const info = detail?.info;
  const objects = info ? bucketObjects(info) : 0;
  const quota = info?.bucket_quota;
  // What disappears together with the bucket, so the confirmation says it outright.
  const extras = [
    detail?.policy ? "Bucket đang có policy; policy sẽ mất theo." : "",
    quota?.enabled ? "Quota riêng của bucket cũng bị xoá." : "",
  ].join(" ");

  return (
    <Drawer anchor="right" open={bucket !== null} onClose={onClose}>
      <Box sx={{ width: 700, maxWidth: "100vw", p: 3 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
          <Typography variant="h6" component="h2" sx={{ flexGrow: 1, fontFamily: "monospace" }}>
            {bucket}
          </Typography>
          {quota?.enabled && <Chip size="small" color="info" label="Có quota riêng" />}
          {detail?.policy && <Chip size="small" color="info" label="Có policy" />}
          <Button onClick={onClose}>Đóng</Button>
        </Stack>
        {busy && <LinearProgress aria-label="Đang tải bucket" />}
        {!confirming && <ErrorAlert error={error} sx={{ mt: 1 }} />}

        {info && (
          <Stack spacing={3} sx={{ pt: 2 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle1" component="h3">
                Thông tin
              </Typography>
              {row("Owner", info.owner)}
              {info.tenant && row("Tenant", info.tenant)}
              {row("Dung lượng", `${formatBytes(bucketSize(info))} (${bucketSize(info)} byte)`)}
              {row("Số object", String(objects))}
              {row("Tạo lúc", info.creation_time)}
              {row("Versioning", info.versioning)}
              {row("Object lock", info.object_lock_enabled ? "bật" : "tắt")}
              {row("Placement", info.placement_rule)}
              {row("Bucket id", info.id)}
            </Stack>
            <Divider />

            <Stack spacing={1}>
              <Typography variant="subtitle1" component="h3">
                Bucket policy
              </Typography>
              {detail.policy_error ? (
                <ErrorAlert error={detail.policy_error} />
              ) : detail.policy ? (
                <Box
                  component="pre"
                  aria-label="Bucket policy JSON"
                  tabIndex={0}
                  sx={{ m: 0, p: 2, bgcolor: "background.default", borderRadius: 1, overflow: "auto", maxHeight: 320, fontSize: 13 }}
                >
                  {prettyJson(detail.policy)}
                </Box>
              ) : (
                <Typography color="text.secondary">Bucket không có policy.</Typography>
              )}
            </Stack>
            <Divider />

            <Stack spacing={1}>
              <Typography variant="subtitle1" component="h3">
                Xoá bucket
              </Typography>
              {objects > 0 ? (
                <Alert severity="info">
                  Bucket còn {objects} object. Chỉ xoá được bucket rỗng: hãy xoá hết object trước.
                </Alert>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Bucket đang rỗng nên có thể xoá.
                </Typography>
              )}
              <Box>
                <Button color="error" variant="outlined" disabled={objects > 0} onClick={() => setConfirming(true)}>
                  Xoá bucket
                </Button>
              </Box>
            </Stack>
          </Stack>
        )}

        <ConfirmDialog
          open={confirming}
          title="Xoá bucket?"
          text={`Thao tác này xoá vĩnh viễn bucket ${bucket}. ${extras}`.trim()}
          confirmLabel="Xoá bucket"
          requireText={bucket ?? ""}
          busy={busy}
          error={error}
          onConfirm={remove}
          onClose={() => {
            setConfirming(false);
            setError(null);
          }}
        />
      </Box>
    </Drawer>
  );
}
