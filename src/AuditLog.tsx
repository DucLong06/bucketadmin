// The audit log, to look at: what this app changed, where and when. Read-only by design — the
// log is the record of what was done, so this page has nothing that deletes or exports it.
import { useEffect, useRef, useState } from "react";
import { Box, Button, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { invoke } from "./api";
import { TZ, vnTime } from "./format";
import { t, type Key } from "./i18n";
import { tokens } from "./theme";
import { ErrorAlert } from "./ui";

/** A row of the backend's `audit_list`. `connection` is "" when that connection is no longer saved. */
export type AuditRow = { ts: number; action: string; connection: string; cluster_id: string; bucket: string; prefix: string; object: string; ok: boolean; message: string };
export const RANGES = ["today", "7d", "30d", "all"] as const;
export type Range = (typeof RANGES)[number];
/** Rows asked for at a time. */
export const PAGE = 200;

/** The oldest moment (Unix seconds) a range shows. "Today" starts at midnight in UTC+7, whatever zone the machine is in. */
export function sinceFor(range: Range, nowMs: number = Date.now()): number {
  const [now, day, vn] = [Math.floor(nowMs / 1000), 86400, 7 * 3600];
  if (range === "all") return 0;
  if (range === "today") return Math.floor((now + vn) / day) * day - vn;
  return now - (range === "7d" ? 7 : 30) * day;
}

type ViewProps = { rows: AuditRow[]; filter: string; onFilter: (text: string) => void; range: Range; onRange: (range: Range) => void; more: boolean; onMore: () => void };

/** The page for a given state; `AuditLog` adds the asking. */
export function AuditView({ rows, filter, onFilter, range, onRange, more, onMore }: ViewProps) {
  const mono = { fontFamily: tokens.mono, fontSize: 14 };
  // Names stay on one line and end in "…" with the whole name as a tooltip: a name broken mid-word reads as two names.
  const name = (text: string, sx: object = mono) => (
    <TableCell title={text || undefined} sx={{ ...sx, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {text}
    </TableCell>
  );
  const narrowed = !!filter.trim() || range !== "all";
  return (
    <>
      <Typography variant="overline" color="primary" component="p">
        {t("app.audit")}
      </Typography>
      <Typography variant="h4" component="h1" gutterBottom>
        {t("app.audit")}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2.5, maxWidth: 820 }}>
        {t("audit.intro", { tz: TZ })}
      </Typography>
      <Stack direction="row" sx={{ gap: 2, mb: 2, alignItems: "center", flexWrap: "wrap" }}>
        <TextField
          placeholder={t("audit.filter")}
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          size="small"
          slotProps={{ htmlInput: { "aria-label": t("audit.filter"), spellCheck: false, type: "search" } }}
          sx={{ width: 380, maxWidth: "100%" }}
        />
        <ToggleButtonGroup size="small" exclusive value={range} onChange={(_, next: Range | null) => next && onRange(next)} aria-label={t("audit.range")}>
          {RANGES.map((choice) => (
            <ToggleButton key={choice} value={choice} sx={{ px: 1.75, minHeight: 40, textTransform: "none" }}>
              {t(`audit.range.${choice}` as Key)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {rows.length > 0 && (
          <Typography variant="body2" color="text.secondary" aria-live="polite" sx={{ ml: "auto" }}>
            {t("audit.count", { n: rows.length })}
          </Typography>
        )}
      </Stack>
      {rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">{t(narrowed ? "audit.emptyFiltered" : "audit.empty")}</Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          {/* Fixed layout: the window width decides the columns, never a long name (no sideways scroll at 1100 px). */}
          <Table size="small" aria-label={t("audit.table")} sx={{ tableLayout: "fixed", "& td, & th": { px: 1.5 } }}>
            <TableHead>
              <TableRow>
                {(["audit.col.time", "audit.col.action", "common.connection", "audit.col.bucket", "audit.col.prefix", "audit.col.object", "audit.col.result"] satisfies Key[]).map((key) => (
                  <TableCell key={key} sx={{ width: key === "audit.col.time" || key === "audit.col.action" ? 180 : undefined }}>
                    {t(key, { tz: TZ })}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i} sx={{ height: 40 }}>
                  <TableCell sx={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{vnTime(row.ts * 1000, true)}</TableCell>
                  {name(row.action)}
                  {name(row.connection || t("tabs.goneConnection"), { color: row.connection ? undefined : "text.secondary" })}
                  {name(row.bucket)}
                  {name(row.prefix)}
                  {name(row.object)}
                  <TableCell sx={{ color: row.ok ? "success.main" : "error.main" }}>{row.ok ? t("audit.ok") : t("audit.failed", { message: row.message })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {more && (
        <Box sx={{ mt: 2, textAlign: "center" }}>
          <Button variant="outlined" onClick={onMore}>
            {t("audit.more")}
          </Button>
        </Box>
      )}
    </>
  );
}

/** The audit-log page: asks the backend again 250 ms after the filter or the range changes. */
export default function AuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [filter, setFilter] = useState("");
  const [range, setRange] = useState<Range>("7d");
  // The last page came back full: there may be older entries.
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = (offset: number) => invoke<AuditRow[]>("audit_list", { limit: PAGE, offset, filter, sinceUnix: sinceFor(range) });
  // Counts the questions: older entries asked for under another filter or range are not appended to the new list.
  const asked = useRef(0);
  useEffect(() => {
    asked.current += 1;
    let stale = false;
    const timer = setTimeout(() => {
      ask(0).then(
        (page) => {
          if (stale) return;
          setRows(page);
          setMore(page.length === PAGE);
          setError(null);
        },
        (e) => stale || setError(String(e)),
      );
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [filter, range]);
  const older = () => {
    const mine = ++asked.current;
    return ask(rows.length).then(
      (page) => {
        if (mine !== asked.current) return;
        setRows((shown) => [...shown, ...page]);
        setMore(page.length === PAGE);
      },
      (e) => setError(String(e)),
    );
  };
  return (
    <>
      <ErrorAlert error={error} sx={{ mb: 2 }} />
      <AuditView rows={rows} filter={filter} onFilter={setFilter} range={range} onRange={setRange} more={more} onMore={older} />
    </>
  );
}
