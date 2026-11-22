import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";
import { applyLang, t } from "./i18n";
import { accessChips, appendChild, lastItem, pathList, PathPickerView, suggestions, suggestKey, tickedPlaces, type Probe } from "./PathPicker";
import { pinAll, type Pin } from "./pins";

beforeEach(() => applyLang("en"));

const at = (bucket: string, prefix = "", clusterId = "c1", uid = "") => ({ clusterId, uid, bucket, prefix });
const pin = (bucket: string, prefix = "", clusterId = "c1") => ({ place: at(bucket, prefix, clusterId), label: "", added: 0 });
const known = {
  startPaths: ["team/reports/", "team/drafts/"],
  pins: [pin("logs", "2026/"), pin("team", "reports/"), pin("elsewhere", "", "c2")],
  recents: [at("media"), at("logs", "2026/"), at("other", "", "c1", "someone"), at("", "")],
  policy: { media: ["", "scoped/"], logs: ["2026/"] },
};

test("chips come in the order start paths (all of them), pins, recent places, policy; a path is shown once, under its first source", () => {
  expect(accessChips(known, "c1")).toEqual([
    { path: "team/reports/", source: "start" },
    { path: "team/drafts/", source: "start" },
    { path: "logs/2026/", source: "pin" },
    { path: "media", source: "recent" },
    { path: "media/scoped/", source: "policy" },
  ]);
  // Another user's key: the start path belongs to the connection's own key, and so do its places.
  expect(accessChips({ ...known, policy: {} }, "c1", "someone")).toEqual([{ path: "other", source: "recent" }]);
  expect(accessChips({ ...known, startPaths: undefined, policy: {} }, "c2")).toEqual([{ path: "elsewhere", source: "pin" }]);
});

const view = (probe: Probe | null, onChange: (path: string) => void = () => {}) => ({ value: "media/sc", onChange, label: t("browse.openPath"), chips: accessChips(known, "c1"), probe });
const html = (probe: Probe | null) => renderToString(createElement(PathPickerView, view(probe)));

test("the chips render in that order, each with the icon of its source", () => {
  const sources = [...html(null).matchAll(/data-source="(\w+)"/g)].map((m) => m[1]);
  expect(sources).toEqual(["start", "start", "pin", "recent", "policy"]);
  const labels = [...html(null).matchAll(/aria-label="Use the path ([^"]*)"/g)].map((m) => m[1]);
  expect(labels).toEqual(["team/reports/", "team/drafts/", "logs/2026/", "media", "media/scoped/"]);
  // M12.5: the caption says whose they are.
  expect(html(null)).toContain("Your paths");
  applyLang("vi");
  expect(html(null)).toContain("Đường dẫn của bạn");
});

test("a refused listing is an amber hint, not an error, in both languages", () => {
  const denied = html({ status: "denied" });
  expect(denied).toContain("This key may not list there — if you were granted a deeper folder, keep typing; the path can still be opened");
  expect(denied).toMatch(/MuiAlert-[a-zA-Z]*[wW]arning/);
  expect(denied).not.toMatch(/MuiAlert-[a-zA-Z]*[eE]rror/);
  expect(html(null)).not.toContain(t("pathPicker.deniedHint"));
  expect(html({ status: "ok", bucket: "media", prefix: "sc", children: ["scoped"] })).not.toContain(t("pathPicker.deniedHint"));
  applyLang("vi");
  expect(html({ status: "denied" })).toContain(t("pathPicker.deniedHint"));
  expect(t("pathPicker.deniedHint")).toMatch(/^Key này không được liệt kê ở đó/);
});

/** Every element of a rendered tree (the view is a plain function: no browser needed to click in it). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

test("clicking a suggested folder appends it to what is typed up to the last slash", () => {
  expect(appendChild({ bucket: "media", prefix: "" }, "scoped")).toBe("media/scoped/");
  expect(appendChild({ bucket: "media", prefix: "scoped/" }, "sub")).toBe("media/scoped/sub/");
  // A name typed halfway is replaced by the folder that continues it.
  expect(appendChild({ bucket: "media", prefix: "scoped/su" }, "sub2")).toBe("media/scoped/sub2/");
  const typed: string[] = [];
  const tree = PathPickerView(view({ status: "ok", bucket: "media", prefix: "scoped/su", children: ["sub", "sub2"] }, (path) => typed.push(path)));
  const child = elements(tree).find((e) => e.props["aria-label"] === "Go into the folder sub2");
  (child?.props.onClick as () => void)();
  const chip = elements(tree).find((e) => e.props["aria-label"] === "Use the path logs/2026/");
  (chip?.props.onClick as () => void)();
  expect(typed).toEqual(["media/scoped/sub2/", "logs/2026/"]);
});

// ---- M12.5: the sidebar's form of the picker, a field with the suggestions in a dropdown under it

const chips = accessChips(known, "c1");
const drop = (value: string, probe: Probe | null, open = true) =>
  renderToString(createElement(PathPickerView, { value, onChange: () => {}, label: t("browse.openPath"), chips, probe, dropdown: { open, highlight: 0, buckets: ["media", "metrics", "logs"] } }));
const rowsOf = (markup: string) => [...markup.matchAll(/role="listitem"[^>]*aria-label="([^"]*)"|aria-label="([^"]*)"[^>]*role="listitem"/g)].map((m) => m[1] ?? m[2]);

test("the dropdown shows the folders S3 lists at the typed path, then the known places that contain it; only while it is open", () => {
  const listed: Probe = { status: "ok", bucket: "media", prefix: "", children: ["raw", "tmp"] };
  const open = drop("media/", listed);
  expect(rowsOf(open)).toEqual(["Go into the folder raw", "Go into the folder tmp", "Use the path media/scoped/"]);
  // Rows, not chips; the first one is the highlighted one, and each says where it comes from.
  expect(open).not.toContain("MuiChip");
  expect(open.match(/class="[^"]*Mui-focusVisible/g)).toHaveLength(1);
  expect([...open.matchAll(/data-source="(\w+)"/g)].map((m) => m[1])).toEqual(["folder", "folder", "policy"]);
  expect(rowsOf(drop("media/", listed, false))).toEqual([]);
  // Nothing typed: every known place, the start paths first.
  expect(suggestions("", null, chips).map((row) => row.path)).toEqual(["team/reports/", "team/drafts/", "logs/2026/", "media", "media/scoped/"]);
  // A bucket's name half typed: the listed buckets that start with it, then the known places that contain it.
  expect(suggestions("me", null, chips, ["media", "metrics", "logs"]).map((row) => `${row.source} ${row.path}`)).toEqual(["bucket media/", "bucket metrics/", "recent media", "policy media/scoped/"]);
  // A row that would change nothing is not offered; s3:// and a leading slash are not part of what is typed.
  expect(suggestions("s3://media", null, chips, ["media"]).map((row) => row.path)).toEqual(["media/", "media/scoped/"]);
  // A refused listing: the amber hint, no rows of folders, and nothing in red.
  const denied = drop("media/secret/", { status: "denied" });
  expect(denied).toContain(t("pathPicker.deniedHint"));
  expect(denied).not.toMatch(/MuiAlert-[a-zA-Z]*[eE]rror/);
  expect(rowsOf(denied)).toEqual([]);
});

test("Tab and → complete the highlighted row and the next level is asked about; the arrows move; Enter is not the rows' key", () => {
  const rows = suggestions("media/sc", { status: "ok", bucket: "media", prefix: "sc", children: ["scoped", "scratch"] }, []);
  expect(rows.map((row) => row.path)).toEqual(["media/scoped/", "media/scratch/"]);
  expect(suggestKey("Tab", rows, 0)).toEqual({ value: "media/scoped/" });
  expect(suggestKey("ArrowDown", rows, 0)).toEqual({ highlight: 1 });
  expect(suggestKey("ArrowDown", rows, 1)).toEqual({ highlight: 1 });
  expect(suggestKey("ArrowUp", rows, 1)).toEqual({ highlight: 0 });
  expect(suggestKey("Tab", rows, 1)).toEqual({ value: "media/scratch/" });
  // → completes only with the caret at the end of the text; elsewhere it moves the caret.
  expect(suggestKey("ArrowRight", rows, 0, true)).toEqual({ value: "media/scoped/" });
  expect(suggestKey("ArrowRight", rows, 0, false)).toBeNull();
  // Enter opens what is typed (the form's business); with no rows Tab moves on to the next control.
  expect(suggestKey("Enter", rows, 0)).toBeNull();
  expect(suggestKey("Tab", [], 0)).toBeNull();
  // The completed segment is the new typed path: its own folders are the next rows.
  const deeper = suggestions("media/scoped/", { status: "ok", bucket: "media", prefix: "scoped/", children: ["sub"] }, []);
  expect(suggestKey("Tab", deeper, 0)).toEqual({ value: "media/scoped/sub/" });
  // The view hands the keys of its field to whoever holds the highlight.
  const keys: string[] = [];
  const field = elements(PathPickerView({ value: "media/sc", onChange: () => {}, label: "Open path", chips: [], probe: null, dropdown: { open: true, highlight: 0 }, onKeyDown: (e) => keys.push(e.key) })).find((e) => e.props.label === "Open path");
  // On the input itself: the TextField's root is a div, where the handler's caret check threw (no real Tab took a row).
  expect(field?.props.onKeyDown).toBeUndefined();
  ((field?.props.slotProps as { htmlInput: { onKeyDown: (e: unknown) => void } }).htmlInput.onKeyDown)({ key: "Tab" });
  expect(keys).toEqual(["Tab"]);
});

test("the sidebar's field has a sample short enough for its narrowest width; the whole example stays in its tooltip, and in the wide forms", () => {
  const side = drop("", null);
  expect(side).toContain('placeholder="bucket/…"');
  expect(side).toContain(t("browse.openPathHelp"));
  expect(html(null)).toContain(`placeholder="${t("browse.openPathSample")}"`);
  applyLang("vi");
  expect(drop("", null)).toContain(`placeholder="${t("browse.openPathShort")}"`);
  expect(t("browse.openPathShort").length).toBeLessThanOrEqual(8);
});

// ---- M14.2: several suggested folders ticked and pinned at once

const listed: Probe = { status: "ok", bucket: "media", prefix: "", children: ["raw", "tmp", "old"] };
const ticking = (ticked: string[], log: { ticked?: string[]; typed?: string[]; pinned?: number }, dropdown = true) => ({
  value: "media/",
  onChange: (path: string) => (log.typed = [...(log.typed ?? []), path]),
  label: t("browse.openPath"),
  chips,
  probe: listed,
  dropdown: dropdown ? { open: true, highlight: 0 } : undefined,
  pick: { ticked, onTicked: (next: string[]) => (log.ticked = next), onPinSelected: () => (log.pinned = (log.pinned ?? 0) + 1) },
});
const boxOf = (tree: ReactNode, name: string) => elements(tree).find((e) => (e.props.slotProps as { input?: Record<string, string> } | undefined)?.input?.["aria-label"] === `Select the folder ${name}`);
const buttonOf = (tree: ReactNode, label: string) => elements(tree).find((e) => e.props.children === label);

test("each folder row has a box: ticking one adds it, ticking it again takes it off; the known places have none", () => {
  applyLang("en");
  const log: { ticked?: string[] } = {};
  const tree = PathPickerView(ticking([], log));
  (boxOf(tree, "tmp")?.props.onChange as () => void)();
  expect(log.ticked).toEqual(["media/tmp/"]);
  (boxOf(PathPickerView(ticking(["media/tmp/", "media/raw/"], log)), "tmp")?.props.onChange as () => void)();
  expect(log.ticked).toEqual(["media/raw/"]);
  const markup = renderToString(createElement(PathPickerView, ticking([], log)));
  expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
  // A click on the box is not a click on the row (which goes into the folder).
  let bubbled = false;
  (boxOf(tree, "raw")?.props.onClick as (e: unknown) => void)({ stopPropagation: () => (bubbled = true) });
  expect(bubbled).toBe(true);
});

test("nothing ticked: no footer, and a row still goes into its folder with one click", () => {
  applyLang("en");
  const log: { typed?: string[] } = {};
  const tree = PathPickerView(ticking([], log));
  expect(buttonOf(tree, "Pin selected")).toBeUndefined();
  (elements(tree).find((e) => e.props["aria-label"] === "Go into the folder raw")?.props.onClick as () => void)();
  (elements(tree).find((e) => e.props["aria-label"] === "Use the path media/scoped/")?.props.onClick as () => void)();
  expect(log.typed).toEqual(["media/raw/", "media/scoped/"]);
});

test("with rows ticked the footer says how many, Select all ticks the level (then clears it), Pin selected pins each", async () => {
  applyLang("en");
  const log: { ticked?: string[]; pinned?: number } = {};
  const some = PathPickerView(ticking(["media/raw/", "media/tmp/"], log));
  expect(renderToString(createElement(PathPickerView, ticking(["media/raw/", "media/tmp/"], log)))).toContain("2 selected");
  (buttonOf(some, "Select all")?.props.onClick as () => void)();
  expect(log.ticked).toEqual(["media/raw/", "media/tmp/", "media/old/"]);
  (buttonOf(PathPickerView(ticking(["media/raw/", "media/tmp/", "media/old/"], log)), "Clear")?.props.onClick as () => void)();
  expect(log.ticked).toEqual([]);
  (buttonOf(some, "Pin selected")?.props.onClick as () => void)();
  expect(log.pinned).toBe(1);
  // What Pin selected hands the app: one place per ticked row, on the picker's key; pin_add is asked for each.
  const places = tickedPlaces(["media/raw/", "media/tmp/"], "c1", "");
  expect(places).toEqual([at("media", "raw/"), at("media", "tmp/")]);
  const asked: string[] = [];
  const add = async (place: (typeof places)[number]): Promise<Pin[]> => (asked.push(place.prefix), []);
  expect((await pinAll([], places, add)).summary).toEqual({ pinned: 2, already: 0, invalid: 0 });
  expect(asked).toEqual(["raw/", "tmp/"]);
  // The pin dialog has the same rows (instead of chips) and the same footer.
  const dialog = PathPickerView(ticking(["media/old/"], log, false));
  expect(boxOf(dialog, "old")).toBeDefined();
  expect(buttonOf(dialog, "Pin selected")).toBeDefined();
  applyLang("vi");
  const vi = renderToString(createElement(PathPickerView, ticking(["media/raw/"], log)));
  expect(vi).toContain("Đã chọn 1");
  expect(vi).toContain("Ghim mục đã chọn");
});

test("Space right after the arrows ticks the highlighted folder; otherwise it is a space, and Enter keeps its meaning", () => {
  const rows = suggestions("media/", listed, chips);
  expect(suggestKey(" ", rows, 1, true, true)).toEqual({ toggle: "media/tmp/" });
  expect(suggestKey(" ", rows, 1, true, false)).toBeNull();
  // The highlighted row is a known place, not a folder: nothing to tick.
  expect(suggestKey(" ", rows, 3, true, true)).toBeNull();
  expect(suggestKey("Enter", rows, 1, true, true)).toBeNull();
});

test("the pin dialog takes a list: the chips and folders are for the line being typed; bad lines are named", () => {
  applyLang("en");
  expect(lastItem("a/x/\nmed", true)).toEqual(["a/x/\n", "med"]);
  expect(lastItem("a/x/\nmed", false)).toEqual(["", "a/x/\nmed"]);
  const typed: string[] = [];
  const tree = PathPickerView({ value: "a/x/\nmedia/sc", onChange: (path) => typed.push(path), label: "Open path", chips, probe: null, multiline: true });
  (elements(tree).find((e) => e.props["aria-label"] === "Use the path logs/2026/")?.props.onClick as () => void)();
  expect(typed).toEqual(["a/x/\nlogs/2026/"]);
  const markup = renderToString(createElement(PathPickerView, { value: "a/x/\nmy bucket/\nb", onChange: () => {}, label: "Open path", chips: [], probe: null, multiline: true }));
  expect(markup).toContain("<textarea");
  expect(markup).toContain("Not a valid path: my bucket/");
  expect(pathList("a/x/\nmy bucket/\ns3://b/y, a/x/")).toEqual({ places: [{ bucket: "a", prefix: "x/" }, { bucket: "b", prefix: "y/" }], bad: ["my bucket/"] });
});
