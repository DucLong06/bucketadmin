import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";
import BucketPanel, { filterBuckets, LIST_MAX_HEIGHT, moveHighlight } from "./BucketPanel";
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

test("150 buckets: the list has a height limit of its own and scrolls inside the card; header, filter and controls are outside it", () => {
  const html = panel({ buckets: many(150), current: "team-120-Data" });
  expect(LIST_MAX_HEIGHT).toBe("max(200px, 38vh)");
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
  // All 150 rows are in the list; everything else of the card is not.
  const inside = html.slice(html.indexOf(listTag(html)), html.indexOf("</ul>"));
  expect(inside.match(/role="button"/g)).toHaveLength(150);
  const outside = text(html.replace(inside, ""));
  expect(outside).toContain("Your buckets · 150");
  expect(outside).toContain("Create bucket");
  expect(outside).toContain("Open path");
  expect(html.replace(inside, "")).toContain('placeholder="Filter buckets…"');
  expect(text(inside)).not.toContain("Create bucket");
});

test("the filter field appears above 8 buckets only; the header counts the buckets", () => {
  expect(panel({ buckets: many(8) })).not.toContain("Filter buckets…");
  expect(panel({ buckets: many(9) })).toContain("Filter buckets…");
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
