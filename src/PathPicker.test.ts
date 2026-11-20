import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";
import { applyLang, t } from "./i18n";
import { accessChips, appendChild, PathPickerView, type Probe } from "./PathPicker";

beforeEach(() => applyLang("en"));

const at = (bucket: string, prefix = "", clusterId = "c1", uid = "") => ({ clusterId, uid, bucket, prefix });
const pin = (bucket: string, prefix = "", clusterId = "c1") => ({ place: at(bucket, prefix, clusterId), label: "", added: 0 });
const known = {
  startPath: "team/reports/",
  pins: [pin("logs", "2026/"), pin("team", "reports/"), pin("elsewhere", "", "c2")],
  recents: [at("media"), at("logs", "2026/"), at("other", "", "c1", "someone"), at("", "")],
  policy: { media: ["", "scoped/"], logs: ["2026/"] },
};

test("chips come in the order start path, pins, recent places, policy; a path is shown once, under its first source", () => {
  expect(accessChips(known, "c1")).toEqual([
    { path: "team/reports/", source: "start" },
    { path: "logs/2026/", source: "pin" },
    { path: "media", source: "recent" },
    { path: "media/scoped/", source: "policy" },
  ]);
  // Another user's key: the start path belongs to the connection's own key, and so do its places.
  expect(accessChips({ ...known, policy: {} }, "c1", "someone")).toEqual([{ path: "other", source: "recent" }]);
  expect(accessChips({ ...known, startPath: undefined, policy: {} }, "c2")).toEqual([{ path: "elsewhere", source: "pin" }]);
});

const view = (probe: Probe | null, onChange: (path: string) => void = () => {}) => ({ value: "media/sc", onChange, label: t("browse.openPath"), chips: accessChips(known, "c1"), probe });
const html = (probe: Probe | null) => renderToString(createElement(PathPickerView, view(probe)));

test("the chips render in that order, each with the icon of its source", () => {
  const sources = [...html(null).matchAll(/data-source="(\w+)"/g)].map((m) => m[1]);
  expect(sources).toEqual(["start", "pin", "recent", "policy"]);
  const labels = [...html(null).matchAll(/aria-label="Use the path ([^"]*)"/g)].map((m) => m[1]);
  expect(labels).toEqual(["team/reports/", "logs/2026/", "media", "media/scoped/"]);
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
