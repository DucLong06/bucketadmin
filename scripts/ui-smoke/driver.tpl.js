// UI smoke driver, evaluated in the app webview (debug builds, BUCKETADMIN_DEV_SCRIPT).
// It acts through the DOM like a user; screenshots are taken by the shell on a shared clock.
(async () => {
  const CFG = __CFG__;
  const { START, STEP, NAMES, UID } = CFG;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const late = [];
  let n = 0;
  function banner(text, ok) {
    const d = document.getElementById("smoke-banner") ?? document.body.appendChild(document.createElement("div"));
    d.id = "smoke-banner";
    d.textContent = text;
    d.style.cssText = "position:fixed;left:0;bottom:0;z-index:99999;padding:4px 8px;font:12px monospace;color:#000;background:" + (ok ? "#8f8" : "#f88");
  }
  // Holds the current screen until slot n ends; the shell photographs it 700 ms before that.
  async function shot(name) {
    if (NAMES[n] !== name) throw new Error(`slot ${n}: shell expects ${NAMES[n]}, driver at ${name}`);
    n += 1;
    const wait = START + n * STEP - Date.now();
    if (wait < 1500) late.push(`${name}:${wait}ms`);
    await sleep(Math.max(wait, 0));
  }
  const visible = (e) => e.getClientRects().length > 0;
  const all = (sel) => [...document.querySelectorAll(sel)].filter(visible);
  const last = (a) => a[a.length - 1];
  const first = (a) => a[0];
  const hasText = (t) => document.body.innerText.includes(t);
  async function waitFor(fn, what, ms = 10000) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + what);
      await sleep(100);
    }
  }
  // Last visible match: dialogs and the drawer are appended after the page, so they win.
  const button = (text) => last(all("button, [role=tab]").filter((e) => e.textContent.trim() === text && !e.disabled));
  const click = async (text) => (await waitFor(() => button(text), `button "${text}"`)).click();
  const clickSel = async (sel) => (await waitFor(() => last(all(sel)), sel)).click();
  function setValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  }
  const field = (label, pick = last) =>
    waitFor(() => {
      const l = pick(all("label").filter((x) => x.textContent.replace(/\s*\*$/, "").trim() === label));
      return l && document.getElementById(l.htmlFor);
    }, `field "${label}"`);
  const type = async (label, value, pick) => setValue(await field(label, pick), value);
  const dialogsGone = () => waitFor(() => all(".MuiDialog-root").length === 0, "dialog to close");
  const openUser = () => clickSel(`[aria-label="Mở chi tiết user ${UID}"]`);
  const chips = () => all(".MuiDrawer-root .MuiChip-deletable");

  try {
    await waitFor(() => button("Clusters"), "app to load", 30000);
    await waitFor(() => hasText("Chưa có cluster nào"), "no-cluster hint");
    await shot("01-users-no-cluster");

    await click("Clusters");
    await type("Tên hiển thị", "lab");
    await type("Endpoint", CFG.ENDPOINT);
    await type("Access key", CFG.AK);
    await type("Secret key", CFG.SK);
    await click("Lưu");
    await waitFor(() => hasText("Đã lưu"), "profile saved");
    await clickSel('[aria-label="Kiểm tra kết nối tới lab"]');
    await waitFor(() => hasText("Kết nối thành công"), "connection ok");
    await shot("02-clusters");

    await click("Users");
    await waitFor(() => all("tbody tr").length >= 2, "user rows");
    await shot("03-users");

    await click("Tạo user");
    await type("uid", UID);
    await type("Display name", "M1 UI demo");
    await type("Email (không bắt buộc)", "demo@example.com");
    await shot("04-create-user");
    await click("Tạo user");
    await waitFor(() => hasText("Key mới"), "one-time secret dialog");
    (await waitFor(() => last(all('[aria-label="Copy access key"]')), "copy button")).focus();
    await shot("05-secret-once"); // the shell presses a real Enter here to exercise Copy
    await shot("-");
    await click("Đã lưu, đóng");
    await dialogsGone();
    await type("Tìm theo uid", "ba-m1");
    await waitFor(() => hasText("Hiển thị 1/"), "filtered list");
    await shot("06-users-filter");

    await openUser();
    await type("Display name", "M1 UI demo (đã sửa)");
    await click("Lưu thay đổi");
    await waitFor(() => hasText("Đã lưu."), "modify saved");
    await shot("07-drawer-info");
    (await waitFor(() => last(all(".MuiSwitch-input")), "suspend switch")).click();
    await waitFor(() => hasText("Suspend user?"), "suspend confirm");
    await shot("08-suspend-confirm");
    await click("Suspend");
    await dialogsGone();
    await waitFor(() => all(".MuiDrawer-root .MuiChip-root").some((c) => c.textContent === "Suspended"), "suspended chip");

    await click("Keys");
    await click("Tạo key mới");
    await waitFor(() => hasText("Key mới"), "new key dialog");
    await click("Đã lưu, đóng");
    await dialogsGone();
    await waitFor(() => all('[aria-label^="Rotate key"]').length === 2, "two keys");
    await shot("09-keys");
    all('[aria-label^="Rotate key"]')[0].click();
    await waitFor(() => hasText("Rotate key?"), "rotate confirm");
    await click("Rotate");
    await waitFor(() => hasText("Key mới"), "rotated key dialog");
    await shot("10-rotate-secret");
    await click("Đã lưu, đóng");
    await dialogsGone();
    last(all('[aria-label^="Xoá key"]')).click();
    await waitFor(() => hasText("Xoá key?"), "remove key confirm");
    await click("Xoá key");
    await dialogsGone();
    await waitFor(() => all('[aria-label^="Rotate key"]').length === 1, "one key left");

    await click("Caps");
    const addCap = async (t, p) => {
      await type("Loại cap", t);
      await type("Quyền", p);
      await click("Thêm cap");
    };
    await addCap("usage", "read");
    await waitFor(() => chips().length === 1, "1 cap");
    await addCap("buckets", "*");
    await waitFor(() => chips().length === 2, "2 caps");
    await type("Cap tuỳ chỉnh (type=perm)", "metadata=read, write");
    await click("Thêm cap tuỳ chỉnh");
    await waitFor(() => chips().length === 3, "3 caps");
    await type("Cap tuỳ chỉnh (type=perm)", "zones=read");
    await click("Thêm cap tuỳ chỉnh");
    await waitFor(() => hasText("InvalidCapability"), "invalid cap error");
    await shot("11-caps");
    chips()[0].querySelector(".MuiChip-deleteIcon").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => chips().length === 2, "cap removed");

    await click("Quota");
    await waitFor(() => hasText("Bucket quota"), "quota forms");
    all(".MuiSwitch-input")[0].click();
    await type("Max size (KB)", "1048576", first);
    await type("Max objects", "1000", first);
    all("button").filter((b) => b.textContent.trim() === "Lưu quota")[0].click();
    await waitFor(() => hasText("Đã lưu quota."), "quota saved");
    const titles = all(".MuiDrawer-root form h3").map((h) => h.textContent).join("|");
    if (titles !== "User quota|Bucket quota") throw new Error("quota forms after save: " + titles);
    await shot("12-quota");

    await click("Usage");
    await waitFor(() => hasText("Chưa có dữ liệu usage"), "usage empty state");
    await shot("13-usage-empty");

    await click("Đóng");
    await waitFor(() => all(".MuiDrawer-root").length === 0, "drawer closed");
    await click("Audit");
    await waitFor(() => all("tbody tr").length >= 10, "audit rows");
    await shot("14-audit");
    await type("Action", "caps.add");
    await waitFor(() => all("tbody tr").length === 4, "4 caps.add rows");
    await shot("15-audit-filter");

    await click("Users");
    await openUser();
    await click("Xoá user");
    await type(`Gõ "${UID}" để xác nhận`, UID);
    await shot("16-delete-confirm");
    await click("Xoá user");
    await waitFor(() => !document.querySelector(`[aria-label="Mở chi tiết user ${UID}"]`), "user removed from table");
    await dialogsGone();
    await shot("17-users-after-delete");

    await click("Clusters");
    await clickSel('[aria-label="Xoá cluster lab"]');
    await waitFor(() => hasText("Chưa có cluster nào."), "cluster removed");
    banner(`SMOKE DONE: ${n + 1} slots, late: [${late.join(", ")}]`, true);
    await shot("18-clusters-removed");
  } catch (e) {
    banner(`SMOKE ERROR in slot ${n} (${NAMES[n]}): ${e.message}`, false);
  }
})();
