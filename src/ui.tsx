import { createContext, type ReactNode, useContext, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { KeyPair, Profile } from "./api";
import { capsCommand } from "./caps";
import { explain } from "./errors";
import { setLang, t, useLang } from "./i18n";

/** uid the connected cluster key belongs to ("" while unknown); App provides it. */
export const CallerContext = createContext("");

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
      label={t("common.connection")}
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

/** Backend error in the current language, with the error code and the original text one click away.
 *  A refusal for missing admin caps also shows the command that grants them. `children`: what the
 *  screen has to add to the sentence (a way out), shown right under it. */
export function ErrorAlert({ error, sx, children }: { error: string | null | undefined; sx?: object; children?: ReactNode }) {
  const callerUid = useContext(CallerContext);
  if (!error) return null;
  const { message, code, detail, caps } = explain(error);
  const command = caps && capsCommand(callerUid, caps);
  return (
    <Alert severity="error" sx={sx}>
      {message}
      {children}
      {command && (
        <>
          <div style={{ marginTop: 4 }}>{t(callerUid ? "ui.capsAsk" : "ui.capsAskUid")}</div>
          {/* One line, scrolled when narrow: a wrapped command reads as two when retyped by hand. */}
          <code style={{ display: "block", whiteSpace: "nowrap", overflowX: "auto" }}>{command}</code>
          <CopyButton value={command} label={t("ui.capsCopy")} />
        </>
      )}
      {message !== detail && (
        <details style={{ marginTop: 4 }}>
          <summary>{code ? t("ui.detailsCode", { code }) : t("ui.details")}</summary>
          <code style={{ wordBreak: "break-word" }}>{detail}</code>
        </details>
      )}
    </Alert>
  );
}

/** VI | EN: switches the language of the whole app at once and saves the choice. */
export function LangToggle() {
  const lang = useLang();
  return (
    <ToggleButtonGroup size="small" exclusive value={lang} onChange={(_, next) => next && setLang(next)} aria-label={t("settings.language")}>
      <ToggleButton value="vi" aria-label={t("lang.vi")} sx={{ px: 1.5 }}>
        VI
      </ToggleButton>
      <ToggleButton value="en" aria-label={t("lang.en")} sx={{ px: 1.5 }}>
        EN
      </ToggleButton>
    </ToggleButtonGroup>
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
      {copied ? t("common.copied") : t("common.copy")}
    </Button>
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
              label={t("ui.typeToConfirm", { text: props.requireText })}
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
        <Button onClick={close}>{t("common.cancel")}</Button>
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
