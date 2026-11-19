import { type ReactNode, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { KeyPair, Profile } from "./api";
import { explain } from "./errors";

/** Runs backend calls with shared busy/error state; resolves to undefined when the call failed. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(call: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await call();
    } catch (e) {
      setError(String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function ClusterSelect(props: { profiles: Profile[]; value: string; onChange: (id: string) => void }) {
  return (
    <TextField
      select
      label="Cluster"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      size="small"
      sx={{ minWidth: 200 }}
      slotProps={{ select: { native: true } }}
    >
      {props.profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </TextField>
  );
}

/** Backend error in Vietnamese, with the error code and the original text one click away. */
export function ErrorAlert({ error, sx }: { error: string | null | undefined; sx?: object }) {
  if (!error) return null;
  const { message, code, detail } = explain(error);
  return (
    <Alert severity="error" sx={sx}>
      {message}
      {message !== detail && (
        <details style={{ marginTop: 4 }}>
          <summary>Chi tiết kỹ thuật{code ? ` (${code})` : ""}</summary>
          <code style={{ wordBreak: "break-word" }}>{detail}</code>
        </details>
      )}
    </Alert>
  );
}

/** Puts text on the clipboard. */
export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // WebKitGTK can refuse the async clipboard API; fall back to the legacy command.
    const area = document.createElement("textarea");
    area.value = value;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await copyText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <Button size="small" onClick={copy} aria-label={label} sx={{ whiteSpace: "nowrap", minWidth: 88 }}>
      {copied ? "Đã copy" : "Copy"}
    </Button>
  );
}

const readOnly = { input: { readOnly: true, sx: { fontFamily: "monospace" } } };

/** Shows freshly created keys. The secret is not stored anywhere, so this is the only chance to copy it. */
export function SecretDialog(props: {
  keys: KeyPair[] | null;
  warning?: string | null;
  /** Label of the non-secret half; Swift keys are identified by their user, not an access key. */
  accessLabel?: string;
  onClose: () => void;
}) {
  const [show, setShow] = useState(false);
  const keys = props.keys ?? [];
  const close = () => {
    setShow(false);
    props.onClose();
  };
  return (
    <Dialog open={props.keys !== null} maxWidth="sm" fullWidth aria-labelledby="secret-title">
      <DialogTitle id="secret-title">Key mới — hãy lưu lại ngay</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">
            Secret key chỉ hiển thị một lần duy nhất. Sau khi đóng hộp thoại này sẽ không xem lại được.
          </Alert>
          <ErrorAlert error={props.warning} />
          {keys.length === 0 && <Typography>User được tạo không kèm key nào.</Typography>}
          {keys.map((k) => (
            <Stack key={k.access_key} spacing={1}>
              <Stack direction="row" spacing={1}>
                <TextField
                  label={props.accessLabel ?? "Access key"}
                  value={k.access_key}
                  size="small"
                  fullWidth
                  slotProps={readOnly}
                />
                <CopyButton value={k.access_key} label={`Copy ${(props.accessLabel ?? "access key").toLowerCase()}`} />
              </Stack>
              <Stack direction="row" spacing={1}>
                <TextField
                  label="Secret key"
                  value={k.secret_key}
                  type={show ? "text" : "password"}
                  size="small"
                  fullWidth
                  slotProps={readOnly}
                />
                <Button size="small" onClick={() => setShow(!show)}>
                  {show ? "Ẩn" : "Hiện"}
                </Button>
                <CopyButton value={k.secret_key} label="Copy secret key" />
              </Stack>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={close}>
          Đã lưu, đóng
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type ConfirmProps = {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  /** When set, the user must type this exact text before the confirm button is enabled. */
  requireText?: string;
  busy?: boolean;
  error?: string | null;
  /** Extra controls shown under the text, e.g. an option that changes what the confirmation does. */
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConfirmDialog(props: ConfirmProps) {
  const [typed, setTyped] = useState("");
  const close = () => {
    setTyped("");
    props.onClose();
  };
  const blocked = props.busy || (props.requireText !== undefined && typed !== props.requireText);
  return (
    <Dialog open={props.open} onClose={close} maxWidth="xs" fullWidth aria-labelledby="confirm-title">
      <DialogTitle id="confirm-title">{props.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography>{props.text}</Typography>
          {props.children}
          {props.requireText !== undefined && (
            <TextField
              label={`Gõ "${props.requireText}" để xác nhận`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              size="small"
              autoFocus
              fullWidth
            />
          )}
          <ErrorAlert error={props.error} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Huỷ</Button>
        <Button
          color="error"
          variant="contained"
          disabled={blocked}
          onClick={() => {
            setTyped("");
            props.onConfirm();
          }}
        >
          {props.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
