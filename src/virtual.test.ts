import { expect, test } from "vitest";
import { visibleRange } from "./virtual";

test("renders the rows in view plus overscan, never out of bounds", () => {
  // 36 px rows, 360 px viewport: 10 rows in view.
  expect(visibleRange(0, 360, 36, 100000)).toEqual([0, 18]);
  expect(visibleRange(3600, 360, 36, 100000)).toEqual([92, 118]);
  expect(visibleRange(3610, 360, 36, 100000)).toEqual([92, 119]); // a partly visible row counts
  expect(visibleRange(0, 360, 36, 5)).toEqual([0, 5]);
  expect(visibleRange(0, 360, 36, 0)).toEqual([0, 0]);
  // Scrolled past the end (the list shrank after a reload): nothing, not a negative slice.
  expect(visibleRange(99999, 360, 36, 5)).toEqual([5, 5]);
  expect(visibleRange(36 * 50, 360, 36, 100000, 0)).toEqual([50, 60]);
});

test("the window stays small however long the list is", () => {
  const [first, last] = visibleRange(36 * 500_000, 600, 36, 1_000_000);
  expect(last - first).toBeLessThan(40);
});
