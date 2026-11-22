import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { Profile } from "./api";
import { applyLang } from "./i18n";
import PinnedPanel, { PINS_FILTER_ABOVE } from "./PinnedPanel";
import { ListFilter } from "./ui";
import { defaultLabel, filterPins, isPinned, movePin, orderPins, pinLabel, pinTarget, togglePin, type Pin } from "./pins";
import type { Place } from "./tabs";

const at = (clusterId: string, bucket: string, prefix = "", uid = ""): Place => ({ clusterId, uid, bucket, prefix });
const pin = (place: Place, label = "", added = 0): Pin => ({ place, label, added });
const names = (pins: Pin[]) => pins.map(pinLabel);

test("toggle pins a place at the end and unpins it again; a place is the connection, the key, the bucket and the prefix", () => {
  const logs = at("c1", "logs", "2026/11/");
  let pins = togglePin([], at("c1", "logs"), 100);
  pins = togglePin(pins, logs, 200);
  expect(pins).toEqual([pin(at("c1", "logs"), "", 100), pin(logs, "", 200)]);
  expect(isPinned(pins, logs)).toBe(true);
  expect(isPinned(pins, { ...logs })).toBe(true);
  for (const other of [at("c2", "logs", "2026/11/"), at("c1", "logs", "2026/"), at("c1", "logs", "2026/11/", "alice"), at("c1", "other", "2026/11/")]) expect(isPinned(pins, other)).toBe(false);
  pins = togglePin(pins, logs, 300);
  expect(pins).toEqual([pin(at("c1", "logs"), "", 100)]);
  expect(isPinned(pins, logs)).toBe(false);
  // The list given in is never changed: the caller still holds the state it showed.
  const before = [pin(logs)];
  togglePin(before, logs, 1);
  expect(before).toHaveLength(1);
});

test("a pin is called by its path until it is given a name", () => {
  expect(defaultLabel(at("c1", "logs"))).toBe("logs");
  expect(defaultLabel(at("c1", "team-bucket", "a/b/c/"))).toBe("team-bucket/a/b/c");
  expect(pinLabel(pin(at("c1", "team-bucket", "a/b/c/")))).toBe("team-bucket/a/b/c");
  expect(pinLabel(pin(at("c1", "team-bucket", "a/b/c/"), "daily reports"))).toBe("daily reports");
});

test("manual order: a pin moves to a position, clamped to the list", () => {
  const pins = ["a", "b", "c", "d"].map((bucket) => pin(at("c1", bucket)));
  const order = (to: number, bucket = "c") => names(movePin(pins, at("c1", bucket), to)).join("");
  expect(order(0)).toBe("cabd");
  expect(order(1)).toBe("acbd");
  expect(order(3)).toBe("abdc");
  expect(order(99)).toBe("abdc");
  expect(order(-5)).toBe("cabd");
  expect(order(2)).toBe("abcd");
  expect(movePin(pins, at("c1", "nope"), 0)).toBe(pins);
});

const pins = [pin(at("c2", "archive"), "old archive"), pin(at("c1", "logs", "2026/")), pin(at("c2", "media")), pin(at("c1", "team-bucket", "project-a/"), "project A")];

test("the sidebar order: this connection's pins first, each group in the user's order, each knowing its place in the whole list", () => {
  const { here, elsewhere } = orderPins(pins, "c1");
  expect(here.map((p) => [pinLabel(p.pin), p.index])).toEqual([["logs/2026", 1], ["project A", 3]]);
  expect(elsewhere.map((p) => [pinLabel(p.pin), p.index])).toEqual([["old archive", 0], ["media", 2]]);
  expect(orderPins(pins, "c9").here).toEqual([]);
});

const profiles: Profile[] = [
  { id: "c1", label: "lab", endpoint: "http://rgw.example:7480", access_key: "AK1" },
  { id: "c2", label: "prod", endpoint: "http://rgw2.example:7480", access_key: "AK2" },
];
const nothing = () => {};
const render = (clusterId: string, list = pins, folded = false) =>
  renderToString(createElement(PinnedPanel, { pins: list, profiles, clusterId, onOpen: nothing, onOpenTab: nothing, ops: { toggle: nothing, rename: nothing, move: nothing }, folded, onFold: nothing }));
const text = (html: string) => html.replace(/<style[^>]*>.*?<\/style>/gs, " ").replace(/<[^>]*>/g, "|");

test("the Pinned panel lists the current connection's pins first, the others under a divider, each with its full place as tooltip", () => {
  applyLang("en");
  const html = render("c1");
  const shown = text(html);
  const order = [`Pinned · ${pins.length}`, "logs/2026", "project A", "Other connections", "old archive", "media"].map((label) => shown.indexOf(`|${label}|`));
  expect(order.every((position) => position >= 0), shown).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(html).toContain('title="lab · logs/2026"');
  expect(html).toContain('title="prod · archive"');
  expect(html).toContain('aria-label="Pinned places"');
  // Seen from the other connection, the groups swap.
  const other = text(render("c2"));
  expect(other.indexOf("|old archive|")).toBeLessThan(other.indexOf("|Other connections|"));
  expect(other.indexOf("|Other connections|")).toBeLessThan(other.indexOf("|logs/2026|"));
  // No divider without pins elsewhere; no panel without pins.
  expect(text(render("c1", pins.filter((p) => p.place.clusterId === "c1")))).not.toContain("Other connections");
  expect(render("c1", [])).toBe("");
  // Folded: the heading (a button that says so) with the count, and no list.
  expect(html).toContain('aria-expanded="true"');
  const folded = render("c1", pins, true);
  expect(folded).toContain('aria-expanded="false"');
  expect(text(folded)).toContain(`|Pinned · ${pins.length}|`);
  expect(folded).not.toContain('aria-label="Pinned places"');
  expect(text(folded)).not.toContain("|logs/2026|");
  applyLang("vi");
  expect(text(render("c1"))).toContain(`|Đã ghim · ${pins.length}|`);
});

// ---- M12.3: the shared filter field, and the Pinned card's use of it

const somePins = (n: number) => Array.from({ length: n }, (_, i) => ({ place: { clusterId: "c1", uid: "", bucket: `team-${i + 1}`, prefix: i % 2 ? "Reports/" : "" }, label: i === 0 ? "Daily Notes" : "", added: i }));
const card = (n: number) =>
  renderToString(createElement(PinnedPanel, { pins: somePins(n), profiles: [], clusterId: "c1", onOpen: () => {}, onOpenTab: () => {}, ops: { toggle: () => {}, rename: () => {}, move: () => {} }, folded: false, onFold: () => {} }));

test("the Pinned card has the filter field above 5 pins, matching name and path whatever the case", () => {
  applyLang("en");
  expect(PINS_FILTER_ABOVE).toBe(5);
  expect(card(5)).not.toContain("Filter pinned places…");
  expect(card(6)).toContain('placeholder="Filter pinned places…"');
  applyLang("vi");
  expect(card(6)).toContain('placeholder="Lọc vị trí đã ghim…"');
  applyLang("en");
  const pins = somePins(6);
  expect(filterPins(pins, "daily").map((pin) => pin.place.bucket)).toEqual(["team-1"]);
  expect(filterPins(pins, "REPORTS").map((pin) => pin.place.bucket)).toEqual(["team-2", "team-4", "team-6"]);
  expect(filterPins(pins, " team-3 ").map((pin) => pin.place.bucket)).toEqual(["team-3"]);
  expect(filterPins(pins, "")).toBe(pins);
});

/** Every element of a rendered tree (the field is a plain function: no browser needed to press a key in it). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

test("ListFilter: Esc clears what is typed (and is kept from the menu around it); other keys go to the list; the count shows while filtering", () => {
  applyLang("en");
  const typed: string[] = [];
  const keys: string[] = [];
  const field = (value: string) => ListFilter({ value, onChange: (text) => typed.push(text), placeholder: "Filter…", shown: 3, total: 12, onKeyDown: (e) => keys.push(e.key) });
  const press = (value: string, key: string) => {
    const stopped: string[] = [];
    const onKeyDown = elements(field(value))[0].props.onKeyDown as (e: unknown) => void;
    onKeyDown({ key, preventDefault: () => stopped.push("default"), stopPropagation: () => stopped.push("propagation") });
    return stopped;
  };
  expect(press("logs", "Escape")).toEqual(["default", "propagation"]);
  expect(typed).toEqual([""]);
  // Nothing typed: Esc belongs to whatever is around the field.
  expect(press("", "Escape")).toEqual([]);
  expect(press("logs", "ArrowDown")).toEqual([]);
  expect(keys).toEqual(["Escape", "ArrowDown"]);
  expect(typed).toEqual([""]);
  expect(renderToString(field("logs"))).toContain("3 of 12");
  expect(renderToString(field(""))).not.toContain("3 of 12");
  expect(renderToString(field("logs"))).toContain('aria-label="Filter…"');
});

test("Pin a path…: enabled whenever a connection exists; the dialog asks which one when the tab has none", () => {
  // No connection saved (or the list not loaded yet): the item is disabled.
  expect(pinTarget("", [])).toBeNull();
  expect(pinTarget(undefined, [])).toBeNull();
  expect(pinTarget("gone", [])).toBeNull();
  // The tab on screen is on a connection: that one, no question.
  expect(pinTarget("c2", ["c1", "c2"])).toEqual({ clusterId: "c2", ask: false });
  // The app opened with no connection in its tab (it was started before the first one was added), no tab
  // at all, or a tab whose connection was removed: the dialog asks, the first connection chosen.
  expect(pinTarget("", ["c1", "c2"])).toEqual({ clusterId: "c1", ask: true });
  expect(pinTarget(undefined, ["c1", "c2"])).toEqual({ clusterId: "c1", ask: true });
  expect(pinTarget("gone", ["c1"])).toEqual({ clusterId: "c1", ask: true });
});
