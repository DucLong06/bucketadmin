import { type FormEvent, useState } from "react";
import { Alert, Box, Button, Divider, FormControlLabel, Stack, Switch, TextField } from "@mui/material";
import { invoke, type UserInfo } from "./api";
import { ConfirmDialog, useAction } from "./ui";
import type { UserTabProps } from "./UserDrawer";

export default function InfoTab({ clusterId, uid, user, onUser, onDeleted }: UserTabProps) {
  const [displayName, setDisplayName] = useState(user.display_name);
  const [email, setEmail] = useState(user.email);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<"suspend" | "delete" | null>(null);
  const { busy, error, run, setError } = useAction();

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const updated = await run(() => invoke<UserInfo>("user_modify", { clusterId, uid, displayName, email }));
    if (updated) {
      onUser(updated);
      setSaved(true);
    }
  }

  async function setSuspended(suspended: boolean) {
    const updated = await run(() => invoke<UserInfo>("user_set_suspended", { clusterId, uid, suspended }));
    if (updated) {
      onUser(updated);
      setConfirm(null);
    }
  }

  async function remove() {
    const done = await run(() => invoke("user_delete", { clusterId, uid }).then(() => true));
    if (done) onDeleted();
  }

  const closeConfirm = () => {
    setConfirm(null);
    setError(null);
  };

  return (
    <Stack spacing={3}>
      <Stack component="form" onSubmit={save} spacing={2}>
        <TextField
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          size="small"
          required
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          size="small"
          helperText="Để trống để xoá email"
        />
        <Box>
          <Button type="submit" variant="contained" disabled={busy || !displayName.trim()}>
            Lưu thay đổi
          </Button>
        </Box>
        {saved && <Alert severity="success">Đã lưu.</Alert>}
      </Stack>
      <Divider />
      <FormControlLabel
        control={
          <Switch
            checked={!!user.suspended}
            disabled={busy}
            onChange={(e) => (e.target.checked ? setConfirm("suspend") : setSuspended(false))}
          />
        }
        label="Suspended (user bị khoá, không truy cập được S3)"
      />
      <Divider />
      <Box>
        <Button color="error" variant="outlined" onClick={() => setConfirm("delete")}>
          Xoá user
        </Button>
      </Box>
      {error && confirm === null && <Alert severity="error">{error}</Alert>}

      <ConfirmDialog
        open={confirm === "suspend"}
        title="Suspend user?"
        text={`User ${uid} sẽ không truy cập được S3 cho đến khi được enable lại.`}
        confirmLabel="Suspend"
        busy={busy}
        error={error}
        onConfirm={() => setSuspended(true)}
        onClose={closeConfirm}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title="Xoá user?"
        text={`Thao tác này xoá vĩnh viễn user ${uid} cùng toàn bộ key của user. RGW sẽ từ chối nếu user còn bucket.`}
        confirmLabel="Xoá user"
        requireText={uid}
        busy={busy}
        error={error}
        onConfirm={remove}
        onClose={closeConfirm}
      />
    </Stack>
  );
}
