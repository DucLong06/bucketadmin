// Pinned places: bookmarks to a bucket or to a prefix deep inside one, kept in settings.json
// (backend `pin_*` commands) in the user's own order.
import { placePath, samePlace, type Place } from "./tabs";

/** `label` is the user's own name for the place ("" = show its path); `added` is unix seconds. */
export type Pin = { place: Place; label: string; added: number };
/** What the UI may ask of the pin list; the app applies it at once and then takes the saved list. */
export type PinOps = {
  toggle: (place: Place) => void;
  rename: (place: Place, label: string) => void;
  move: (place: Place, to: number) => void;
};

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
