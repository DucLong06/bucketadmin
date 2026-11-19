import { Stack, TextField } from "@mui/material";
import type { Proxy } from "./api";
import { endpointError } from "./endpoint";

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
  /** Offer "Theo cài đặt chung" (per-cluster pickers). */
  inherit?: boolean;
  /** What the picker is for, in its accessible names (several pickers share a page). */
  name: string;
};

/** The three network modes, plus the proxy URL field when "Tùy chỉnh" is chosen. */
export function ProxyPicker({ value, onChange, inherit = false, name }: Props) {
  const urlError = value?.mode === "custom" && value.url ? endpointError(value.url) : null;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", flexGrow: 1 }}>
      <TextField
        select
        label="Proxy"
        value={proxyMode(value)}
        onChange={(e) => onChange(proxyOf(e.target.value))}
        size="small"
        sx={{ minWidth: 280 }}
        slotProps={{ ...native, inputLabel: { shrink: true }, htmlInput: { "aria-label": `Proxy ${name}` } }}
      >
        {inherit && <option value="inherit">Theo cài đặt chung</option>}
        <option value="auto">Tự động (theo biến môi trường)</option>
        <option value="none">Không dùng proxy</option>
        <option value="custom">Tùy chỉnh</option>
      </TextField>
      {value?.mode === "custom" && (
        <TextField
          label="URL proxy"
          placeholder="http://proxy:3128"
          value={value.url}
          onChange={(e) => onChange({ mode: "custom", url: e.target.value })}
          size="small"
          sx={{ flexGrow: 1 }}
          error={!!urlError}
          helperText={urlError ? "Nhập URL dạng http://proxy:3128" : undefined}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { "aria-label": `URL proxy ${name}` } }}
        />
      )}
    </Stack>
  );
}
