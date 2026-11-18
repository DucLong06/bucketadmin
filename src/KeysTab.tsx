import { useState } from "react";
import { Alert, Box, Button, Paper, Stack, Typography } from "@mui/material";
import { invoke, type KeyPair } from "./api";
import { ConfirmDialog, CopyButton, SecretDialog, useAction } from "./ui";
import type { UserTabProps } from "./UserDrawer";

type Rotated = { key: KeyPair; remove_error: string | null };
type Pending = { kind: "rotate" | "remove"; accessKey: string };

export default function KeysTab({ clusterId, uid, user, refresh }: UserTabProps) {
  const [fresh, setFresh] = useState<{ keys: KeyPair[]; warning: string | null } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const { busy, error, run, setError } = useAction();

  async function create() {
    const key = await run(() => invoke<KeyPair>("key_create", { clusterId, uid }));
    if (key) {
      setFresh({ keys: [key], warning: null });
      await refresh();
    }
  }

  async function confirmed() {
    if (!pending) return;
    const { kind, accessKey } = pending;
    if (kind === "remove") {
      const done = await run(() => invoke("key_remove", { clusterId, uid, accessKey }).then(() => true));
      if (!done) return;
    } else {
      const rotated = await run(() => invoke<Rotated>("key_rotate", { clusterId, uid, accessKey }));
      if (!rotated) return;
      const warning = rotated.remove_error
        ? `Key mới đã được tạo nhưng chưa xoá được key cũ ${accessKey}: ${rotated.remove_error}`
        : null;
      setFresh({ keys: [rotated.key], warning });
    }
    setPending(null);
    await refresh();
  }

  const closeConfirm = () => {
    setPending(null);
    setError(null);
  };

  return (
    <Stack spacing={2}>
      {user.keys.length === 0 && <Typography color="text.secondary">User chưa có key nào.</Typography>}
      <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {user.keys.map((k) => (
          <Paper key={k.access_key} component="li" variant="outlined" sx={{ px: 2, py: 1 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography sx={{ flexGrow: 1, fontFamily: "monospace" }}>{k.access_key}</Typography>
              <CopyButton value={k.access_key} label={`Copy access key ${k.access_key}`} />
              <Button
                size="small"
                onClick={() => setPending({ kind: "rotate", accessKey: k.access_key })}
                aria-label={`Rotate key ${k.access_key}`}
              >
                Rotate
              </Button>
              <Button
                size="small"
                color="error"
                onClick={() => setPending({ kind: "remove", accessKey: k.access_key })}
                aria-label={`Xoá key ${k.access_key}`}
              >
                Xoá
              </Button>
            </Stack>
          </Paper>
        ))}
      </Stack>
      <Box>
        <Button variant="contained" onClick={create} disabled={busy}>
          Tạo key mới
        </Button>
      </Box>
      {error && pending === null && <Alert severity="error">{error}</Alert>}

      <ConfirmDialog
        open={pending?.kind === "rotate"}
        title="Rotate key?"
        text={`Tạo một key mới rồi xoá key ${pending?.accessKey}. Ứng dụng đang dùng key cũ sẽ mất quyền truy cập ngay.`}
        confirmLabel="Rotate"
        busy={busy}
        error={error}
        onConfirm={confirmed}
        onClose={closeConfirm}
      />
      <ConfirmDialog
        open={pending?.kind === "remove"}
        title="Xoá key?"
        text={`Key ${pending?.accessKey} sẽ bị xoá và không dùng được nữa.`}
        confirmLabel="Xoá key"
        busy={busy}
        error={error}
        onConfirm={confirmed}
        onClose={closeConfirm}
      />
      <SecretDialog keys={fresh?.keys ?? null} warning={fresh?.warning} onClose={() => setFresh(null)} />
    </Stack>
  );
}
