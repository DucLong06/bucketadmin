import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Box, Button, LinearProgress, Paper, Stack, Typography } from "@mui/material";
import { explain } from "./errors";
import { formatBytes } from "./format";

export type Transfer = {
  id: string;
  label: string;
  done: number;
  total: number;
  state: "running" | "done" | "error";
  /** Result line (where it was saved, how much was resumed) or the error. */
  note: string;
};
/** Runs a transfer; `run` receives the id the backend reports progress under. */
export type StartTransfer = <T>(label: string, run: (id: string) => Promise<T>, note?: (result: T) => string) => Promise<T | undefined>;

/** Uploads and downloads in progress; progress arrives as `transfer` events from the backend. */
export function useTransfers() {
  const [items, setItems] = useState<Transfer[]>([]);
  const patch = (id: string, change: Partial<Transfer>) =>
    setItems((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));

  useEffect(() => {
    const unlisten = listen<{ id: string; done: number; total: number }>("transfer", (e) =>
      patch(e.payload.id, { done: e.payload.done, total: e.payload.total }),
    );
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  const start: StartTransfer = async (label, run, note) => {
    const id = crypto.randomUUID();
    setItems((list) => [...list, { id, label, done: 0, total: 0, state: "running", note: "" }]);
    try {
      const result = await run(id);
      patch(id, { state: "done", note: note ? note(result) : "" });
      return result;
    } catch (e) {
      patch(id, { state: "error", note: explain(String(e)).message });
      return undefined;
    }
  };
  const clear = () => setItems((list) => list.filter((t) => t.state === "running"));
  return { items, start, clear };
}

export const percent = (done: number, total: number) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

export function TransferList({ items, onClear }: { items: Transfer[]; onClear: () => void }) {
  if (items.length === 0) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} aria-label="Upload và download">
      <Stack direction="row" sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle2" component="h2" sx={{ flexGrow: 1 }}>
          Upload / download
        </Typography>
        <Button size="small" onClick={onClear}>
          Xoá mục đã xong
        </Button>
      </Stack>
      <Stack spacing={1}>
        {items.map((t) => (
          <Box key={t.id}>
            <Stack direction="row" spacing={2}>
              <Typography variant="body2" sx={{ flexGrow: 1, fontFamily: "monospace", wordBreak: "break-all" }}>
                {t.label}
              </Typography>
              <Typography variant="body2" color={t.state === "error" ? "error" : "text.secondary"} sx={{ whiteSpace: "nowrap" }}>
                {t.state === "error"
                  ? "Lỗi"
                  : t.state === "done"
                    ? `Xong · ${formatBytes(t.total)}`
                    : `${percent(t.done, t.total)}% · ${formatBytes(t.done)} / ${formatBytes(t.total)}`}
              </Typography>
            </Stack>
            {t.state === "running" && (
              <LinearProgress
                variant={t.total > 0 ? "determinate" : "indeterminate"}
                value={percent(t.done, t.total)}
                aria-label={`Tiến độ ${t.label}`}
              />
            )}
            {t.note && (
              <Typography variant="body2" color={t.state === "error" ? "error" : "text.secondary"}>
                {t.note}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}
