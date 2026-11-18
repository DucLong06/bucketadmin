import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { bucketKey, bucketObjects, bucketSize, invoke, type Bucket, type Profile } from "./api";
import BucketDrawer from "./BucketDrawer";
import { formatBytes } from "./format";
import { ClusterSelect, ErrorAlert, useAction } from "./ui";

type Props = { profiles: Profile[]; clusterId: string; onClusterChange: (id: string) => void };

export default function Buckets({ profiles, clusterId, onClusterChange }: Props) {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const request = useRef(0);

  async function load() {
    if (!clusterId) return;
    const mine = ++request.current;
    const loaded = await run(() => invoke<Bucket[]>("buckets_list", { clusterId }));
    // A slower answer for a cluster the user already left must not overwrite the table.
    if (mine === request.current) {
      setBuckets(loaded ? loaded.sort((a, b) => bucketKey(a).localeCompare(bucketKey(b))) : null);
    }
  }
  useEffect(() => {
    setBuckets(null);
    setSelected(null);
    load();
  }, [clusterId]);

  const needle = filter.trim().toLowerCase();
  const shown = (buckets ?? []).filter(
    (b) => bucketKey(b).toLowerCase().includes(needle) || b.owner.toLowerCase().includes(needle),
  );

  if (profiles.length === 0) {
    return <Alert severity="info">Chưa có cluster nào. Hãy thêm cluster ở tab Clusters trước.</Alert>;
  }
  return (
    <>
      <Typography variant="h5" component="h1" gutterBottom>
        Buckets
      </Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: "center" }}>
        <ClusterSelect profiles={profiles} value={clusterId} onChange={onClusterChange} />
        <TextField
          label="Tìm theo tên hoặc owner"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          size="small"
          sx={{ minWidth: 240 }}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={load} disabled={busy}>
          Làm mới
        </Button>
      </Stack>
      {busy && <LinearProgress aria-label="Đang tải danh sách bucket" />}
      <ErrorAlert error={error} sx={{ mb: 2 }} />
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Danh sách bucket">
          <TableHead>
            <TableRow>
              <TableCell>Tên</TableCell>
              <TableCell>Owner</TableCell>
              <TableCell align="right">Dung lượng</TableCell>
              <TableCell align="right">Objects</TableCell>
              <TableCell>Quota riêng</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((b) => (
              <TableRow key={bucketKey(b)} hover>
                <TableCell>
                  <Link
                    component="button"
                    sx={{ fontFamily: "monospace" }}
                    onClick={() => setSelected(bucketKey(b))}
                    aria-label={`Mở chi tiết bucket ${bucketKey(b)}`}
                  >
                    {bucketKey(b)}
                  </Link>
                </TableCell>
                <TableCell sx={{ fontFamily: "monospace" }}>{b.owner}</TableCell>
                <TableCell align="right">{formatBytes(bucketSize(b))}</TableCell>
                <TableCell align="right">{bucketObjects(b)}</TableCell>
                <TableCell>
                  {b.bucket_quota.enabled ? (
                    <Chip size="small" color="info" variant="outlined" label="Đang bật" />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Tắt
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {buckets !== null && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography color="text.secondary">
                    {buckets.length === 0 ? "Cluster chưa có bucket nào." : "Không có bucket nào khớp."}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {buckets !== null && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Hiển thị {shown.length}/{buckets.length} bucket
        </Typography>
      )}
      <BucketDrawer clusterId={clusterId} bucket={selected} onClose={() => setSelected(null)} onChanged={load} />
    </>
  );
}
