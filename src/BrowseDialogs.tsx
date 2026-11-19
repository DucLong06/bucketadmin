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
import { invoke, keyOwner, type Profile } from "./api";
import { bucketNameError, folderNameError } from "./names";
import { ErrorAlert, useAction } from "./ui";

type BucketProps = {
  clusterId: string;
  /** The user who will own the bucket (the one being browsed as; empty: the caller's own key). */
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
              Bucket mới thuộc về {keyOwner(uid)} và được tạo bằng key của chính {keyOwner(uid)}.
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

type FolderProps = {
  clusterId: string;
  uid: string;
  bucket: string;
  /** The folder being browsed; the new folder is created inside it. */
  prefix: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

export function CreateFolderDialog({ clusterId, uid, bucket, prefix, open, onClose, onCreated }: FolderProps) {
  const [name, setName] = useState("");
  const { busy, error, run, setError } = useAction();
  const nameError = name ? folderNameError(name) : null;

  const close = () => {
    setName("");
    setError(null);
    onClose();
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    const at = { clusterId, uid, bucket, key: prefix };
    const done = await run(() => invoke<string>("browse_create_folder", { at, name }).then(() => true));
    if (done) {
      onCreated();
      close();
    }
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth aria-labelledby="create-folder-title">
      <form onSubmit={submit}>
        <DialogTitle id="create-folder-title">Tạo thư mục</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              S3 không có thư mục thật: app tạo một object rỗng tên{" "}
              <code>
                {prefix}
                {name.trim() || "<tên>"}/
              </code>{" "}
              trong bucket {bucket}, theo quy ước chung của các công cụ S3.
            </Typography>
            <TextField
              label="Tên thư mục"
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              fullWidth
              required
              autoFocus
              error={!!nameError}
              helperText={nameError ?? "Không chứa dấu /"}
            />
            <ErrorAlert error={error} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Huỷ</Button>
          <Button type="submit" variant="contained" disabled={busy || !name.trim() || !!nameError}>
            Tạo thư mục
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
