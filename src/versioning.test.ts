import { expect, test } from "vitest";
import { canUndelete, finalDeleteWarning } from "./ObjectDrawer";

const state = (supported: boolean, status: string) => ({ supported, status, reason: null });

test("only a bucket with versioning on can undo a delete; every other state gets the red warning", () => {
  expect(canUndelete(state(true, "Enabled"))).toBe(true);
  for (const [v, why] of [
    [state(true, ""), /chưa bật versioning/],
    [state(true, "Suspended"), /đang tạm dừng/],
    // A key that may not ask: unknown is treated as final.
    [state(false, ""), /Không đọc được trạng thái versioning/],
    [state(false, "Enabled"), /Không đọc được/],
  ] as const) {
    expect(canUndelete(v)).toBe(false);
    expect(finalDeleteWarning(v)).toMatch(why);
    expect(finalDeleteWarning(v)).toMatch(/KHÔNG THỂ HOÀN TÁC/);
  }
});
