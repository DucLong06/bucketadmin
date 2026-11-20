import { Stack, TextField } from "@mui/material";
import type { Proxy } from "./api";
import { endpointError } from "./endpoint";
import { t } from "./i18n";

const native = { select: { native: true } };

/** Null (follow the app-wide setting) or a mode that is complete: a custom proxy needs a usable URL. */
export const proxyReady = (p: Proxy | null) => p?.mode !== "custom" || (p.url.trim() !== "" && endpointError(p.url) === null);
export const sameProxy = (a: Proxy | null, b: Proxy | null) => JSON.stringify(a) === JSON.stringify(b);
/** The select's value for a choice; "inherit" stands for null. */
export const proxyMode = (p: Proxy | null) => p?.mode ?? "inherit";
export const proxyOf = (mode: string, url = ""): Proxy | null =>
  mode === "inherit" ? null : mode === "custom" ? { mode, url } : { mode: mode as "auto" | "none" };

type Props = {
  /** Null = follow the app-wide setting; only offered with `inherit`. */
  value: Proxy | null;
  onChange: (next: Proxy | null) => void;
  /** Offer "follow the general setting" (per-connection pickers). */
  inherit?: boolean;
  /** What the picker is for, already in the UI's language; part of its accessible names (several pickers share a page). */
  name: string;
};

/** The three network modes, plus the proxy URL field when "custom" is chosen. */
export function ProxyPicker({ value, onChange, inherit = false, name }: Props) {
  const urlError = value?.mode === "custom" && value.url ? endpointError(value.url) : null;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", flexGrow: 1 }}>
      <TextField
        select
        label={t("proxy.label")}
        value={proxyMode(value)}
        onChange={(e) => onChange(proxyOf(e.target.value))}
        size="small"
        sx={{ minWidth: 280 }}
        slotProps={{ ...native, inputLabel: { shrink: true }, htmlInput: { "aria-label": t("proxy.aria", { name }) } }}
      >
        {inherit && <option value="inherit">{t("proxy.inherit")}</option>}
        <option value="auto">{t("proxy.auto")}</option>
        <option value="none">{t("proxy.none")}</option>
        <option value="custom">{t("proxy.custom")}</option>
      </TextField>
      {value?.mode === "custom" && (
        <TextField
          label={t("proxy.url")}
          placeholder="http://proxy:3128"
          value={value.url}
          onChange={(e) => onChange({ mode: "custom", url: e.target.value })}
          size="small"
          sx={{ flexGrow: 1 }}
          error={!!urlError}
          helperText={urlError ? t("proxy.urlHelp") : undefined}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { "aria-label": t("proxy.urlAria", { name }) } }}
        />
      )}
    </Stack>
  );
}
