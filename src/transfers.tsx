import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Alert, Box, Button, LinearProgress, Paper, Snackbar, Stack, Typography } from "@mui/material";
import { invoke } from "./api";
import { explain } from "./errors";
import { formatBytes } from "./format";

export type Transfer = {
  id: string;
  label: string;
  done: number;
  total: number;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  /** Result line (where it was saved, how much was resumed) or the error. */
  note: string;
};
/** Queues a transfer; `run` receives the id the backend reports progress under. Resolves when
 *  it has finished, with undefined when it failed or was cancelled. */
export type StartTransfer = <T>(label: string, run: (id: string) => Promise<T>, note?: (result: T) => string) => Promise<T | undefined>;
type Toast = { message: string; severity: "success" | "error" | "info" };
type Job = { id: string; begin: () => Promise<void>; skip: () => void };

/** Transfers running at the same time; the rest wait their turn. */
export const MAX_RUNNING = 3;

/** Takes from the front of `waiting` as many jobs as there are free slots. */
export function takeRunnable<T>(waiting: T[], running: number, max = MAX_RUNNING): T[] {
  return waiting.splice(0, Math.max(0, max - running));
}

/** The task queue of uploads and downloads; progress arrives as `transfer` events from the backend. */
export function useTransfers() {
  const [items, setItems] = useState<Transfer[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const waiting = useRef<Job[]>([]);
  const running = useRef(0);
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

  function pump() {
    for (const job of takeRunnable(waiting.current, running.current)) {
      running.current += 1;
      job.begin().finally(() => {
        running.current -= 1;
        pump();
      });
    }
  }

  const start: StartTransfer = (label, run, note) =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      setItems((list) => [...list, { id, label, done: 0, total: 0, state: "queued", note: "" }]);
      waiting.current.push({
        id,
        begin: async () => {
          patch(id, { state: "running" });
          try {
            const result = await run(id);
            patch(id, { state: "done", note: note ? note(result) : "" });
            setToast({ message: `Xong: ${label}`, severity: "success" });
            resolve(result);
          } catch (e) {
            // The backend answers exactly "cancelled" when it stopped on request.
            const cancelled = String(e) === "cancelled";
            patch(id, cancelled ? { state: "cancelled", note: "Đã huỷ." } : { state: "error", note: explain(String(e)).message });
            setToast(cancelled ? { message: `Đã huỷ: ${label}`, severity: "info" } : { message: `Lỗi: ${label}`, severity: "error" });
            resolve(undefined);
          }
        },
        skip: () => {
          patch(id, { state: "cancelled", note: "Đã huỷ khi còn trong hàng đợi." });
          resolve(undefined);
        },
      });
      pump();
    });

  /** A queued task is dropped; a running one is asked to stop at its next part. */
  function cancel(id: string) {
    const at = waiting.current.findIndex((job) => job.id === id);
    if (at >= 0) waiting.current.splice(at, 1)[0].skip();
    else invoke("browse_cancel", { transferId: id });
  }
  const clear = () => setItems((list) => list.filter((t) => t.state === "queued" || t.state === "running"));
  return { items, start, cancel, clear, toast, closeToast: () => setToast(null) };
}

export const percent = (done: number, total: number) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

const STATE_TEXT: Record<Transfer["state"], string> = {
  queued: "Đang chờ",
  running: "Đang chạy",
  done: "Xong",
  error: "Lỗi",
  cancelled: "Đã huỷ",
};

export function TaskPanel({ tasks }: { tasks: ReturnType<typeof useTransfers> }) {
  const { items, cancel, clear, toast, closeToast } = tasks;
  const count = (state: Transfer["state"]) => items.filter((t) => t.state === state).length;
  return (
    <>
      {items.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }} aria-label="Tasks">
          <Stack direction="row" sx={{ alignItems: "center", mb: 1 }}>
            <Typography variant="subtitle2" component="h2" sx={{ flexGrow: 1 }}>
              Tasks — {count("running")} đang chạy, {count("queued")} đang chờ (tối đa {MAX_RUNNING} cùng lúc)
            </Typography>
            <Button size="small" onClick={clear}>
              Xoá mục đã xong
            </Button>
          </Stack>
          <Stack spacing={1}>
            {items.map((t) => {
              const active = t.state === "queued" || t.state === "running";
              const bad = t.state === "error";
              return (
                <Box key={t.id}>
                  <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                    <Typography variant="body2" sx={{ flexGrow: 1, fontFamily: "monospace", wordBreak: "break-all" }}>
                      {t.label}
                    </Typography>
                    <Typography variant="body2" color={bad ? "error" : "text.secondary"} sx={{ whiteSpace: "nowrap" }}>
                      {t.state === "running"
                        ? `${percent(t.done, t.total)}% · ${formatBytes(t.done)} / ${formatBytes(t.total)}`
                        : t.state === "done"
                          ? `Xong · ${formatBytes(t.total)}`
                          : STATE_TEXT[t.state]}
                    </Typography>
                    {active && (
                      <Button size="small" color="error" onClick={() => cancel(t.id)} aria-label={`Huỷ ${t.label}`}>
                        Huỷ
                      </Button>
                    )}
                  </Stack>
                  {t.state === "running" && (
                    <LinearProgress
                      variant={t.total > 0 ? "determinate" : "indeterminate"}
                      value={percent(t.done, t.total)}
                      aria-label={`Tiến độ ${t.label}`}
                    />
                  )}
                  {t.note && (
                    <Typography variant="body2" color={bad ? "error" : "text.secondary"}>
                      {t.note}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Paper>
      )}
      <Snackbar open={toast !== null} autoHideDuration={5000} onClose={closeToast} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity={toast?.severity ?? "info"} variant="filled" onClose={closeToast} sx={{ wordBreak: "break-all" }}>
          {toast?.message}
        </Alert>
      </Snackbar>
    </>
  );
}
