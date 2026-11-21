import { expect, test } from "vitest";
import { applyLang } from "./i18n";
import { closeTab, cycleTab, groupRecents, placeLabel, placePath, restoreTabs, samePlace, saveTabs, tabShortcut, tabTitle, type BrowseTab, type Place } from "./tabs";

const place = (bucket = "", prefix = "", clusterId = "c1", uid = ""): Place => ({ clusterId, uid, bucket, prefix });
const tab = (id: string, at = place()): BrowseTab => ({ id, start: at, at });

test("titles and labels of a place", () => {
  applyLang("vi");
  expect(tabTitle(place())).toBe("Tab mới");
  expect(tabTitle(place("logs"))).toBe("logs");
  expect(tabTitle(place("logs", "2026/11/"))).toBe("logs/…/11");
  expect(tabTitle(place("logs", "2026/"))).toBe("logs/2026");
  expect(placePath(place("logs", "2026/11/"))).toBe("logs/2026/11");
  expect(placePath(place("logs"))).toBe("logs");
  const profiles = [{ id: "c1", label: "lab", endpoint: "http://h:1", access_key: "AK" }];
  expect(placeLabel(place("logs", "2026/"), profiles)).toBe("lab · logs/2026");
  expect(placeLabel(place("logs", "", "c1", "alice"), profiles)).toBe("lab · user alice · logs");
  // In a list that is under the connection's name already.
  expect(placeLabel(place("logs", "2026/"), profiles, false)).toBe("logs/2026");
  expect(placeLabel(place("logs", "", "c1", "alice"), profiles, false)).toBe("user alice · logs");
  expect(placeLabel(place("logs", "", "gone"), profiles)).toBe("kết nối đã xoá · logs");
  applyLang("en");
  expect(tabTitle(place())).toBe("New tab");
  // With the connections at hand a tab says which one it is on.
  expect(tabTitle(place("logs"), profiles)).toBe("lab · logs");
  expect(tabTitle(place("logs", "2026/11/"), profiles)).toBe("lab · logs/…/11");
  expect(tabTitle(place(), profiles)).toBe("New tab");
  expect(tabTitle(place("logs", "", "gone"), profiles)).toBe("logs");
  expect(placeLabel(place("logs", "", "gone", "alice"), profiles)).toBe("deleted connection · user alice · logs");
  expect(samePlace(place("a", "b/"), place("a", "b/"))).toBe(true);
  expect(samePlace(place("a", "b/"), place("a", "b/", "c1", "alice"))).toBe(false);
  expect(samePlace(place("a", "b/"), place("a", "b/", "c2"))).toBe(false);
});

test("recent places group by connection; a long mixed list starts with the other connections folded", () => {
  const mixed = [place("a", "", "c2"), place("b"), place("c", "", "c3"), place("d")];
  expect(groupRecents(mixed, "c1")).toEqual({ here: [place("b"), place("d")], elsewhere: [place("a", "", "c2"), place("c", "", "c3")], collapsed: false });
  const long = Array.from({ length: 16 }, (_, i) => place(`b${i}`, "", i % 2 ? "c1" : "c2"));
  expect(groupRecents(long, "c1").collapsed).toBe(true);
  expect(groupRecents(long.slice(0, 15), "c1").collapsed).toBe(false);
  // Sixteen places of one connection: nothing to fold.
  expect(groupRecents(long.map((p) => ({ ...p, clusterId: "c1" })), "c1")).toMatchObject({ elsewhere: [], collapsed: false });
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
  // Ctrl+D pins the place of the tab on screen (also with Caps Lock on); it takes no other modifier.
  expect(press("d", "KeyD")).toBe("pin");
  expect(press("D", "KeyD")).toBe("pin");
  expect(press("D", "KeyD", { shiftKey: true })).toBeNull();
  expect(press("d", "KeyD", { altKey: true })).toBeNull();
  expect(press("d", "KeyD", { ctrlKey: false })).toBeNull();
});

test("open tabs are saved and come back after a relaunch, without those whose connection is gone", () => {
  const where = (clusterId: string, bucket = "", prefix = ""): Place => ({ clusterId, uid: "", bucket, prefix });
  const open: BrowseTab[] = [
    { id: "t1", start: where("c1"), at: where("c1", "logs", "2026/11/") },
    { id: "t2", start: where("c2", "media"), at: where("c2", "media", "clips/") },
    { id: "t3", start: where("c1"), at: where("c1") },
  ];
  // Saved: where each tab is now (not where it started), and which one is on screen.
  const saved = saveTabs(open, "t2");
  expect(saved).toEqual({ tabs: [{ id: "t1", at: open[0].at }, { id: "t2", at: open[1].at }, { id: "t3", at: open[2].at }], active: "t2" });
  // Through JSON, as settings.json holds it.
  const read = JSON.parse(JSON.stringify(saved));

  // Restored: every tab starts where it was.
  const all = restoreTabs(read, ["c1", "c2"]);
  expect(all?.active).toBe("t2");
  expect(all?.tabs).toEqual(open.map((tab) => ({ id: tab.id, start: tab.at, at: tab.at })));

  // Connection c2 was removed meanwhile: its tab is dropped, and the first tab left is shown.
  const fewer = restoreTabs(read, ["c1"]);
  expect(fewer?.tabs.map((tab) => tab.id)).toEqual(["t1", "t3"]);
  expect(fewer?.active).toBe("t1");
  // The tab on screen is kept when it survives.
  expect(restoreTabs(saveTabs(open, "t3"), ["c1"])?.active).toBe("t3");

  // Nothing to restore: a first start, an empty list, or no connection left.
  expect(restoreTabs(null, ["c1"])).toBeNull();
  expect(restoreTabs(undefined, ["c1"])).toBeNull();
  expect(restoreTabs({ tabs: [], active: "" }, ["c1"])).toBeNull();
  expect(restoreTabs(read, [])).toBeNull();
  expect(restoreTabs(read, ["c9"])).toBeNull();
});
