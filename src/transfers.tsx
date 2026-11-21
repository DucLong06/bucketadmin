import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Alert, Box, Button, LinearProgress, Paper, Snackbar, Stack, Typography } from "@mui/material";
import { invoke } from "./api";
import { explain } from "./errors";
import { formatBytes, TZ, vnTime } from "./format";
import { t } from "./i18n";

export type Transfer = {
  id: string;
  label: string;
  done: number;
  total: number;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  /** Result line (where it was saved, how much was resumed); worded when shown, so it follows the language. */
  note?: () => string;
  /** The backend's own text of a failure; shown through `explain`. */
  error?: string;
  /** When it was queued (epoch ms). */
  at: number;
};
/** Queues a transfer; `run` receives the id the backend reports progress under. Resolves when
 *  it has finished, with undefined when it failed or was cancelled. */
export type StartTransfer = <T>(label: string, run: (id: string) => Promise<T>, note?: (result: T) => string) => Promise<T | undefined>;
type Toast = { state: "done" | "cancelled" | "error"; label: string };
const TOAST_SEVERITY = { done: "success", cancelled: "info", error: "error" } as const;
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
    setItems((list) => list.map((task) => (task.id === id ? { ...task, ...change } : task)));

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
      setItems((list) => [...list, { id, label, done: 0, total: 0, state: "queued", at: Date.now() }]);
      waiting.current.push({
        id,
        begin: async () => {
          patch(id, { state: "running" });
          try {
            const result = await run(id);
            patch(id, { state: "done", note: note && (() => note(result)) });
            setToast({ state: "done", label });
            resolve(result);
          } catch (e) {
            // The backend answers exactly "cancelled" when it stopped on request.
            const cancelled = String(e) === "cancelled";
            patch(id, cancelled ? { state: "cancelled", note: () => t("tasks.note.cancelled") } : { state: "error", error: String(e) });
            setToast({ state: cancelled ? "cancelled" : "error", label });
            resolve(undefined);
          }
        },
        skip: () => {
          patch(id, { state: "cancelled", note: () => t("tasks.note.cancelledQueued") });
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
  const clear = () => setItems((list) => list.filter((task) => task.state === "queued" || task.state === "running"));
  return { items, start, cancel, clear, toast, closeToast: () => setToast(null) };
}

export const percent = (done: number, total: number) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

export function TaskPanel({ tasks }: { tasks: ReturnType<typeof useTransfers> }) {
  const { items, cancel, clear, toast, closeToast } = tasks;
  // Folded to its one summary line when the user wants the room back.
  const [folded, setFolded] = useState(false);
  const count = (state: Transfer["state"]) => items.filter((task) => task.state === state).length;
  return (
    <>
      {items.length > 0 && (
        // Bottom of the window, shared by every tab; a long queue scrolls inside its own box.
        <Paper variant="outlined" square sx={{ px: 2, py: 1, flexShrink: 0, maxHeight: 168, overflow: "auto", borderWidth: "1px 0 0" }} aria-label={t("tasks.title")}>
          <Stack direction="row" sx={{ alignItems: "center", mb: 1 }}>
            <Typography variant="subtitle2" component="h2" sx={{ flexGrow: 1 }}>
              {t("tasks.header", { running: count("running"), queued: count("queued"), max: MAX_RUNNING, tz: TZ })}
            </Typography>
            <Button size="small" onClick={() => setFolded(!folded)} aria-expanded={!folded}>
              {folded ? t("tasks.unfold") : t("tasks.fold")}
            </Button>
            <Button size="small" onClick={clear} disabled={items.every((task) => task.state === "queued" || task.state === "running")}>
              {t("tasks.clear")}
            </Button>
          </Stack>
          <Stack spacing={1} sx={{ display: folded ? "none" : undefined }}>
            {items.map((task) => {
              const active = task.state === "queued" || task.state === "running";
              const bad = task.state === "error";
              const note = task.error ? explain(task.error).message : task.note?.();
              return (
                <Box key={task.id}>
                  <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
                    <Typography variant="body2" sx={{ flexGrow: 1, fontFamily: "monospace", wordBreak: "break-all" }}>
                      {task.label}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                      {vnTime(task.at, true).slice(11)}
                    </Typography>
                    <Typography variant="body2" color={bad ? "error" : "text.secondary"} sx={{ whiteSpace: "nowrap" }}>
                      {task.state === "running"
                        ? `${percent(task.done, task.total)}% · ${formatBytes(task.done)} / ${formatBytes(task.total)}`
                        : task.state === "done"
                          ? t("tasks.doneSize", { size: formatBytes(task.total) })
                          : t(`tasks.state.${task.state}`)}
                    </Typography>
                    {active && (
                      <Button size="small" color="error" onClick={() => cancel(task.id)} aria-label={t("tasks.cancel", { label: task.label })}>
                        {t("common.cancel")}
                      </Button>
                    )}
                  </Stack>
                  {task.state === "running" && (
                    <LinearProgress
                      variant={task.total > 0 ? "determinate" : "indeterminate"}
                      value={percent(task.done, task.total)}
                      aria-label={t("tasks.progress", { label: task.label })}
                    />
                  )}
                  {note && (
                    <Typography variant="body2" color={bad ? "error" : "text.secondary"}>
                      {note}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Paper>
      )}
      <Snackbar open={toast !== null} autoHideDuration={5000} onClose={closeToast} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
        <Alert severity={toast ? TOAST_SEVERITY[toast.state] : "info"} variant="filled" onClose={closeToast} sx={{ wordBreak: "break-all" }}>
          {toast && t(`tasks.toast.${toast.state}`, { label: toast.label })}
        </Alert>
      </Snackbar>
    </>
  );
}
