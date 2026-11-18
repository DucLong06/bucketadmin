import { useEffect, useState } from "react";
import { Box, Button, Chip, LinearProgress, Link, Paper, Stack, Typography } from "@mui/material";
import { bucketKey, bucketObjects, bucketSize, invoke, type Bucket } from "./api";
import BucketDrawer from "./BucketDrawer";
import { formatBytes } from "./format";
import { ErrorAlert, useAction } from "./ui";
import type { UserTabProps } from "./UserDrawer";

/** The user's buckets; each opens the same bucket drawer as the Buckets page (quota, policy, delete). */
export default function UserBucketsTab({ clusterId, uid }: UserTabProps) {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const load = async () => {
    const loaded = await run(() => invoke<Bucket[]>("buckets_list", { clusterId, uid }));
    setBuckets(loaded ?? null);
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <Stack spacing={2}>
      <Box>
        <Button onClick={load} disabled={busy}>
          Làm mới
        </Button>
      </Box>
      {busy && <LinearProgress aria-label="Đang tải bucket của user" />}
      <ErrorAlert error={error} />
      {buckets?.length === 0 && <Typography color="text.secondary">User chưa có bucket nào.</Typography>}
      <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {(buckets ?? []).map((b) => (
          <Paper key={bucketKey(b)} component="li" variant="outlined" sx={{ px: 2, py: 1 }}>
            <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
              <Link
                component="button"
                sx={{ flexGrow: 1, textAlign: "left", fontFamily: "monospace" }}
                onClick={() => setSelected(bucketKey(b))}
                aria-label={`Mở chi tiết bucket ${bucketKey(b)}`}
              >
                {bucketKey(b)}
              </Link>
              <Typography variant="body2" color="text.secondary">
                {formatBytes(bucketSize(b))} · {bucketObjects(b)} object
              </Typography>
              {b.bucket_quota.enabled && <Chip size="small" color="info" variant="outlined" label="Có quota riêng" />}
            </Stack>
          </Paper>
        ))}
      </Stack>
      <BucketDrawer clusterId={clusterId} bucket={selected} onClose={() => setSelected(null)} onChanged={load} />
    </Stack>
  );
}
