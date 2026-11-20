import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { AuditView, sinceFor, type AuditRow, type Range } from "./AuditLog";
import { applyLang, t } from "./i18n";

// Node's own modules, loaded by name: the app is typed for the browser and has no Node types.
const builtin = (name: string) => import(/* @vite-ignore */ name);
const [{ mkdtempSync, rmSync }, { tmpdir }, { DatabaseSync }] = await Promise.all([builtin("node:fs"), builtin("node:os"), builtin("node:sqlite")]);

// A temp audit.db with the app's own schema (src-tauri/src/audit.rs) and entries as the app writes them.
const NOW = Date.UTC(2026, 10, 20, 10, 0, 0); // 2026-11-20 17:00 in UTC+7
const at = (hoursAgo: number) => Math.floor(NOW / 1000) - hoursAgo * 3600;
const dir: string = mkdtempSync(`${tmpdir()}/ba-audit-`);
let db: any;
beforeAll(() => {
  db = new DatabaseSync(`${dir}/audit.db`);
  db.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, cluster_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, ok INTEGER NOT NULL, message TEXT NOT NULL)");
  const add = db.prepare("INSERT INTO audit (ts, cluster_id, action, target, detail, ok, message) VALUES (?, ?, ?, ?, ?, ?, ?)");
  add.run(at(24 * 40), "c1", "bucket.create", "team-data", "versioning=true", 1, "");
  add.run(at(24 * 3), "c1", "object.upload", "team-data/reports/2026/q3.pdf", "size=1024", 1, "");
  add.run(at(20), "gone", "acl.set_many", "media/photos/", "objects=3", 1, "");
  add.run(at(2), "c1", "object.delete", "team-data/reports/old.txt", "", 0, "S3 AccessDenied (403): ");
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true });
});
beforeEach(() => applyLang("en"));

const LABELS: Record<string, string> = { c1: "lab" };
/** What the backend's `audit_list` answers for this file: same order, paging, time bound and row shape. */
function auditList(args: { limit: number; offset: number; filter: string; sinceUnix: number }): AuditRow[] {
  const like = `%${args.filter.trim()}%`;
  const found: Record<string, unknown>[] = db.prepare("SELECT ts, action, cluster_id, target, ok, message FROM audit WHERE ts >= ? AND (action LIKE ? OR target LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?").all(args.sinceUnix, like, like, args.limit, args.offset);
  return found.map((r: Record<string, unknown>) => {
    const [bucket, ...rest] = String(r.target).split("/");
    const key = rest.join("/");
    const cut = key.lastIndexOf("/") + 1;
    return { ts: Number(r.ts), action: String(r.action), cluster_id: String(r.cluster_id), connection: LABELS[String(r.cluster_id)] ?? "", bucket, prefix: key.slice(0, cut), object: key.slice(cut), ok: !!r.ok, message: String(r.message) };
  });
}
const nothing = () => {};
const page = (range: Range, filter = "") => {
  const rows = auditList({ limit: 200, offset: 0, filter, sinceUnix: sinceFor(range, NOW) });
  const html = renderToString(createElement(AuditView, { rows, filter, onFilter: nothing, range, onRange: nothing, more: false, onMore: nothing }));
  return { rows, html, text: html.replace(/<style[^>]*>.*?<\/style>/gs, " ").replace(/<[^>]*>/g, "|") };
};
const actions = (rows: AuditRow[]) => rows.map((r) => r.action);

test("time ranges: today starts at midnight in UTC+7; 7 and 30 days count back from now; all is everything", () => {
  expect(sinceFor("all", NOW)).toBe(0);
  // 2026-11-20 00:00 +07:00 is 2026-11-19 17:00 UTC.
  expect(sinceFor("today", NOW)).toBe(Date.UTC(2026, 10, 19, 17, 0, 0) / 1000);
  // One second before that midnight is still the day before; the midnight itself is today.
  expect(sinceFor("today", Date.UTC(2026, 10, 19, 16, 59, 59))).toBe(Date.UTC(2026, 10, 18, 17, 0, 0) / 1000);
  expect(sinceFor("7d", NOW)).toBe(NOW / 1000 - 7 * 86400);
  expect(sinceFor("30d", NOW)).toBe(NOW / 1000 - 30 * 86400);
  expect(actions(page("today").rows)).toEqual(["object.delete"]);
  expect(actions(page("7d").rows)).toEqual(["object.delete", "acl.set_many", "object.upload"]);
  expect(actions(page("30d").rows)).toHaveLength(3);
  expect(actions(page("all").rows)).toEqual(["object.delete", "acl.set_many", "object.upload", "bucket.create"]);
});

test("the table shows time in UTC+7, action, connection label, bucket, folder and object of each entry, newest first", () => {
  const { text, html } = page("all");
  expect(text).toContain("Time (UTC+7)");
  const cells = (row: string) => text.slice(text.indexOf(row)).split("|").filter((c) => c.trim()).slice(0, 7);
  // 2026-11-20 08:00 UTC is 15:00 in Vietnam.
  expect(cells("2026-11-20 15:00:00")).toEqual(["2026-11-20 15:00:00", "object.delete", "lab", "team-data", "reports/", "old.txt", "Failed: S3 AccessDenied (403): "]);
  expect(cells("2026-11-17 17:00:00")).toEqual(["2026-11-17 17:00:00", "object.upload", "lab", "team-data", "reports/2026/", "q3.pdf", "Done"]);
  // A folder action has no object; an entry of a connection that was removed says so.
  expect(cells("2026-11-19 21:00:00").slice(0, 6)).toEqual(["2026-11-19 21:00:00", "acl.set_many", "deleted connection", "media", "photos/", "Done"]);
  expect(text.indexOf("object.delete")).toBeLessThan(text.indexOf("bucket.create"));
  expect(text).toContain("entries shown: 4");
  expect(html).toContain('aria-label="Audit log entries"');
  // Rows keep the size floor.
  expect(html).toMatch(/<tr class="[^"]*MuiTableRow-root[^"]*css-[^"]*"/);
});

test("read-only: a filter and a time range, and no button that deletes or exports", () => {
  const { html, text } = page("all", "REPORTS");
  expect(actions(page("all", "REPORTS").rows)).toEqual(["object.delete", "object.upload"]);
  expect(html).toContain('placeholder="Filter by action, path or connection…"');
  for (const range of ["Today", "7 days", "30 days", "All"]) expect(text).toContain(`|${range}|`);
  expect(html.match(/<button/g)).toHaveLength(4); // the four time ranges, nothing else
  expect(text).not.toMatch(/delete all|clear|export|download|csv/i);
  // With more entries than a page, the one extra button asks for older ones.
  const more = renderToString(createElement(AuditView, { rows: page("all").rows, filter: "", onFilter: nothing, range: "all", onRange: nothing, more: true, onMore: nothing }));
  expect(more).toContain("Show older entries");
});

test("an empty log is explained; a filter that matches nothing says so; both in Vietnamese too", () => {
  const empty = renderToString(createElement(AuditView, { rows: [], filter: "", onFilter: nothing, range: "all", onRange: nothing, more: false, onMore: nothing }));
  expect(empty).toContain("Nothing has been recorded yet.");
  expect(empty).not.toContain("<table");
  expect(page("today", "bucket.create").rows).toEqual([]);
  expect(page("today", "bucket.create").html).toContain("No entry matches the filter in this time range.");
  applyLang("vi");
  expect(page("all").text).toContain(`${t("audit.col.time", { tz: "UTC+7" })}|`);
  expect(page("all").text).toContain("Thời gian (UTC+7)");
  expect(page("all", "nothing-like-it").html).toContain(t("audit.emptyFiltered"));
});
