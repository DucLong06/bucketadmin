// Pinned places: bookmarks to a bucket or to a prefix deep inside one, kept in settings.json
// (backend `pin_*` commands) in the user's own order.
import { explain } from "./errors";
import { t } from "./i18n";
import { placePath, samePlace, type Place } from "./tabs";

/** `label` is the user's own name for the place ("" = show its path); `added` is unix seconds. */
export type Pin = { place: Place; label: string; added: number };
/** What the UI may ask of the pin list; the app applies it at once and then takes the saved list. */
export type PinOps = {
  toggle: (place: Place) => void;
  rename: (place: Place, label: string) => void;
  move: (place: Place, to: number) => void;
  /** Pins each place (M14); `invalid`: items of the same list that were no place, for the summary. */
  pinMany: (places: Place[], invalid?: number) => Promise<PinSummary>;
};

/** What pinning a list did. `stopped`: how many were left when a pin was refused, and why (the 100-pin cap). */
export type PinSummary = { pinned: number; already: number; invalid: number; stopped?: { left: number; error: string } };

/** The summary line: "Pinned 4, already pinned 1, not valid 0", and what stopped the rest. */
export const pinSummaryText = ({ pinned, already, invalid, stopped }: PinSummary) =>
  [t("pins.batchDone", { pinned, already, invalid }), stopped && t("pins.batchStopped", { n: stopped.left, reason: explain(stopped.error).message })].filter(Boolean).join(" · ");

/** Pins `places` one by one with `add` (the backend's `pin_add`, which answers with the saved list), in order.
 *  A place pinned already is counted, not pinned again; the first refusal stops the rest. */
export async function pinAll(pins: Pin[], places: Place[], add: (place: Place) => Promise<Pin[]>, invalid = 0): Promise<{ pins: Pin[]; summary: PinSummary }> {
  const summary: PinSummary = { pinned: 0, already: 0, invalid };
  for (const [i, place] of places.entries()) {
    if (isPinned(pins, place)) {
      summary.already++;
      continue;
    }
    try {
      pins = await add(place);
      summary.pinned++;
    } catch (e) {
      summary.stopped = { left: places.length - i, error: String(e) };
      break;
    }
  }
  return { pins, summary };
}

export const isPinned = (pins: Pin[], place: Place) => pins.some((pin) => samePlace(pin.place, place));

/** What a pin without a name of its own is called: its path ("logs" or "logs/2026/11"). */
export const defaultLabel = placePath;
export const pinLabel = (pin: Pin) => pin.label || defaultLabel(pin.place);

/** Pins whose name or path contains `text`, whatever the case. */
export const filterPins = (pins: Pin[], text: string): Pin[] => {
  const wanted = text.trim().toLowerCase();
  return wanted ? pins.filter((pin) => [pin.label, placePath(pin.place)].some((field) => field.toLowerCase().includes(wanted))) : pins;
};

/** The list after a click on the pin toggle of `place`: unpinned when it was pinned, else added last. */
export const togglePin = (pins: Pin[], place: Place, now: number): Pin[] =>
  isPinned(pins, place) ? pins.filter((pin) => !samePlace(pin.place, place)) : [...pins, { place, label: "", added: now }];

/** The list with the pin of `place` at position `to` (clamped), as the backend's `pin_move` leaves it. */
export function movePin(pins: Pin[], place: Place, to: number): Pin[] {
  const at = pins.findIndex((pin) => samePlace(pin.place, place));
  if (at < 0) return pins;
  const rest = pins.filter((_, i) => i !== at);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, pins[at]);
  return rest;
}

/** The sidebar's order: the pins of the connection being browsed first, then the others; each
 *  group keeps the user's order. `index` is the pin's position in the whole list (for moving it). */
export function orderPins(pins: Pin[], clusterId: string) {
  const indexed = pins.map((pin, index) => ({ pin, index }));
  return { here: indexed.filter(({ pin }) => pin.place.clusterId === clusterId), elsewhere: indexed.filter(({ pin }) => pin.place.clusterId !== clusterId) };
}

/** What "Pin a path…" does. No connection at all: nothing (the item is disabled and says why). The tab on
 *  screen is on a saved connection: the path is pinned there. Else (a tab with no connection, or nothing
 *  loaded into it yet): the dialog asks which connection, starting from the first. */
export function pinTarget(tabCluster: string | undefined, connections: string[]): { clusterId: string; ask: boolean } | null {
  if (connections.length === 0) return null;
  return tabCluster && connections.includes(tabCluster) ? { clusterId: tabCluster, ask: false } : { clusterId: connections[0], ask: true };
}
