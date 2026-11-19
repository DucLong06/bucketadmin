import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
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
import { invoke } from "./api";
import { explain } from "./errors";
import { formatBytes } from "./format";
import { ONBOARD_EXAMPLE, ONBOARD_HEADER, onboardReport, parseOnboardCsv, type OnboardResult } from "./onboard";
import { ErrorAlert, useAction } from "./ui";

type Props = { clusterId: string; open: boolean; onClose: () => void; /** Users were created: the list should reload. */ onCreated: () => void };

const STATUS: Record<string, { label: string; color: "default" | "success" | "error" | "info" | "warning" }> = {
  would_create: { label: "Sẽ tạo", color: "info" },
  exists: { label: "Đã tồn tại — bỏ qua", color: "default" },
  created: { label: "Đã tạo", color: "success" },
  error: { label: "Lỗi", color: "error" },
  invalid: { label: "Dòng sai", color: "warning" },
};

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

/** Creates many users from a CSV file: check first (dry run), then run, then save a report. */
export default function BulkOnboard({ clusterId, open, onClose, onCreated }: Props) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<OnboardResult[] | null>(null);
  // "dry": the results on screen are a dry run of exactly the current text; "real": users were created.
  const [phase, setPhase] = useState<"edit" | "dry" | "real">("edit");
  const [withKeys, setWithKeys] = useState(true);
  const [savedTo, setSavedTo] = useState("");
  const { busy, error, run, setError } = useAction();

  const parsed = parseOnboardCsv(text);
  const valid = parsed.lines.filter((l) => !l.error);
  const byUid = new Map((results ?? []).map((r) => [r.uid, r]));
  const toCreate = (results ?? []).filter((r) => r.status === "would_create").length;
  const created = (results ?? []).filter((r) => r.status === "created" || (r.status === "error" && r.secret_key)).length;

  const edit = (value: string) => {
    setText(value);
    setResults(null);
    setPhase("edit");
    setSavedTo("");
  };
  const close = () => {
    edit("");
    setError(null);
    onClose();
  };
  async function send(dryRun: boolean) {
    setSavedTo("");
    const rows = valid.map((l) => l.row);
    const answered = await run(() => invoke<OnboardResult[]>("bulk_onboard", { clusterId, rows, dryRun }));
    if (!answered) return;
    setResults(answered);
    setPhase(dryRun ? "dry" : "real");
    if (!dryRun) onCreated();
  }
  async function saveReport() {
    const keys = phase === "real" && withKeys;
    const fileName = `onboard-${phase === "real" ? "report" : "dryrun"}-${stamp()}.csv`;
    const content = onboardReport(parsed.lines, results ?? [], keys);
    const path = await run(() => invoke<string>("export_save", { fileName, content }));
    if (path) setSavedTo(path);
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="lg" fullWidth aria-labelledby="bulk-title">
      <DialogTitle id="bulk-title">Onboard nhiều user từ CSV</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Mỗi dòng một user, dòng đầu là <code>{ONBOARD_HEADER}</code>. <b>caps</b>: các cap dạng type=perm, cách nhau bằng dấu ;
            (ví dụ <code>buckets=read;usage=read</code>). <b>quota</b>: dung lượng tối đa của user, số kèm đơn vị K, M, G hoặc T (ví dụ{" "}
            <code>10G</code>); để trống là không đặt quota. User đã tồn tại sẽ được giữ nguyên, không bị sửa.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Button component="label" variant="outlined" disabled={busy}>
              Chọn file CSV
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = ""; // choosing the same file again must fire again
                  if (file) edit(await file.text());
                }}
              />
            </Button>
            <Button onClick={() => edit(ONBOARD_EXAMPLE)} disabled={busy}>
              Điền ví dụ
            </Button>
          </Stack>
          <TextField
            label="Nội dung CSV"
            value={text}
            onChange={(e) => edit(e.target.value)}
            multiline
            minRows={4}
            maxRows={10}
            fullWidth
            disabled={busy || phase === "real"}
            slotProps={{ htmlInput: { style: { fontFamily: "monospace", fontSize: 13 }, spellCheck: false } }}
          />
          {text && parsed.problem && <Alert severity="error">{parsed.problem}</Alert>}
          {busy && <LinearProgress aria-label="Đang xử lý" />}
          <ErrorAlert error={error} />

          {parsed.lines.length > 0 && (
            <TableContainer sx={{ maxHeight: 320 }}>
              <Table size="small" stickyHeader aria-label="Các dòng trong file">
                <TableHead>
                  <TableRow>
                    <TableCell align="right">Dòng</TableCell>
                    <TableCell>uid</TableCell>
                    <TableCell>Display name</TableCell>
                    <TableCell>Caps</TableCell>
                    <TableCell>Quota</TableCell>
                    <TableCell>Trạng thái</TableCell>
                    <TableCell>Ghi chú</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {parsed.lines.map((l) => {
                    const result = l.error ? undefined : byUid.get(l.row.uid);
                    const status = STATUS[l.error ? "invalid" : (result?.status ?? "")];
                    return (
                      <TableRow key={l.line}>
                        <TableCell align="right">{l.line}</TableCell>
                        <TableCell sx={{ fontFamily: "monospace" }}>{l.row.uid}</TableCell>
                        <TableCell>{l.row.display_name}</TableCell>
                        <TableCell>{l.row.caps.join("; ")}</TableCell>
                        <TableCell sx={{ whiteSpace: "nowrap" }}>{l.row.quota_kb ? formatBytes(l.row.quota_kb * 1024) : "—"}</TableCell>
                        <TableCell>
                          {status ? <Chip size="small" color={status.color} label={status.label} /> : <Typography variant="body2">Chưa kiểm tra</Typography>}
                        </TableCell>
                        <TableCell>{l.error ?? (result?.message ? explain(result.message).message : "")}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {parsed.lines.length > 0 && (
            <Typography variant="body2" aria-live="polite">
              {parsed.lines.length} dòng: {valid.length} hợp lệ, {parsed.lines.length - valid.length} sai.
              {phase === "dry" && ` Dry-run: ${toCreate} user sẽ được tạo, ${(results ?? []).length - toCreate} bị bỏ qua hoặc lỗi.`}
              {phase === "real" && ` Đã chạy: ${created} user được tạo.`}
            </Typography>
          )}
          {phase === "real" && (
            <Alert severity="warning">
              Secret key của user mới chỉ có trong kết quả này. Lưu report kèm key rồi giữ file cẩn thận (file được tạo với quyền chỉ
              chủ sở hữu đọc được), hoặc cấp key lại sau bằng Rotate.
            </Alert>
          )}
          {results && (
            <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
              <Button variant="outlined" onClick={saveReport} disabled={busy}>
                Lưu report CSV
              </Button>
              {phase === "real" && (
                <FormControlLabel
                  control={<Checkbox checked={withKeys} onChange={(e) => setWithKeys(e.target.checked)} />}
                  label="Ghi access key và secret key vào report"
                />
              )}
              {savedTo && <Typography variant="body2">Đã lưu vào {savedTo}</Typography>}
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>
          Đóng
        </Button>
        <Button variant="outlined" onClick={() => send(true)} disabled={busy || phase === "real" || valid.length === 0}>
          Kiểm tra (dry-run)
        </Button>
        <Button variant="contained" onClick={() => send(false)} disabled={busy || phase !== "dry" || toCreate === 0}>
          Tạo {toCreate} user
        </Button>
      </DialogActions>
    </Dialog>
  );
}
