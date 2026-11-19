import { expect, test } from "vitest";
import { MAX_RUNNING, percent, takeRunnable } from "./transfers";

test("the queue starts only as many tasks as there are free slots, oldest first", () => {
  const waiting = ["a", "b", "c", "d", "e"];
  expect(takeRunnable(waiting, 0)).toEqual(["a", "b", "c"]);
  expect(waiting).toEqual(["d", "e"]);
  expect(takeRunnable(waiting, MAX_RUNNING)).toEqual([]); // all slots busy
  expect(takeRunnable(waiting, MAX_RUNNING - 1)).toEqual(["d"]); // one finished
  expect(takeRunnable(waiting, MAX_RUNNING + 2)).toEqual([]); // never negative
  expect(takeRunnable(waiting, 0)).toEqual(["e"]);
  expect(takeRunnable(waiting, 0)).toEqual([]);
});

test("percent is bounded and safe before the total is known", () => {
  expect(percent(0, 0)).toBe(0);
  expect(percent(8, 20)).toBe(40);
  expect(percent(25, 20)).toBe(100);
});
