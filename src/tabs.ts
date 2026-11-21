import type { Profile } from "./api";
import { t } from "./i18n";

/** A place that can be browsed: a prefix of a bucket on a connection. `uid` is empty for the
 *  connection's own key; `bucket` is empty while no bucket is open. */
export type Place = { clusterId: string; uid: string; bucket: string; prefix: string };
/** A browse tab: where it started (read once, when it is created) and where it is now. */
export type BrowseTab = { id: string; start: Place; at: Place };

export const samePlace = (a: Place, b: Place) =>
  a.clusterId === b.clusterId && a.uid === b.uid && a.bucket === b.bucket && a.prefix === b.prefix;

/** "logs/2026/11/" as a path the user reads: bucket and prefix, without the trailing slash. */
export const placePath = (p: Place) => (p.bucket ? `${p.bucket}/${p.prefix}`.replace(/\/$/, "") : "");

/** Tab title: "connection · bucket", then the open folder's name ("lab · logs/…/11"); "New tab"
 *  while no bucket is open. With many connections a bucket name alone does not say where a tab is. */
export function tabTitle(at: Place, profiles: Profile[] = []): string {
  if (!at.bucket) return t("tabs.new");
  const folders = at.prefix.split("/").filter(Boolean);
  const where = [at.bucket, ...(folders.length > 1 ? ["…"] : []), ...folders.slice(-1)].join("/");
  const connection = profiles.find((p) => p.id === at.clusterId)?.label;
  return connection ? `${connection} · ${where}` : where;
}

/** A mixed list of recent places is collapsed to this connection's own above this many entries. */
export const RECENT_COLLAPSE_ABOVE = 15;

/** Recent places grouped like the pins: this connection's first, the others after (each newest first).
 *  `collapsed`: the others start folded away, because the whole list is long. */
export function groupRecents(recents: Place[], clusterId: string) {
  const here = recents.filter((place) => place.clusterId === clusterId);
  const elsewhere = recents.filter((place) => place.clusterId !== clusterId);
  return { here, elsewhere, collapsed: elsewhere.length > 0 && recents.length > RECENT_COLLAPSE_ABOVE };
}

/** Full description for tooltips and the recent list: "lab · logs/2026/11". Without `connection`
 *  (a list that is under that connection's name already): "logs/2026/11". */
export function placeLabel(at: Place, profiles: Profile[], connection = true): string {
  const name = profiles.find((p) => p.id === at.clusterId)?.label ?? t("tabs.goneConnection");
  return [connection && name, at.uid && t("common.userNamed", { uid: at.uid }), placePath(at)].filter(Boolean).join(" · ");
}

/** The open tabs as they are saved for the next start (backend `tabs_set` / `tabs_get`). */
export type SavedTabs = { tabs: { id: string; at: Place }[]; active: string };

export const saveTabs = (tabs: BrowseTab[], active: string): SavedTabs => ({ tabs: tabs.map(({ id, at }) => ({ id, at })), active });

/** The tabs to show again after a relaunch: each starts where it was. Tabs whose connection is
 *  gone are dropped; null when none is left (the app then opens its usual first tab). */
export function restoreTabs(saved: SavedTabs | null | undefined, clusterIds: string[]): { tabs: BrowseTab[]; active: string } | null {
  const kept = (saved?.tabs ?? []).filter((tab) => clusterIds.includes(tab.at.clusterId));
  if (!saved || kept.length === 0) return null;
  // The tab that was on screen, or the first one when that tab was dropped.
  const active = kept.some((tab) => tab.id === saved.active) ? saved.active : kept[0].id;
  return { tabs: kept.map(({ id, at }) => ({ id, start: at, at })), active };
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

/** What a key press asks of the tab bar: Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, and Ctrl+D (pin the tab's place); null for anything else. */
export function tabShortcut(e: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): "new" | "close" | "next" | "previous" | "pin" | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  // Tab by its physical key: with Shift held, GTK sends ISO_Left_Tab, which WebKit reports as key "Unidentified".
  if (e.code === "Tab" || e.key === "Tab") return e.shiftKey ? "previous" : "next";
  const key = e.key.toLowerCase();
  return key === "t" ? "new" : key === "w" ? "close" : key === "d" && !e.shiftKey ? "pin" : null;
}
