import { type FormEvent, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import { invoke } from "./api";
import { accessKeyError, secretKeyError } from "./keys";
import { ErrorAlert, useAction } from "./ui";

type Props = {
  clusterId: string;
  uid: string;
  /** Access keys the user already has: RGW would silently replace the secret of a matching one. */
  existing: string[];
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
};

/** Adds an existing access/secret pair to a user (nothing is generated). */
export default function AddKeyDialog({ clusterId, uid, existing, open, onClose, onAdded }: Props) {
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const { busy, error, run, setError } = useAction();

  const close = () => {
    setAccessKey("");
    setSecretKey("");
    setError(null);
    onClose();
  };
  const duplicate = existing.includes(accessKey);
  const accessError = accessKey ? (duplicate ? "User đã có access key này. Dùng Rotate nếu muốn đổi secret." : accessKeyError(accessKey)) : null;
  const secretError = secretKey ? secretKeyError(secretKey) : null;
  const ready = !!accessKey && !!secretKey && !accessError && !secretError;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const done = await run(() => invoke("key_add", { clusterId, uid, accessKey, secretKey }).then(() => true));
    if (done) {
      close();
      onAdded();
    }
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth aria-labelledby="add-key-title">
      <form onSubmit={submit}>
        <DialogTitle id="add-key-title">Thêm key có sẵn</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Gắn một cặp access key / secret key đã có cho user {uid}. Không có key nào được sinh mới.
            </Typography>
            <TextField
              label="Access key"
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value.trim())}
              size="small"
              fullWidth
              required
              autoFocus
              autoComplete="off"
              error={!!accessError}
              helperText={accessError ?? "16–128 ký tự chữ và số"}
            />
            <TextField
              label="Secret key"
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value.trim())}
              size="small"
              fullWidth
              required
              autoComplete="off"
              error={!!secretError}
              helperText={secretError ?? "32–128 ký tự: chữ, số và / + ="}
            />
            <ErrorAlert error={error} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Huỷ</Button>
          <Button type="submit" variant="contained" disabled={!ready || busy}>
            Thêm key
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
