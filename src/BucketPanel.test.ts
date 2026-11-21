import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";
import BucketPanel, { FILTER_FROM, filterBuckets, LIST_MAX_HEIGHT, moveHighlight, WINDOW_ABOVE } from "./BucketPanel";
import { applyLang, t } from "./i18n";

const nothing = () => {};
const panel = (props: Partial<Parameters<typeof BucketPanel>[0]>) =>
  renderToString(createElement(BucketPanel, { title: "Your buckets", buckets: [], bucketsError: null, current: "", active: true, onOpen: nothing, onCreate: nothing, onPickPath: nothing, ...props }));
// Text as a user reads it: tags dropped, entities of the apostrophes and quotes put back.
const text = (html: string) => html.replace(/<style[^>]*>.*?<\/style>/gs, " ").replace(/<[^>]*>/g, " ").replaceAll("&quot;", '"').replaceAll("&#x27;", "'");

beforeEach(() => applyLang("en"));

test("a key that may not list buckets gets a notice instead of the empty-list text, in both languages", () => {
  const denied = text(panel({ bucketsError: "AccessDenied" }));
  expect(denied).toContain("This key may not list buckets — open a path directly below or use a pinned place");
  expect(denied).not.toContain(t("browse.noBuckets"));
  expect(denied).toContain(t("browse.openPath"));
  // The way to the path picker is the filled button here; what it is for is its tooltip.
  expect(panel({ bucketsError: "AccessDenied" })).toContain('title="Bucket or bucket/folder/ — use this when you may only list one folder"');
  expect(panel({ bucketsError: "AccessDenied" })).toMatch(/MuiButton-contained[^>]*>Open path/);
  expect(panel({})).toMatch(/MuiButton-outlined[^>]*>Open path/);
  // Not an error: the notice is an info alert.
  expect(panel({ bucketsError: "AccessDenied" })).toMatch(/MuiAlert-[a-zA-Z]*[iI]nfo/);
  expect(panel({ bucketsError: "AccessDenied" })).not.toMatch(/MuiAlert-[a-zA-Z]*[eE]rror/);
  applyLang("vi");
  expect(text(panel({ bucketsError: "AccessDenied" }))).toContain(t("browse.bucketsDenied"));
  expect(t("browse.bucketsDenied")).toMatch(/^Key này không được liệt kê bucket/);
});

test("a key that lists nothing keeps the empty-list text, and one with buckets shows them", () => {
  const empty = text(panel({}));
  expect(empty).toContain(t("browse.noBuckets"));
  expect(empty).not.toContain(t("browse.bucketsDenied"));
  const some = text(panel({ buckets: [{ name: "logs", created: "" }, { name: "team-bucket", created: "" }] }));
  expect(some).toContain("logs");
  expect(some).toContain("team-bucket");
  expect(some).not.toContain(t("browse.noBuckets"));
});

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `team-${String(i + 1).padStart(3, "0")}-Data`, created: "" }));
const listTag = (html: string) => /<ul[^>]*aria-label="Bucket list"[^>]*>/.exec(html)?.[0] ?? "";

test("100 buckets: the list has a height limit of its own and scrolls inside the card; header, filter and controls are outside it", () => {
  const html = panel({ buckets: many(100), current: "team-080-Data" });
  // With the pane at its usual height (the window less 121 px of app bar and tab strip) this is the M11 limit, 100vh - 500px.
  expect(LIST_MAX_HEIGHT).toBe("clamp(80px, calc(var(--ba-pane-h, calc(100vh - 121px)) - var(--ba-side-rest, 379px)), 38vh)");
  expect(listTag(html)).toContain(`style="max-height:${LIST_MAX_HEIGHT}"`);
  // The scrolling itself and the thin themed bar come from the list's class.
  const cls = /class="([^"]*)"/.exec(listTag(html))?.[1].split(" ").find((c) => c.startsWith("css-")) ?? "";
  const css = [...html.matchAll(/<style[^>]*>(.*?)<\/style>/gs)].map((m) => m[1]).join("");
  const rule = new RegExp(`\\.${cls}\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  expect(rule).toContain("overflow-y:auto");
  // A thin bar in the theme's line colour: WebKit's properties, and the standard ones where those do not exist.
  expect(css).toContain(`.${cls}::-webkit-scrollbar{width:8px;}`);
  expect(css).toContain(`.${cls}::-webkit-scrollbar-thumb{background:var(--ba-line);border-radius:8px;}`);
  expect(css).toContain(`@supports not selector(::-webkit-scrollbar){.${cls}{scrollbar-width:thin;scrollbar-color:var(--ba-line) transparent;}}`);
  // All 100 rows are in the list (it is windowed above that); everything else of the card is not.
  expect(WINDOW_ABOVE).toBe(100);
  const inside = html.slice(html.indexOf(listTag(html)), html.indexOf("</ul>"));
  expect(inside.match(/role="button"/g)).toHaveLength(100);
  const outside = text(html.replace(inside, ""));
  expect(outside).toContain("Your buckets · 100");
  expect(outside).toContain("Create bucket");
  expect(outside).toContain("Open path");
  expect(html.replace(inside, "")).toContain('placeholder="Filter buckets…"');
  expect(text(inside)).not.toContain("Create bucket");
});

test("500 buckets: only the rows in view are mounted, the rest is two spacers; height limit, count and filter as before", () => {
  const html = panel({ buckets: many(500) });
  const inside = html.slice(html.indexOf(listTag(html)), html.indexOf("</ul>"));
  const rows = inside.match(/role="button"/g)?.length ?? 0;
  expect(rows).toBeGreaterThan(5);
  expect(rows).toBeLessThan(40);
  // The first rows, each saying where it is in the whole list; the space of the others is kept below them.
  expect(text(inside)).toContain("team-001-Data");
  expect(text(inside)).not.toContain("team-400-Data");
  expect(inside).toContain('aria-setsize="500" aria-posinset="1"');
  expect(inside).toContain(`<li aria-hidden="true" style="height:${(500 - rows) * 40}px"></li>`);
  expect(listTag(html)).toContain(`style="max-height:${LIST_MAX_HEIGHT}"`);
  expect(text(html)).toContain("Your buckets · 500");
  expect(html).toContain('placeholder="Filter buckets…"');
  // Filtering 500 names is instant, and exact.
  const before = performance.now();
  const hits = filterBuckets(many(500), "TEAM-49");
  expect(performance.now() - before).toBeLessThan(50);
  expect(hits.map((b) => b.name)).toEqual(Array.from({ length: 10 }, (_, i) => `team-49${i}-Data`));
});

test("the filter field is there from 2 buckets on (whenever there is anything to filter); the header counts the buckets", () => {
  expect(FILTER_FROM).toBe(2);
  expect(panel({ buckets: many(1) })).not.toContain("Filter buckets…");
  expect(panel({ buckets: many(2) })).toContain('placeholder="Filter buckets…"');
  // The first thing of the card the keyboard reaches: no button or link comes before it.
  const card = panel({ buckets: many(2) });
  expect(card.slice(0, card.indexOf('placeholder="Filter buckets…"'))).not.toMatch(/<button|<a |tabindex="0"/);
  expect(panel({ buckets: [], bucketsError: "AccessDenied" })).not.toContain("Filter buckets…");
  expect(text(panel({ buckets: many(8) }))).toContain("Your buckets · 8");
  expect(text(panel({ buckets: [] }))).toContain("Your buckets · 0");
  // Not counted when the key may not list them: there is no number to show.
  expect(text(panel({ bucketsError: "AccessDenied" }))).not.toContain("·");
});

test("filtering is a case-insensitive substring match; arrow keys stay inside the list", () => {
  const buckets = [{ name: "Team-Logs" }, { name: "team-data" }, { name: "archive" }];
  expect(filterBuckets(buckets, "TEAM").map((b) => b.name)).toEqual(["Team-Logs", "team-data"]);
  expect(filterBuckets(buckets, " logs ").map((b) => b.name)).toEqual(["Team-Logs"]);
  expect(filterBuckets(buckets, "")).toBe(buckets);
  expect(filterBuckets(buckets, "nope")).toEqual([]);
  expect(moveHighlight(0, "ArrowDown", 3)).toBe(1);
  expect(moveHighlight(2, "ArrowDown", 3)).toBe(2);
  expect(moveHighlight(0, "ArrowUp", 3)).toBe(0);
  expect(moveHighlight(2, "ArrowUp", 3)).toBe(1);
  // A highlight left over from a longer list points at the last row; an empty list has none to open.
  expect(moveHighlight(7, "", 3)).toBe(2);
  expect(moveHighlight(0, "ArrowDown", 0)).toBe(0);
});
