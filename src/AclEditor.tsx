import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { invoke } from "./api";
import { explain } from "./errors";
import type { ObjectAt, ObjectTabProps } from "./ObjectDrawer";
import { percent } from "./transfers";
import { ErrorAlert, useAction } from "./ui";

export type Grant = { kind: "user" | "group"; grantee: string; display_name: string; permission: string };
type Acl = { owner_id: string; owner_name: string; grants: Grant[] };
type AclReport = { objects: number; applied: number; unverified: number; failed: { key: string; error: string }[]; cancelled: boolean };

export const PERMISSIONS = ["FULL_CONTROL", "READ", "WRITE", "READ_ACP", "WRITE_ACP"];
const native = { select: { native: true } };
const PUBLIC = "Mọi người (public)";

/** The three fixed rows of the quick-share table; every other grant is a per-user row below it. */
export const fixedRows = (ownerId: string): { label: string; kind: Grant["kind"]; grantee: string }[] => [
  { label: "Chủ sở hữu", kind: "user", grantee: ownerId },
  { label: "Mọi user đã xác thực (auth)", kind: "group", grantee: "AuthenticatedUsers" },
  { label: PUBLIC, kind: "group", grantee: "AllUsers" },
];

const same = (g: Grant, kind: string, grantee: string, permission: string) =>
  g.kind === kind && g.grantee === grantee && g.permission === permission;

/** Ticks or clears one box of the table: the grant is added when missing, removed (every copy) when present. */
export function toggleGrant(grants: Grant[], kind: Grant["kind"], grantee: string, permission: string): Grant[] {
  const without = grants.filter((g) => !same(g, kind, grantee, permission));
  return without.length < grants.length ? without : [...grants, { kind, grantee, display_name: "", permission }];
}

export type Preset = "private" | "public-read" | "authenticated-read";
export const PRESETS: { value: Preset; label: string }[] = [
  { value: "private", label: "Riêng tư" },
  { value: "public-read", label: "Công khai đọc (public-read)" },
  { value: "authenticated-read", label: "User đã xác thực đọc (authenticated-read)" },
];

/** The grants S3's canned ACL of that name stands for. */
export function presetGrants(ownerId: string, preset: Preset): Grant[] {
  const grant = (kind: Grant["kind"], grantee: string, permission: string): Grant => ({ kind, grantee, display_name: "", permission });
  const owner = grant("user", ownerId, "FULL_CONTROL");
  if (preset === "public-read") return [owner, grant("group", "AllUsers", "READ")];
  if (preset === "authenticated-read") return [owner, grant("group", "AuthenticatedUsers", "READ")];
  return [owner];
}

/** What the editor warns about before the ACL is applied. The first entry, when public access is granted, is the loud one. */
export function aclWarnings(ownerId: string, grants: Grant[]): string[] {
  const warnings: string[] = [];
  const open = grants.filter((g) => g.kind === "group" && g.grantee === "AllUsers").map((g) => g.permission);
  if (open.length > 0) {
    const writes = open.some((p) => p !== "READ" && p !== "READ_ACP");
    warnings.push(
      `Đang cấp ${open.join(", ")} cho "${PUBLIC}": bất kỳ ai trên mạng tới được endpoint đều dùng được quyền này mà không cần key` +
        (writes ? " — kể cả ghi, xoá hoặc đổi ACL." : "."),
    );
  }
  if (!grants.some((g) => same(g, "user", ownerId, "FULL_CONTROL"))) {
    warnings.push(`Owner ${ownerId} không còn FULL_CONTROL trong danh sách.`);
  }
  if (grants.some((g) => g.kind === "user" && !g.grantee.trim())) {
    warnings.push("Có grant chưa điền uid.");
  }
  return warnings;
}

/**
 * Reads an ACL, lets it be edited as a quick-share table plus per-user rows, applies it and
 * shows what reads back. `at.key` empty: the bucket. With `recursive`, `at.key` is a prefix
 * (or empty) and the same ACL can be applied to every object under it; a folder has no ACL
 * of its own, so the table then starts from the ACL of the first object in it.
 */
export default function AclEditor({ at, recursive = false }: { at: ObjectAt; recursive?: boolean }) {
  const folder = recursive && at.key !== "";
  const [acl, setAcl] = useState<Acl | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [verified, setVerified] = useState<boolean | null>(null);
  // Keys under the prefix; null until asked for.
  const [keys, setKeys] = useState<string[] | null>(null);
  const [deep, setDeep] = useState(false);
  const [progress, setProgress] = useState<{ id: string; done: number; total: number } | null>(null);
  const [report, setReport] = useState<AclReport | null>(null);
  const { busy, error, run } = useAction();
  const running = useRef("");

  useEffect(() => {
    const unlisten = listen<{ id: string; done: number; total: number }>("transfer", (e) => {
      if (e.payload.id === running.current) setProgress(e.payload);
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  const edit = (next: Grant[] | ((old: Grant[]) => Grant[])) => {
    setVerified(null);
    setReport(null);
    setGrants(next);
  };
  const targets = () => run(() => invoke<string[]>("browse_acl_targets", { at }));
  const load = async () => {
    setVerified(null);
    let source = at;
    if (folder) {
      const under = await targets();
      if (!under) return;
      setKeys(under);
      if (under.length === 0) return;
      source = { ...at, key: under[0] };
    }
    const loaded = await run(() => invoke<Acl>("browse_acl_get", { at: source }));
    if (loaded) {
      setAcl(loaded);
      setGrants(loaded.grants);
    }
  };
  useEffect(() => {
    load();
  }, []);

  async function setRecursive(on: boolean) {
    setDeep(on);
    setReport(null);
    if (on && keys === null) setKeys((await targets()) ?? null);
  }

  async function apply() {
    setVerified(null);
    setReport(null);
    if (!folder) {
      const applied = await run(() => invoke<{ acl: Acl; verified: boolean }>("browse_acl_put", { at, grants }));
      if (!applied) return;
      setAcl(applied.acl);
      setVerified(applied.verified);
      // Sent to the objects as typed; what the bucket normalised it to is shown afterwards.
      if (!deep) setGrants(applied.acl.grants);
    }
    if (!deep || !keys) return;
    const transferId = crypto.randomUUID();
    running.current = transferId;
    setProgress({ id: transferId, done: 0, total: keys.length });
    const done = await run(() => invoke<AclReport>("browse_acl_put_many", { at, keys, grants, transferId }));
    running.current = "";
    setProgress(null);
    if (done) setReport(done);
  }

  const warnings = acl ? aclWarnings(acl.owner_id, grants) : [];
  const isPublic = grants.some((g) => g.kind === "group" && g.grantee === "AllUsers");
  const rows = acl ? fixedRows(acl.owner_id) : [];
  const inTable = (g: Grant) => rows.some((r) => r.kind === g.kind && r.grantee === g.grantee) && PERMISSIONS.includes(g.permission);
  const dirty = acl !== null && JSON.stringify(acl.grants) !== JSON.stringify(grants);
  const count = keys?.length ?? 0;
  const where = at.key ? `thư mục ${at.key}` : `bucket ${at.bucket}`;
  // A folder has nothing but its objects to apply to; a bucket or object can be applied on its own.
  const canApply = !busy && !grants.some((g) => !g.grantee) && (deep ? count > 0 : !folder && dirty);
  const firstFailure = report?.failed[0];

  return (
    <Stack spacing={2}>
      {busy && !progress && <LinearProgress aria-label="Đang tải ACL" />}
      <ErrorAlert error={error} />
      {folder && keys?.length === 0 && <Alert severity="info">Thư mục này không có object nào để đặt ACL.</Alert>}
      {acl && (
        <>
          <Typography variant="body2">
            Owner: <Box component="span" sx={{ fontWeight: 600 }}>{acl.owner_id}</Box>
            {acl.owner_name && ` (${acl.owner_name})`}
            {folder && keys && ` · ACL đang hiện là của object đầu tiên trong thư mục (${keys[0]}).`}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
            <Typography variant="body2" color="text.secondary">
              Đặt nhanh:
            </Typography>
            {PRESETS.map((p) => (
              <Button key={p.value} size="small" variant="outlined" onClick={() => edit(presetGrants(acl.owner_id, p.value))}>
                {p.label}
              </Button>
            ))}
          </Stack>
          <Table size="small" aria-label="Bảng chia sẻ nhanh">
            <TableHead>
              <TableRow>
                <TableCell>Đối tượng</TableCell>
                {PERMISSIONS.map((p) => (
                  <TableCell key={p} align="center">
                    {p}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.grantee}>
                  <TableCell>{r.label}</TableCell>
                  {PERMISSIONS.map((p) => (
                    <TableCell key={p} align="center" padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={grants.some((g) => same(g, r.kind, r.grantee, p))}
                        onChange={() => edit((list) => toggleGrant(list, r.kind, r.grantee, p))}
                        slotProps={{ input: { "aria-label": `${r.label}: ${p}` } }}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }} aria-label="Grant cho từng user">
            {grants.map((g, i) =>
              inTable(g) ? null : (
                <Stack key={i} component="li" direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <TextField
                    label={g.kind === "user" ? "uid" : "group"}
                    value={g.grantee}
                    disabled={g.kind !== "user"}
                    onChange={(e) => edit((list) => list.map((old, n) => (n === i ? { ...old, grantee: e.target.value.trim(), display_name: "" } : old)))}
                    size="small"
                    sx={{ flexGrow: 1 }}
                    helperText={g.display_name || undefined}
                    slotProps={{ htmlInput: { "aria-label": `uid của grant ${i + 1}` } }}
                  />
                  <TextField
                    select
                    label="Quyền"
                    value={g.permission}
                    onChange={(e) => edit((list) => list.map((old, n) => (n === i ? { ...old, permission: e.target.value } : old)))}
                    size="small"
                    sx={{ width: 200 }}
                    slotProps={{ ...native, htmlInput: { "aria-label": `Quyền của grant ${i + 1}` } }}
                  >
                    {PERMISSIONS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </TextField>
                  <Button size="small" color="error" onClick={() => edit((list) => list.filter((_, n) => n !== i))} aria-label={`Bỏ grant ${i + 1}`}>
                    Bỏ
                  </Button>
                </Stack>
              ),
            )}
          </Stack>
          {warnings.map((w, i) => (
            <Alert key={w} severity={isPublic && i === 0 ? "error" : "warning"} variant={isPublic && i === 0 ? "filled" : "standard"}>
              {w}
            </Alert>
          ))}
          {recursive && (
            <FormControlLabel
              control={<Checkbox checked={deep} disabled={busy} onChange={(e) => setRecursive(e.target.checked)} />}
              label={
                deep && keys
                  ? `Áp dụng đệ quy cho ${count} object trong ${where}`
                  : `Áp dụng đệ quy cho mọi object trong ${where} (tick để đếm số object)`
              }
            />
          )}
          {folder && !deep && (
            <Typography variant="body2" color="text.secondary">
              Thư mục không có ACL riêng: tick ô trên để đặt ACL này cho từng object bên trong.
            </Typography>
          )}
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" disabled={busy} onClick={() => edit((list) => [...list, { kind: "user", grantee: "", display_name: "", permission: "READ" }])}>
              Thêm user
            </Button>
            <Button variant="contained" color={isPublic ? "error" : "primary"} onClick={apply} disabled={!canApply}>
              {deep ? `Áp dụng ACL cho ${count + (folder ? 0 : 1)} mục` : "Áp dụng ACL"}
            </Button>
            <Button onClick={load} disabled={busy}>
              Đọc lại từ cluster
            </Button>
          </Stack>
          {progress && (
            <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
              <Box sx={{ flexGrow: 1 }}>
                <LinearProgress variant="determinate" value={percent(progress.done, progress.total)} aria-label="Tiến độ đặt ACL" />
              </Box>
              <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
                {progress.done}/{progress.total} object
              </Typography>
              <Button size="small" color="error" onClick={() => invoke("browse_cancel", { transferId: progress.id })}>
                Dừng
              </Button>
            </Stack>
          )}
          {verified === true && <Alert severity="success">Đã áp dụng. ACL đọc lại từ cluster khớp với ACL vừa gửi.</Alert>}
          {verified === false && (
            <Alert severity="warning">
              Đã gửi ACL, nhưng ACL đọc lại từ cluster KHÔNG khớp với ACL vừa gửi{deep ? "" : ". Danh sách trên là ACL đang có hiệu lực"}.
            </Alert>
          )}
          {report && (
            <Alert severity={firstFailure || report.cancelled ? "warning" : "success"}>
              Đã đặt ACL cho {report.applied}/{report.objects} object
              {report.unverified > 0 && `; ${report.unverified} object đọc lại không khớp`}
              {report.cancelled && "; đã dừng theo yêu cầu, các object còn lại giữ ACL cũ"}
              {firstFailure && `; ${report.failed.length} object lỗi. Lỗi đầu tiên (${firstFailure.key}): ${explain(firstFailure.error).message}`}.
            </Alert>
          )}
        </>
      )}
    </Stack>
  );
}

/** The object drawer's ACL tab. */
export function AclTab({ at }: ObjectTabProps) {
  return <AclEditor at={at} />;
}
