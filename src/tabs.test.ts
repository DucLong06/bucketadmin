import { expect, test } from "vitest";
import { closeTab, cycleTab, placeLabel, placePath, samePlace, tabShortcut, tabTitle, type BrowseTab, type Place } from "./tabs";

const place = (bucket = "", prefix = "", clusterId = "c1", uid = ""): Place => ({ clusterId, uid, bucket, prefix });
const tab = (id: string, at = place()): BrowseTab => ({ id, start: at, at });

test("titles and labels of a place", () => {
  expect(tabTitle(place())).toBe("Tab mới");
  expect(tabTitle(place("logs"))).toBe("logs");
  expect(tabTitle(place("logs", "2026/11/"))).toBe("11");
  expect(placePath(place("logs", "2026/11/"))).toBe("logs/2026/11");
  expect(placePath(place("logs"))).toBe("logs");
  const profiles = [{ id: "c1", label: "lab", endpoint: "http://h:1", access_key: "AK" }];
  expect(placeLabel(place("logs", "2026/"), profiles)).toBe("lab · logs/2026");
  expect(placeLabel(place("logs", "", "c1", "alice"), profiles)).toBe("lab · user alice · logs");
  expect(placeLabel(place("logs", "", "gone"), profiles)).toBe("kết nối đã xoá · logs");
  expect(samePlace(place("a", "b/"), place("a", "b/"))).toBe(true);
  expect(samePlace(place("a", "b/"), place("a", "b/", "c1", "alice"))).toBe(false);
  expect(samePlace(place("a", "b/"), place("a", "b/", "c2"))).toBe(false);
});

test("closing a tab activates its neighbour and never leaves no tab", () => {
  const tabs = [tab("1"), tab("2"), tab("3")];
  const fresh = tab("new");
  // The active tab closes: the one that slides into its position takes over.
  expect(closeTab(tabs, "2", "2", fresh)).toEqual({ tabs: [tabs[0], tabs[2]], active: "3" });
  expect(closeTab(tabs, "3", "3", fresh).active).toBe("2");
  // Another tab closes: the active one stays.
  expect(closeTab(tabs, "1", "3", fresh)).toEqual({ tabs: [tabs[0], tabs[1]], active: "1" });
  // The last tab closes: a fresh one replaces it.
  expect(closeTab([tabs[0]], "1", "1", fresh)).toEqual({ tabs: [fresh], active: "new" });
  expect(closeTab(tabs, "1", "missing", fresh)).toEqual({ tabs, active: "1" });
});

test("Ctrl+Tab and Ctrl+Shift+Tab wrap around", () => {
  const tabs = [tab("1"), tab("2"), tab("3")];
  expect(cycleTab(tabs, "1", 1)).toBe("2");
  expect(cycleTab(tabs, "3", 1)).toBe("1");
  expect(cycleTab(tabs, "1", -1)).toBe("3");
  expect(cycleTab([tabs[0]], "1", 1)).toBe("1");
});

test("tab shortcuts, as the keys really arrive in the webview", () => {
  const press = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    tabShortcut({ key, code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...mods });
  expect(press("t", "KeyT")).toBe("new");
  expect(press("T", "KeyT", { shiftKey: true })).toBe("new");
  expect(press("w", "KeyW")).toBe("close");
  expect(press("Tab", "Tab")).toBe("next");
  expect(press("Tab", "Tab", { shiftKey: true })).toBe("previous");
  // Seen with a real Ctrl+Shift+Tab under GTK: the key has no name, only its position.
  expect(press("Unidentified", "Tab", { shiftKey: true })).toBe("previous");
  expect(press("t", "KeyT", { ctrlKey: false })).toBeNull();
  expect(press("t", "KeyT", { altKey: true })).toBeNull();
  expect(press("f", "KeyF")).toBeNull();
});
