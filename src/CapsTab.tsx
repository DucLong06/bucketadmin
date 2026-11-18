import { type FormEvent, useState } from "react";
import { Alert, Button, Chip, Stack, TextField, Typography } from "@mui/material";
import { invoke, type Capability } from "./api";
import { CAP_PERMS, CAP_TYPES } from "./caps";
import { ErrorAlert, useAction } from "./ui";
import type { UserTabProps } from "./UserDrawer";

const native = { select: { native: true } };

export default function CapsTab({ clusterId, uid, user, refresh }: UserTabProps) {
  const [type, setType] = useState(CAP_TYPES[0]);
  const [perm, setPerm] = useState(CAP_PERMS[0]);
  const [custom, setCustom] = useState("");
  const { busy, error, run } = useAction();

  async function change(command: "caps_add" | "caps_remove", cap: string) {
    const caps = await run(() => invoke<Capability[]>(command, { clusterId, uid, cap }));
    if (caps) await refresh();
    return caps !== undefined;
  }

  async function addCustom(e: FormEvent) {
    e.preventDefault();
    if (await change("caps_add", custom)) setCustom("");
  }

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Typography variant="subtitle1" component="h3">
          Caps hiện tại
        </Typography>
        {user.caps.length === 0 && <Typography color="text.secondary">User chưa có cap nào.</Typography>}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {user.caps.map((c) => (
            <Chip
              key={c.type}
              label={`${c.type}=${c.perm}`}
              disabled={busy}
              onDelete={() => change("caps_remove", `${c.type}=${c.perm}`)}
            />
          ))}
        </Stack>
        {user.caps.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            Bấm dấu × trên chip (hoặc phím Delete khi chip đang được focus) để gỡ cap.
          </Typography>
        )}
      </Stack>

      <Stack spacing={1}>
        <Typography variant="subtitle1" component="h3">
          Thêm cap
        </Typography>
        <Stack direction="row" spacing={1}>
          <TextField
            select
            label="Loại cap"
            value={type}
            onChange={(e) => setType(e.target.value)}
            size="small"
            sx={{ minWidth: 240 }}
            slotProps={native}
          >
            {CAP_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </TextField>
          <TextField
            select
            label="Quyền"
            value={perm}
            onChange={(e) => setPerm(e.target.value)}
            size="small"
            sx={{ minWidth: 120 }}
            slotProps={native}
          >
            {CAP_PERMS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </TextField>
          <Button variant="contained" disabled={busy} onClick={() => change("caps_add", `${type}=${perm}`)}>
            Thêm cap
          </Button>
        </Stack>
        <Stack component="form" onSubmit={addCustom} direction="row" spacing={1}>
          <TextField
            label="Cap tuỳ chỉnh (type=perm)"
            placeholder="usage=read"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            size="small"
            sx={{ minWidth: 368 }}
          />
          <Button type="submit" variant="outlined" disabled={busy || !custom.trim()}>
            Thêm cap tuỳ chỉnh
          </Button>
        </Stack>
      </Stack>
      <ErrorAlert error={error} />
    </Stack>
  );
}
