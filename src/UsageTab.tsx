import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@mui/material";
import { invoke, type Usage } from "./api";
import { ErrorAlert, useAction } from "./ui";
import type { UserTabProps } from "./UserDrawer";

export default function UsageTab({ clusterId, uid }: UserTabProps) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const { busy, error, run } = useAction();

  const load = async () => {
    const loaded = await run(() => invoke<Usage>("usage_get", { clusterId, uid }));
    setUsage(loaded ?? null);
  };
  useEffect(() => {
    load();
  }, []);

  const rows = (usage?.entries ?? []).flatMap((entry) =>
    entry.buckets.flatMap((b) => b.categories.map((c) => ({ bucket: b.bucket, time: b.time, ...c }))),
  );
  const total = usage?.summary[0]?.total;
  const noData = usage !== null && rows.length === 0 && !total;

  return (
    <Stack spacing={2}>
      <Box>
        <Button onClick={load} disabled={busy}>
          Làm mới
        </Button>
      </Box>
      {busy && <LinearProgress aria-label="Đang tải usage" />}
      <ErrorAlert error={error} />
      {noData && (
        <Alert severity="info">
          Chưa có dữ liệu usage cho user này. RGW chỉ ghi usage khi bật tuỳ chọn rgw_enable_usage_log.
        </Alert>
      )}
      {usage !== null && !noData && (
        <Table size="small" aria-label="Usage theo bucket">
          <TableHead>
            <TableRow>
              <TableCell>Bucket</TableCell>
              <TableCell>Thời gian</TableCell>
              <TableCell>Category</TableCell>
              <TableCell align="right">Ops</TableCell>
              <TableCell align="right">Ops thành công</TableCell>
              <TableCell align="right">Bytes gửi</TableCell>
              <TableCell align="right">Bytes nhận</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell>{r.bucket}</TableCell>
                <TableCell>{r.time}</TableCell>
                <TableCell>{r.category}</TableCell>
                <TableCell align="right">{r.ops}</TableCell>
                <TableCell align="right">{r.successful_ops}</TableCell>
                <TableCell align="right">{r.bytes_sent}</TableCell>
                <TableCell align="right">{r.bytes_received}</TableCell>
              </TableRow>
            ))}
            {total && (
              <TableRow>
                <TableCell colSpan={3} sx={{ fontWeight: 600 }}>
                  Tổng
                </TableCell>
                <TableCell align="right">{total.ops}</TableCell>
                <TableCell align="right">{total.successful_ops}</TableCell>
                <TableCell align="right">{total.bytes_sent}</TableCell>
                <TableCell align="right">{total.bytes_received}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}
