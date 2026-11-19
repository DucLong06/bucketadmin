import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
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
import { invoke, type AuditEntry, type Profile } from "./api";
import { explain } from "./errors";
import { TZ, vnTime } from "./format";
import { ErrorAlert, useAction } from "./ui";

// Action names written by src-tauri/src/ops.rs.
const ACTIONS = [
  "user.create",
  "user.modify",
  "user.suspend",
  "user.enable",
  "user.delete",
  "key.create",
  "key.remove",
  "subuser.create",
  "subuser.remove",
  "caps.add",
  "caps.remove",
  "quota.set",
  "bucket.quota.set",
  "bucket.delete",
  "usage.trim",
  "object.upload",
  "object.delete",
  "object.delete_many",
  "object.undelete",
  "bucket.versioning.set",
  "object.presign",
  "object.tags.set",
  "version.restore",
  "version.delete",
  "acl.set",
  "acl.set_many",
  "bucket.create",
  "folder.create",
];

const native = { select: { native: true } };

export default function Audit({ profiles }: { profiles: Profile[] }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [action, setAction] = useState("");
  const [clusterId, setClusterId] = useState("");
  const { busy, error, run } = useAction();

  const load = async () => {
    const loaded = await run(() => invoke<AuditEntry[]>("audit_recent", { action, clusterId }));
    setEntries(loaded ?? null);
  };
  useEffect(() => {
    load();
  }, [action, clusterId]);

  // A removed cluster has no label any more; fall back to its id.
  const clusterLabel = (id: string) => profiles.find((p) => p.id === id)?.label ?? id;

  return (
    <>
      <Typography variant="h5" component="h1" gutterBottom>
        Audit
      </Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: "center" }}>
        <TextField
          select
          label="Action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          size="small"
          sx={{ minWidth: 180 }}
          slotProps={{ ...native, inputLabel: { shrink: true } }}
        >
          <option value="">Tất cả</option>
          {ACTIONS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </TextField>
        <TextField
          select
          label="Cluster"
          value={clusterId}
          onChange={(e) => setClusterId(e.target.value)}
          size="small"
          sx={{ minWidth: 180 }}
          slotProps={{ ...native, inputLabel: { shrink: true } }}
        >
          <option value="">Tất cả</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </TextField>
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={load} disabled={busy}>
          Làm mới
        </Button>
      </Stack>
      {busy && <LinearProgress aria-label="Đang tải audit log" />}
      <ErrorAlert error={error} />
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Audit log">
          <TableHead>
            <TableRow>
              <TableCell>Thời gian ({TZ})</TableCell>
              <TableCell>Cluster</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>Chi tiết</TableCell>
              <TableCell>Kết quả</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(entries ?? []).map((e) => (
              <TableRow key={e.id} hover>
                <TableCell sx={{ whiteSpace: "nowrap" }}>{vnTime(e.ts * 1000, true)}</TableCell>
                <TableCell>{clusterLabel(e.cluster_id)}</TableCell>
                <TableCell sx={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>{e.action}</TableCell>
                <TableCell sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>{e.target}</TableCell>
                <TableCell>{e.detail}</TableCell>
                <TableCell>
                  {e.ok ? (
                    <Chip size="small" color="success" variant="outlined" label="OK" />
                  ) : (
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <Chip size="small" color="error" label="Lỗi" />
                      <Typography variant="body2" title={e.message} sx={{ minWidth: 200 }}>
                        {explain(e.message).message}
                      </Typography>
                    </Stack>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {entries !== null && entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography color="text.secondary">Chưa có dòng audit nào khớp bộ lọc.</Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Hiển thị tối đa 100 dòng gần nhất. Secret key không bao giờ được ghi vào audit log.
      </Typography>
    </>
  );
}
