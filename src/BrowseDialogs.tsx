import { type FormEvent, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { invoke, type Profile } from "./api";
import { t } from "./i18n";
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
        <DialogTitle id="create-bucket-title">{t("browse.createBucket")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {uid ? t("dialogs.bucketOwnerUser", { uid }) : t("dialogs.bucketOwnerMine")}
            </Typography>
            <TextField
              label={t("dialogs.bucketName")}
              value={name}
              onChange={(e) => setName(e.target.value.trim())}
              size="small"
              fullWidth
              required
              autoFocus
              error={!!nameError}
              helperText={nameError ?? t("dialogs.bucketNameHelp")}
              slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
            />
            <FormControlLabel
              control={<Switch checked={versioning} onChange={(e) => setVersioning(e.target.checked)} />}
              label={t("dialogs.versioningSwitch")}
            />
            {busy && <LinearProgress aria-label={t("ui.working")} />}
            <ErrorAlert error={error} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button type="submit" variant="contained" disabled={busy || !name || !!nameError}>
            {t("browse.createBucket")}
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
        <DialogTitle id="create-folder-title">{t("browse.createFolder")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {t("dialogs.folderExplain.before")}{" "}
              <code>
                {prefix}
                {name.trim() || t("dialogs.folderNamePlaceholder")}/
              </code>{" "}
              {t("dialogs.folderExplain.after", { bucket })}
            </Typography>
            <TextField
              label={t("dialogs.folderName")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              fullWidth
              required
              autoFocus
              error={!!nameError}
              helperText={nameError ?? t("dialogs.folderNameHelp")}
            />
            {busy && <LinearProgress aria-label={t("ui.working")} />}
            <ErrorAlert error={error} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button type="submit" variant="contained" disabled={busy || !name.trim() || !!nameError}>
            {t("browse.createFolder")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
