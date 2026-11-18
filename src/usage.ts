import type { Usage } from "./api";

export type UsageRow = {
  bucket: string;
  /** Start of the hour the entry covers, as RGW reports it (UTC). */
  time: string;
  category: string;
  ops: number;
  successful_ops: number;
  bytes_sent: number;
  bytes_received: number;
};

/** One row per bucket, hour and category. */
export function usageRows(usage: Usage): UsageRow[] {
  return usage.entries.flatMap((entry) =>
    entry.buckets.flatMap((b) =>
      b.categories.map((c) => ({
        bucket: b.bucket,
        time: b.time,
        category: c.category,
        ops: c.ops,
        successful_ops: c.successful_ops,
        bytes_sent: c.bytes_sent,
        bytes_received: c.bytes_received,
      })),
    ),
  );
}

export function usageTotals(rows: UsageRow[]) {
  const total = { ops: 0, successful_ops: 0, bytes_sent: 0, bytes_received: 0 };
  for (const r of rows) {
    total.ops += r.ops;
    total.successful_ops += r.successful_ops;
    total.bytes_sent += r.bytes_sent;
    total.bytes_received += r.bytes_received;
  }
  return total;
}

/** Bucket-hour records in the answer: what a trim of the same range removes. */
export const usageRecords = (usage: Usage) => usage.entries.reduce((n, e) => n + e.buckets.length, 0);

function csvCell(value: string | number): string {
  let text = String(value);
  // A cell starting with = + - @ is run as a formula by spreadsheet programs.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function usageCsv(rows: UsageRow[]): string {
  const header = ["bucket", "time_utc", "category", "ops", "successful_ops", "bytes_sent", "bytes_received"];
  const lines = rows.map((r) =>
    [r.bucket, r.time, r.category, r.ops, r.successful_ops, r.bytes_sent, r.bytes_received].map(csvCell).join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** `YYYY-MM-DD` of the UTC day `days` before `now`. */
export const daysAgo = (days: number, now = new Date()) => isoDay(new Date(now.getTime() - days * 86_400_000));

/** RGW's `end` is exclusive, the date picker's is inclusive: send the day after. */
export const nextDay = (date: string) => isoDay(new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000));

/** File name for an export; the backend only accepts letters, digits and . _ - */
export const exportName = (uid: string, start: string, end: string) =>
  `usage-${uid.replace(/[^A-Za-z0-9._-]/g, "_")}-${start}_${end}.csv`;
