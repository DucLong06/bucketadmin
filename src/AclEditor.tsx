import { useEffect, useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { invoke } from "./api";
import type { ObjectAt, ObjectTabProps } from "./ObjectDrawer";
import { ErrorAlert, useAction } from "./ui";

export type Grant = { kind: "user" | "group"; grantee: string; display_name: string; permission: string };
type Acl = { owner_id: string; owner_name: string; grants: Grant[] };

const PERMISSIONS = ["FULL_CONTROL", "READ", "WRITE", "READ_ACP", "WRITE_ACP"];
const GROUPS = [
  { value: "AllUsers", label: "AllUsers (mọi người, không cần đăng nhập)" },
  { value: "AuthenticatedUsers", label: "AuthenticatedUsers (mọi user của cluster)" },
];
const native = { select: { native: true } };

/** What the editor warns about before the ACL is applied. */
export function aclWarnings(ownerId: string, grants: Grant[]): string[] {
  const warnings: string[] = [];
  if (grants.some((g) => g.kind === "group" && g.grantee === "AllUsers")) {
    warnings.push("Có grant cho AllUsers: ai cũng truy cập được mà không cần key.");
  }
  if (!grants.some((g) => g.kind === "user" && g.grantee === ownerId && g.permission === "FULL_CONTROL")) {
    warnings.push(`Owner ${ownerId} không còn FULL_CONTROL trong danh sách.`);
  }
  if (grants.some((g) => g.kind === "user" && !g.grantee.trim())) {
    warnings.push("Có grant chưa điền uid.");
  }
  return warnings;
}

/** Reads the ACL of an object (or of the bucket when `at.key` is empty), lets it be edited, applies it and shows what reads back. */
export default function AclEditor({ at }: { at: ObjectAt }) {
  const [acl, setAcl] = useState<Acl | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [verified, setVerified] = useState<boolean | null>(null);
  const { busy, error, run } = useAction();

  const load = async () => {
    setVerified(null);
    const loaded = await run(() => invoke<Acl>("browse_acl_get", { at }));
    if (loaded) {
      setAcl(loaded);
      setGrants(loaded.grants);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const change = (i: number, patch: Partial<Grant>) => {
    setVerified(null);
    setGrants((list) => list.map((g, n) => (n === i ? { ...g, ...patch } : g)));
  };
  async function apply() {
    setVerified(null);
    const applied = await run(() => invoke<{ acl: Acl; verified: boolean }>("browse_acl_put", { at, grants }));
    if (applied) {
      setAcl(applied.acl);
      setGrants(applied.acl.grants);
      setVerified(applied.verified);
    }
  }

  const warnings = acl ? aclWarnings(acl.owner_id, grants) : [];
  const dirty = acl !== null && JSON.stringify(acl.grants) !== JSON.stringify(grants);
  return (
    <Stack spacing={2}>
      {busy && <LinearProgress aria-label="Đang tải ACL" />}
      <ErrorAlert error={error} />
      {acl && (
        <>
          <Typography variant="body2">
            Owner: <Box component="span" sx={{ fontFamily: "monospace" }}>{acl.owner_id}</Box>
            {acl.owner_name && ` (${acl.owner_name})`}
          </Typography>
          <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }} aria-label="Danh sách grant">
            {grants.map((g, i) => (
              <Stack key={i} component="li" direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <TextField
                  select
                  label="Loại"
                  value={g.kind}
                  onChange={(e) =>
                    change(i, { kind: e.target.value as Grant["kind"], grantee: e.target.value === "group" ? "AllUsers" : "", display_name: "" })
                  }
                  size="small"
                  sx={{ width: 110 }}
                  slotProps={{ ...native, htmlInput: { "aria-label": `Loại grantee của grant ${i + 1}` } }}
                >
                  <option value="user">user</option>
                  <option value="group">group</option>
                </TextField>
                {g.kind === "group" ? (
                  <TextField
                    select
                    label="Group"
                    value={g.grantee}
                    onChange={(e) => change(i, { grantee: e.target.value })}
                    size="small"
                    sx={{ flexGrow: 1 }}
                    slotProps={{ ...native, htmlInput: { "aria-label": `Group của grant ${i + 1}` } }}
                  >
                    {GROUPS.map((group) => (
                      <option key={group.value} value={group.value}>
                        {group.label}
                      </option>
                    ))}
                  </TextField>
                ) : (
                  <TextField
                    label="uid"
                    value={g.grantee}
                    onChange={(e) => change(i, { grantee: e.target.value.trim() })}
                    size="small"
                    sx={{ flexGrow: 1 }}
                    helperText={g.display_name || undefined}
                    slotProps={{ htmlInput: { "aria-label": `uid của grant ${i + 1}` } }}
                  />
                )}
                <TextField
                  select
                  label="Quyền"
                  value={g.permission}
                  onChange={(e) => change(i, { permission: e.target.value })}
                  size="small"
                  sx={{ width: 200 }}
                  slotProps={{ ...native, htmlInput: { "aria-label": `Quyền của grant ${i + 1}` } }}
                >
                  {PERMISSIONS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </TextField>
                <Button
                  size="small"
                  color="error"
                  onClick={() => {
                    setVerified(null);
                    setGrants((list) => list.filter((_, n) => n !== i));
                  }}
                  aria-label={`Bỏ grant ${i + 1}`}
                >
                  Bỏ
                </Button>
              </Stack>
            ))}
          </Stack>
          {grants.length === 0 && <Typography color="text.secondary">Không có grant nào: chỉ owner truy cập được.</Typography>}
          {warnings.map((w) => (
            <Alert key={w} severity="warning">
              {w}
            </Alert>
          ))}
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              onClick={() => {
                setVerified(null);
                setGrants((list) => [...list, { kind: "user", grantee: "", display_name: "", permission: "READ" }]);
              }}
            >
              Thêm grant
            </Button>
            <Button variant="contained" onClick={apply} disabled={busy || !dirty || grants.some((g) => !g.grantee)}>
              Áp dụng ACL
            </Button>
            <Button onClick={load} disabled={busy}>
              Đọc lại từ cluster
            </Button>
          </Stack>
          {verified === true && <Alert severity="success">Đã áp dụng. ACL đọc lại từ cluster khớp với ACL vừa gửi.</Alert>}
          {verified === false && (
            <Alert severity="warning">
              Đã gửi ACL, nhưng ACL đọc lại từ cluster KHÔNG khớp với ACL vừa gửi. Danh sách trên là ACL đang có hiệu lực.
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
