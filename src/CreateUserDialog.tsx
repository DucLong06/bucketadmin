import { type FormEvent, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
} from "@mui/material";
import { invoke, type UserInfo } from "./api";
import { useAction } from "./ui";

const empty = { uid: "", displayName: "", email: "", accessKey: "", secretKey: "" };

type Props = { clusterId: string; open: boolean; onClose: () => void; onCreated: (user: UserInfo) => void };

export default function CreateUserDialog({ clusterId, open, onClose, onCreated }: Props) {
  const [form, setForm] = useState(empty);
  const [autoKey, setAutoKey] = useState(true);
  const { busy, error, run, setError } = useAction();

  const close = () => {
    setForm(empty);
    setAutoKey(true);
    setError(null);
    onClose();
  };
  const ready =
    !!form.uid.trim() && !!form.displayName.trim() && (autoKey || (!!form.accessKey && !!form.secretKey));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { uid, displayName, email, accessKey, secretKey } = form;
    const manualKey = autoKey ? {} : { accessKey, secretKey };
    const user = await run(() =>
      invoke<UserInfo>("user_create", { clusterId, uid, displayName, email, ...manualKey }),
    );
    if (user) {
      close();
      onCreated(user);
    }
  }

  const field = (key: keyof typeof empty, label: string, extra: object = {}) => (
    <TextField
      label={label}
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      size="small"
      fullWidth
      {...extra}
    />
  );

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth aria-labelledby="create-user-title">
      <form onSubmit={submit}>
        <DialogTitle id="create-user-title">Tạo user</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {field("uid", "uid", { required: true, autoFocus: true })}
            {field("displayName", "Display name", { required: true })}
            {field("email", "Email (không bắt buộc)", { type: "email" })}
            <FormControlLabel
              control={<Checkbox checked={autoKey} onChange={(e) => setAutoKey(e.target.checked)} />}
              label="Tự sinh key (RGW tạo access key và secret key)"
            />
            {!autoKey && field("accessKey", "Access key", { required: true, autoComplete: "off" })}
            {!autoKey &&
              field("secretKey", "Secret key", { required: true, type: "password", autoComplete: "off" })}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Huỷ</Button>
          <Button type="submit" variant="contained" disabled={!ready || busy}>
            Tạo user
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
