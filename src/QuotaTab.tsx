import { type FormEvent, useEffect, useState } from "react";
import { Alert, Box, Button, FormControlLabel, LinearProgress, Paper, Stack, Switch, TextField, Typography } from "@mui/material";
import { invoke, type Quota } from "./api";
import { useAction } from "./ui";
import type { UserTabProps } from "./UserDrawer";

type QuotaType = "user" | "bucket";
type Quotas = Record<QuotaType, Quota>;
type FormProps = {
  title: string;
  hint: string;
  quota: Quota;
  busy: boolean;
  saved: boolean;
  onSave: (enabled: boolean, maxSizeKb: number, maxObjects: number) => void;
};

// RGW reports "unlimited" as a negative max_size with max_size_kb = 0; the form shows -1 for it.
const sizeKb = (q: Quota) => (q.max_size < 0 ? -1 : q.max_size_kb);
const isInt = (text: string) => /^-?\d+$/.test(text.trim());

function QuotaForm({ title, hint, quota, busy, saved, onSave }: FormProps) {
  const [enabled, setEnabled] = useState(quota.enabled);
  const [size, setSize] = useState(String(sizeKb(quota)));
  const [objects, setObjects] = useState(String(quota.max_objects < 0 ? -1 : quota.max_objects));
  const valid = isInt(size) && isInt(objects);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(enabled, Number(size), Number(objects));
  }

  return (
    <Paper component="form" onSubmit={submit} variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="subtitle1" component="h3">
            {title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {hint}
          </Typography>
        </Box>
        <FormControlLabel
          control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />}
          label="Bật quota"
        />
        <Stack direction="row" spacing={2}>
          <TextField
            label="Max size (KB)"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            size="small"
            error={!isInt(size)}
            helperText="-1 = không giới hạn"
            slotProps={{ htmlInput: { inputMode: "numeric" } }}
          />
          <TextField
            label="Max objects"
            value={objects}
            onChange={(e) => setObjects(e.target.value)}
            size="small"
            error={!isInt(objects)}
            helperText="-1 = không giới hạn"
            slotProps={{ htmlInput: { inputMode: "numeric" } }}
          />
        </Stack>
        <Box>
          <Button type="submit" variant="contained" disabled={busy || !valid}>
            Lưu quota
          </Button>
        </Box>
        {saved && <Alert severity="success">Đã lưu quota.</Alert>}
      </Stack>
    </Paper>
  );
}

export default function QuotaTab({ clusterId, uid }: UserTabProps) {
  const [quotas, setQuotas] = useState<Quotas | null>(null);
  const [saved, setSaved] = useState<QuotaType | null>(null);
  const { busy, error, run } = useAction();

  const load = async () => {
    const loaded = await run(() => invoke<Quotas>("quota_get", { clusterId, uid }));
    if (loaded) setQuotas(loaded);
  };
  useEffect(() => {
    load();
  }, []);

  async function save(quotaType: QuotaType, enabled: boolean, maxSizeKb: number, maxObjects: number) {
    setSaved(null);
    const done = await run(() =>
      invoke("quota_set", { clusterId, uid, quotaType, enabled, maxSizeKb, maxObjects }).then(() => true),
    );
    if (done) {
      await load(); // show what RGW actually stored
      setSaved(quotaType);
    }
  }

  const form = (quotaType: QuotaType, title: string, hint: string) =>
    quotas && (
      <QuotaForm
        // Remount when RGW's values change so the fields show the stored state.
        // The type is part of the key: both quotas often hold identical values.
        key={quotaType + JSON.stringify(quotas[quotaType])}
        title={title}
        hint={hint}
        quota={quotas[quotaType]}
        busy={busy}
        saved={saved === quotaType}
        onSave={(enabled, size, objects) => save(quotaType, enabled, size, objects)}
      />
    );

  return (
    <Stack spacing={2}>
      {busy && <LinearProgress aria-label="Đang tải quota" />}
      {error && <Alert severity="error">{error}</Alert>}
      {form("user", "User quota", "Giới hạn tổng cho toàn bộ dữ liệu của user.")}
      {form("bucket", "Bucket quota", "Giới hạn áp cho từng bucket do user sở hữu.")}
    </Stack>
  );
}
