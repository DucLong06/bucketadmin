import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { KeyPair, Profile } from "./api";
import { capsCommand } from "./caps";
import { explain } from "./errors";
import { setLang, t, useLang } from "./i18n";
import { eyebrow, setMode, useMode } from "./theme";

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

/** Above this many connections a plain list is too long to scan: lists of connections become searchable. */
export const SEARCH_ABOVE = 8;
/** Connections whose label, endpoint or key contains `text`, whatever the case. */
export const filterProfiles = (profiles: Profile[], text: string): Profile[] => {
  const wanted = text.trim().toLowerCase();
  return wanted ? profiles.filter((p) => [p.label, p.endpoint, p.access_key, p.browse_access_key ?? ""].some((field) => field.toLowerCase().includes(wanted))) : profiles;
};
/** Labels that more than one connection has (allowed, but worth a warning: the lists show labels). */
export const duplicateLabels = (profiles: Profile[]): Set<string> => {
  const labels = profiles.map((p) => p.label.trim().toLowerCase());
  return new Set(labels.filter((label, i) => labels.indexOf(label) !== i));
};

/** The connection of a tab. A short list is a plain select; a long one is searched by typing a
 *  part of a label or of an endpoint, and each choice shows its endpoint (labels may repeat). */
export function ClusterSelect(props: { profiles: Profile[]; value: string; onChange: (id: string) => void }) {
  const picked = props.profiles.find((p) => p.id === props.value);
  // A reload of the profiles brings new objects; a new `value` object makes MUI put the text being typed back to the label.
  const value = useMemo(() => picked, [picked?.id, picked?.label, picked?.endpoint]);
  if (props.profiles.length > SEARCH_ABOVE) {
    return (
      <Autocomplete
        size="small"
        disableClearable
        autoHighlight
        options={props.profiles}
        value={value}
        onChange={(_, picked) => picked && props.onChange(picked.id)}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        getOptionLabel={(p) => p.label}
        filterOptions={(options, state) => filterProfiles(options, state.inputValue)}
        noOptionsText={t("conn.noMatch")}
        renderOption={({ key: _, ...row }, p) => (
          <Box component="li" key={p.id} {...row} sx={{ minHeight: 40, display: "block !important" }}>
            <Typography noWrap sx={{ fontSize: 15 }}>
              {p.label}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {p.endpoint}
            </Typography>
          </Box>
        )}
        renderInput={(params) => <TextField {...params} label={t("common.connection")} placeholder={t("conn.search")} />}
        sx={{ minWidth: 200 }}
      />
    );
  }
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

/** Light theme on or off (off = dark): switches the whole app at once and saves the choice. */
export function ThemeSwitch() {
  const mode = useMode();
  return <FormControlLabel sx={{ minHeight: 40, mr: 0 }} control={<Switch checked={mode === "light"} onChange={(_, on) => setMode(on ? "light" : "dark")} />} label={t("settings.lightTheme")} />;
}

/** A pushpin: filled for a place that is pinned, an outline for one that could be. */
export const PinIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
    <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
    <path d="M12 14v7" />
  </svg>
);

/** Heading of a sidebar card that folds to this one line. The heading itself is the button;
 *  `action` (a control of the card) sits at its end, outside the button. `controls`: id of the body. */
export function FoldHeading({ title, open, onToggle, controls, action }: { title: string; open: boolean; onToggle: () => void; controls: string; action?: ReactNode }) {
  return (
    <Stack direction="row" sx={{ alignItems: "center", pr: action ? 0.75 : 0 }}>
      <Box component="h2" sx={{ flexGrow: 1, minWidth: 0, m: 0 }}>
        <ButtonBase
          aria-expanded={open}
          aria-controls={controls}
          title={t(open ? "sidebar.fold" : "sidebar.unfold", { title })}
          onClick={onToggle}
          sx={{ ...eyebrow, width: "100%", minHeight: 48, justifyContent: "flex-start", gap: 1, pl: 2, pr: 1, borderRadius: "16px", color: "text.secondary", fontFamily: "inherit", "&:hover": { color: "text.primary" } }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}>
            <path d="M9 5l7 7-7 7" />
          </svg>
          {title}
        </ButtonBase>
      </Box>
      {action}
    </Stack>
  );
}

/** Pins or unpins one place: amber and filled while pinned. `label` names the place for a screen reader and the tooltip. */
export function PinToggle({ pinned, label, onToggle, size = 32 }: { pinned: boolean; label: string; onToggle: () => void; size?: number }) {
  return (
    <IconButton
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      onClick={(e) => {
        // Inside a row or a menu item: the click is for the pin, not for the place.
        e.stopPropagation();
        onToggle();
      }}
      // Small to look at, 40 × 40 to hit.
      sx={{ width: size, height: size, color: pinned ? "primary.main" : "text.secondary", "&::after": { content: '""', position: "absolute", inset: (size - 40) / 2 } }}
    >
      <PinIcon filled={pinned} />
    </IconButton>
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
  /** "primary" for a confirmation that destroys nothing (the default is the red of a delete). */
  tone?: "error" | "primary";
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
          {/* A delete of many objects takes its time: the dialog says it is at work. */}
          {props.busy && <LinearProgress aria-label={t("ui.working")} />}
          <ErrorAlert error={props.error} />
        </Stack>
      </DialogContent>
      <DialogActions>
        {/* The keyboard starts on the safe choice (or in the field to type in): Enter never destroys by accident. */}
        <Button onClick={close} autoFocus={props.requireText === undefined}>
          {t("common.cancel")}
        </Button>
        <Button
          color={props.tone ?? "error"}
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
