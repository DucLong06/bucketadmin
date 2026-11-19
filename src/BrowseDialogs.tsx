import { type FormEvent, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { invoke } from "./api";
import { bucketNameError } from "./names";
import { ErrorAlert, useAction } from "./ui";

type BucketProps = {
  clusterId: string;
  /** The user who will own the bucket (the one being browsed as). */
  uid: string;
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
};

export function CreateBucketDialog({ clusterId, uid, open, onClose, onCreated }: BucketProps) {
  const [name, setName] = useState("");
  const [versioning, setVersioning] = useState(false);
  const { busy, error, run, setError } = useAction();
  const nameError = name ? bucketNameError(name) : null;

  const close = () => {
    setName("");
    setVersioning(false);
    setError(null);
    onClose();
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const at = { clusterId, uid, bucket: name };
    const done = await run(() => invoke("browse_create_bucket", { at, versioning }).then(() => true));
    if (done) {
      onCreated(name);
      close();
    }
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth aria-labelledby="create-bucket-title">
      <form onSubmit={submit}>
        <DialogTitle id="create-bucket-title">Tạo bucket</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Bucket mới thuộc về user {uid} và được tạo bằng key của chính user đó.
            </Typography>
            <TextField
              label="Tên bucket"
              value={name}
              onChange={(e) => setName(e.target.value.trim())}
              size="small"
              fullWidth
              required
              autoFocus
              error={!!nameError}
              helperText={nameError ?? "3–63 ký tự: chữ thường, số, dấu chấm, dấu gạch ngang"}
              slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
            />
            <FormControlLabel
              control={<Switch checked={versioning} onChange={(e) => setVersioning(e.target.checked)} />}
              label="Bật versioning (mặc định tắt)"
            />
            <ErrorAlert error={error} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Huỷ</Button>
          <Button type="submit" variant="contained" disabled={busy || !name || !!nameError}>
            Tạo bucket
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
