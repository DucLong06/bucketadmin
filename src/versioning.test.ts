import { expect, test } from "vitest";
import { applyLang } from "./i18n";
import { canUndelete, finalDeleteWarning, undeleteHint } from "./ObjectDrawer";

const state = (supported: boolean, status: string) => ({ supported, status, reason: null });

test("only a bucket with versioning on can undo a delete; every other state gets the red warning", () => {
  applyLang("vi");
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
  expect(undeleteHint()).toMatch(/khôi phục được từ tab Phiên bản/);
  // The same warnings in English.
  applyLang("en");
  expect(finalDeleteWarning(state(true, ""))).toMatch(/not enabled.*CANNOT BE UNDONE/);
  expect(finalDeleteWarning(state(true, "Suspended"))).toMatch(/suspended.*CANNOT BE UNDONE/);
  expect(finalDeleteWarning(state(false, "Enabled"))).toMatch(/could not be read.*CANNOT BE UNDONE/);
  expect(undeleteHint()).toMatch(/restored from the Versions tab/);
});
