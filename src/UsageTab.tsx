import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
} from "@mui/material";
import { invoke, type Usage } from "./api";
import { formatBytes } from "./format";
import { ConfirmDialog, ErrorAlert, useAction } from "./ui";
import { daysAgo, exportName, nextDay, usageCsv, usageRecords, usageRows, usageTotals } from "./usage";
import type { UserTabProps } from "./UserDrawer";

const dateField = { inputLabel: { shrink: true } };

export default function UsageTab({ clusterId, uid }: UserTabProps) {
  const [start, setStart] = useState(daysAgo(30));
  const [end, setEnd] = useState(daysAgo(0));
  const [usage, setUsage] = useState<Usage | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Set while the trim confirmation is open: what a fresh read says the trim will remove.
  const [trim, setTrim] = useState<{ records: number; ops: number } | null>(null);
  const { busy, error, run, setError } = useAction();

  const rangeOk = !!start && !!end && start <= end;
  // RGW's `end` is exclusive; the picker's end day is meant to be included.
  const range = () => ({ clusterId, uid, start, end: nextDay(end) });

  const load = async () => {
    if (!rangeOk) return undefined;
    setNote(null);
    const loaded = await run(() => invoke<Usage>("usage_get", range()));
    setUsage(loaded ?? null);
    return loaded;
  };
  useEffect(() => {
    load();
  }, []);

  const rows = usage ? usageRows(usage) : [];
  const total = usageTotals(rows);

  async function exportCsv() {
    const fileName = exportName(uid, start, end);
    const path = await run(() => invoke<string>("export_save", { fileName, content: usageCsv(rows) }));
    if (path) setNote(`Đã lưu ${rows.length} dòng vào ${path}`);
  }

  async function askTrim() {
    // Count from a fresh read, so the confirmation shows what is there now, not what was loaded earlier.
    const fresh = await load();
    if (fresh) setTrim({ records: usageRecords(fresh), ops: usageTotals(usageRows(fresh)).ops });
  }

  async function doTrim() {
    const removed = await run(() => invoke<{ records: number }>("usage_trim", range()));
    if (removed) {
      setTrim(null);
      await load();
      setNote(`Đã xoá ${removed.records} bản ghi usage của ${uid}.`);
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", flexWrap: "wrap" }} useFlexGap>
        <TextField
          label="Từ ngày (UTC)"
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          size="small"
          slotProps={dateField}
        />
        <TextField
          label="Đến hết ngày (UTC)"
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          size="small"
          error={!rangeOk}
          helperText={rangeOk ? undefined : "Ngày kết thúc phải từ ngày bắt đầu trở đi"}
          slotProps={dateField}
        />
        <Button variant="contained" onClick={load} disabled={busy || !rangeOk}>
          Xem usage
        </Button>
        <Button onClick={exportCsv} disabled={busy || rows.length === 0}>
          Export CSV
        </Button>
        <Button color="error" onClick={askTrim} disabled={busy || !rangeOk || rows.length === 0}>
          Xoá usage trong khoảng này
        </Button>
      </Stack>
      {busy && <LinearProgress aria-label="Đang tải usage" />}
      {trim === null && <ErrorAlert error={error} />}
      {note && <Alert severity="success">{note}</Alert>}
      {usage !== null && rows.length === 0 && (
        <Alert severity="info">
          Chưa có dữ liệu usage cho user này trong khoảng đã chọn. RGW chỉ ghi usage khi bật tuỳ chọn
          rgw_enable_usage_log, và ghi chậm khoảng 30 giây sau mỗi request.
        </Alert>
      )}
      {rows.length > 0 && (
        <Table size="small" aria-label="Usage theo bucket">
          <TableHead>
            <TableRow>
              <TableCell>Bucket</TableCell>
              <TableCell>Giờ (UTC)</TableCell>
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
                <TableCell sx={{ fontFamily: "monospace" }}>{r.bucket || "(không gắn bucket)"}</TableCell>
                <TableCell sx={{ whiteSpace: "nowrap" }}>{r.time.slice(0, 16).replace("T", " ")}</TableCell>
                <TableCell>{r.category}</TableCell>
                <TableCell align="right">{r.ops}</TableCell>
                <TableCell align="right">{r.successful_ops}</TableCell>
                <TableCell align="right" title={`${r.bytes_sent} byte`}>
                  {formatBytes(r.bytes_sent)}
                </TableCell>
                <TableCell align="right" title={`${r.bytes_received} byte`}>
                  {formatBytes(r.bytes_received)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow>
              <TableCell colSpan={3} sx={{ fontWeight: 600 }}>
                Tổng ({rows.length} dòng)
              </TableCell>
              <TableCell align="right">{total.ops}</TableCell>
              <TableCell align="right">{total.successful_ops}</TableCell>
              <TableCell align="right">{formatBytes(total.bytes_sent)}</TableCell>
              <TableCell align="right">{formatBytes(total.bytes_received)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={trim !== null}
        title="Xoá usage?"
        text={`Sẽ xoá ${trim?.records ?? 0} bản ghi usage (${trim?.ops ?? 0} ops) của user ${uid}, từ ${start} đến hết ${end} (UTC). Dữ liệu usage đã xoá không khôi phục được.`}
        confirmLabel={`Xoá ${trim?.records ?? 0} bản ghi`}
        busy={busy}
        error={error}
        onConfirm={doTrim}
        onClose={() => {
          setTrim(null);
          setError(null);
        }}
      />
    </Stack>
  );
}
