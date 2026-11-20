import type { Profile } from "./api";

/** A place that can be browsed: a prefix of a bucket on a connection. `uid` is empty for the
 *  connection's own key; `bucket` is empty while no bucket is open. */
export type Place = { clusterId: string; uid: string; bucket: string; prefix: string };
/** A browse tab: where it started (read once, when it is created) and where it is now. */
export type BrowseTab = { id: string; start: Place; at: Place };

export const samePlace = (a: Place, b: Place) =>
  a.clusterId === b.clusterId && a.uid === b.uid && a.bucket === b.bucket && a.prefix === b.prefix;

/** "logs/2026/11/" as a path the user reads: bucket and prefix, without the trailing slash. */
export const placePath = (p: Place) => (p.bucket ? `${p.bucket}/${p.prefix}`.replace(/\/$/, "") : "");

/** Short tab title: the open folder's name, else the bucket, else "Tab mới". */
export function tabTitle(at: Place): string {
  if (!at.bucket) return "Tab mới";
  const folders = at.prefix.split("/").filter(Boolean);
  return folders.length > 0 ? folders[folders.length - 1] : at.bucket;
}

/** Full description for tooltips and the recent list: "lab · logs/2026/11". */
export function placeLabel(at: Place, profiles: Profile[]): string {
  const connection = profiles.find((p) => p.id === at.clusterId)?.label ?? "kết nối đã xoá";
  return [connection, at.uid && `user ${at.uid}`, placePath(at)].filter(Boolean).join(" · ");
}

/** Closes a tab. The tab to its right (else to its left) becomes active when the active one
 *  goes; closing the last tab leaves `fresh` in its place, so there is always a tab. */
export function closeTab(tabs: BrowseTab[], active: string, id: string, fresh: BrowseTab): { tabs: BrowseTab[]; active: string } {
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return { tabs, active };
  const left = tabs.filter((t) => t.id !== id);
  if (left.length === 0) return { tabs: [fresh], active: fresh.id };
  return { tabs: left, active: active === id ? left[Math.min(at, left.length - 1)].id : active };
}

/** The tab `step` places after the active one, wrapping around (Ctrl+Tab, Ctrl+Shift+Tab). */
export function cycleTab(tabs: BrowseTab[], active: string, step: 1 | -1): string {
  const at = tabs.findIndex((t) => t.id === active);
  return tabs.length === 0 ? active : tabs[(at + step + tabs.length) % tabs.length].id;
}

/** What a key press asks of the tab bar: Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab; null for anything else. */
export function tabShortcut(e: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): "new" | "close" | "next" | "previous" | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  // Tab by its physical key: with Shift held, GTK sends ISO_Left_Tab, which WebKit reports as key "Unidentified".
  if (e.code === "Tab" || e.key === "Tab") return e.shiftKey ? "previous" : "next";
  const key = e.key.toLowerCase();
  return key === "t" ? "new" : key === "w" ? "close" : null;
}
