// UI smoke driver, evaluated in the app webview (debug builds, BUCKETADMIN_DEV_SCRIPT).
// It acts through the DOM like a user; screenshots are taken by the shell on a shared clock.
// Data it expects on the cluster comes from the `ui_smoke_fixture_create` test (see ui-smoke.sh).
(async () => {
  const CFG = __CFG__;
  const { START, STEP, NAMES, UID } = CFG;
  const DATA_UID = "ba-m3-ui-data";
  const DATA_BUCKET = "ba-m3-ui-data-bucket";
  const EMPTY_BUCKET = "ba-m3-ui-empty";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const late = [];
  let n = 0;
  function banner(text, color) {
    const d = document.getElementById("smoke-banner") ?? document.body.appendChild(document.createElement("div"));
    d.id = "smoke-banner";
    d.textContent = text;
    d.style.cssText = "position:fixed;left:0;bottom:0;z-index:99999;padding:4px 8px;font:12px monospace;color:#000;background:" + color;
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
  const check = (ok, what) => {
    if (!ok) throw new Error("check failed: " + what);
  };
  // Last visible match: dialogs and drawers are appended after the page, so they win.
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
  const drawersGone = () => waitFor(() => all(".MuiDrawer-root").length === 0, "drawer to close");
  const idle = (what) => waitFor(() => all(".MuiLinearProgress-root").length === 0, what, 20000);
  const openUser = (uid) => clickSel(`[aria-label="Mở chi tiết user ${uid}"]`);
  const openBucket = (name) => clickSel(`[aria-label="Mở chi tiết bucket ${name}"]`);
  const chips = () => all(".MuiDrawer-root .MuiChip-deletable");
  const rows = () => all("tbody tr").length;
  // Users come in pages of 25 behind a "load more" button.
  async function loadAllUsers() {
    for (;;) {
      await waitFor(() => all(".MuiLinearProgress-root").length === 0 && hasText("user đã tải"), "user page", 20000);
      if (hasText("đã tải hết")) return;
      const before = rows();
      await click("Tải thêm 25 user");
      await waitFor(() => rows() > before || hasText("đã tải hết"), "next user page", 20000);
    }
  }
  async function deleteOpenUser(uid, purge) {
    await click("Thông tin");
    await click("Xoá user");
    if (purge) {
      last(all(".MuiDialog-root input[type=checkbox]")).click();
      await waitFor(() => hasText("không khôi phục được"), "purge warning");
    }
    await type(`Gõ "${uid}" để xác nhận`, uid);
  }

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

    // ---- Users: paging
    await click("Users");
    await waitFor(() => all(".MuiLinearProgress-root").length === 0 && hasText("user đã tải"), "first user page", 20000);
    check(rows() === 25, `first page shows 25 users, got ${rows()}`);
    check(!!button("Tải thêm 25 user"), "load-more button is offered");
    await shot("03-users-page-1");
    await loadAllUsers();
    check(rows() >= 30, `all fixture users are listed, got ${rows()}`);
    await shot("04-users-all");

    // ---- create user, one-time secret
    await click("Tạo user");
    await type("uid", UID);
    await type("Display name", "M3 UI demo");
    await type("Email (không bắt buộc)", "demo@example.com");
    await shot("05-create-user");
    await click("Tạo user");
    await waitFor(() => hasText("Key mới"), "one-time secret dialog");
    (await waitFor(() => last(all('[aria-label="Copy access key"]')), "copy button")).focus();
    await shot("06-secret-once"); // the shell presses a real Enter here to exercise Copy
    await shot("-");
    await click("Đã lưu, đóng");
    await dialogsGone();
    await type("Tìm theo uid", "ba-m1");
    await waitFor(() => hasText("Hiển thị 1/"), "filtered list");
    await shot("07-users-filter");

    // ---- drawer: info, suspend
    await openUser(UID);
    await type("Display name", "M3 UI demo (đã sửa)");
    await click("Lưu thay đổi");
    await waitFor(() => hasText("Đã lưu."), "modify saved");
    await shot("08-drawer-info");
    (await waitFor(() => last(all(".MuiSwitch-input")), "suspend switch")).click();
    await waitFor(() => hasText("Suspend user?"), "suspend confirm");
    await shot("09-suspend-confirm");
    await click("Suspend");
    await dialogsGone();
    await waitFor(() => all(".MuiDrawer-root .MuiChip-root").some((c) => c.textContent === "Suspended"), "suspended chip");

    // ---- keys: generate, rotate, remove, add an existing pair
    await click("Keys");
    await click("Tạo key mới");
    await waitFor(() => hasText("Key mới"), "new key dialog");
    await click("Đã lưu, đóng");
    await dialogsGone();
    await waitFor(() => all('[aria-label^="Rotate key"]').length === 2, "two keys");
    await shot("10-keys");
    all('[aria-label^="Rotate key"]')[0].click();
    await waitFor(() => hasText("Rotate key?"), "rotate confirm");
    await click("Rotate");
    await waitFor(() => hasText("Key mới"), "rotated key dialog");
    await shot("11-rotate-secret");
    await click("Đã lưu, đóng");
    await dialogsGone();
    last(all('[aria-label^="Xoá key"]')).click();
    await waitFor(() => hasText("Xoá key?"), "remove key confirm");
    await click("Xoá key");
    await dialogsGone();
    await waitFor(() => all('[aria-label^="Rotate key"]').length === 1, "one key left");
    await click("Thêm key có sẵn");
    await type("Access key", "short");
    await type("Secret key", "x");
    await waitFor(() => hasText("không có dấu cách") && hasText("chữ, số và / + ="), "key format errors");
    check(!button("Thêm key"), "add button is disabled for a malformed key");
    await shot("12-add-key-validation");
    await type("Access key", "SMOKEMANUALKEY000001");
    await type("Secret key", "smokeManualSecret/0123456789+abcdefghij=");
    await click("Thêm key");
    await dialogsGone();
    await waitFor(() => hasText("SMOKEMANUALKEY000001"), "manual key listed");
    check(all('[aria-label^="Rotate key"]').length === 2, "user has two keys after the manual add");

    // ---- subusers
    await click("Subusers");
    await type("Tên subuser", "swift1");
    await type("Quyền", "full");
    await click("Tạo subuser");
    await waitFor(() => hasText("Swift user"), "swift secret dialog");
    await shot("13-subuser-secret");
    await click("Đã lưu, đóng");
    await dialogsGone();
    await waitFor(() => hasText(`${UID}:swift1`) && hasText("full-control"), "subuser listed");
    await shot("14-subusers");

    // ---- caps, with a backend error shown in Vietnamese
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
    await waitFor(() => hasText("Cap không hợp lệ với bản Ceph này."), "translated error");
    check(hasText("Chi tiết kỹ thuật (InvalidCapability)"), "error code is offered");
    check(!hasText("invalid admin capability"), "original text stays collapsed");
    last(all("details")).open = true;
    await waitFor(() => hasText("invalid admin capability"), "original text after expanding");
    await shot("15-caps-error");
    chips()[0].querySelector(".MuiChip-deleteIcon").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => chips().length === 2, "cap removed");

    // ---- user quota, user buckets (none), usage
    await click("Quota");
    await waitFor(() => hasText("Bucket quota"), "quota forms");
    all(".MuiSwitch-input")[0].click();
    await type("Max size (KB)", "1048576", first);
    await type("Max objects", "1000", first);
    all("button").filter((b) => b.textContent.trim() === "Lưu quota")[0].click();
    await waitFor(() => hasText("Đã lưu quota."), "quota saved");
    const titles = all(".MuiDrawer-root form h3").map((h) => h.textContent).join("|");
    check(titles === "User quota|Bucket quota", "quota forms after save: " + titles);
    await shot("16-quota");
    await click("Buckets");
    await waitFor(() => hasText("User chưa có bucket nào."), "empty bucket list of the new user");
    await click("Usage");
    await waitFor(() => hasText("Chưa có dữ liệu usage") || all('[aria-label="Usage theo bucket"]').length > 0, "usage loaded");
    check(!!(await field("Từ ngày (UTC)")).value && !!(await field("Đến hết ngày (UTC)")).value, "date range is prefilled");
    await shot("17-usage");

    await click("Đóng");
    await drawersGone();
    await click("Audit");
    await waitFor(() => rows() >= 12, "audit rows");
    await shot("18-audit");
    await type("Action", "subuser.create");
    await waitFor(() => rows() === 1 && hasText("subuser=swift1 access=full"), "subuser.create row");
    await type("Action", "caps.add");
    await waitFor(() => rows() === 4, "4 caps.add rows");
    await shot("19-audit-filter");

    // ---- Buckets page
    await click("Buckets");
    await idle("bucket list");
    await waitFor(() => hasText(DATA_BUCKET) && hasText(EMPTY_BUCKET), "fixture buckets listed");
    await shot("20-buckets");
    await openBucket(DATA_BUCKET);
    await waitFor(() => hasText("s3:GetObject") && hasText("Có policy"), "bucket detail with policy");
    check(hasText("Bucket còn 1 object"), "non-empty bucket cannot be deleted");
    check(!button("Xoá bucket"), "delete button is disabled for a non-empty bucket");
    await shot("21-bucket-drawer");
    last(all(".MuiDrawer-root .MuiSwitch-input")).click();
    await type("Max size (KB)", "1024");
    await type("Max objects", "10");
    await click("Lưu quota");
    await waitFor(() => hasText("Đã lưu quota.") && hasText("Có quota riêng"), "bucket quota saved");
    last(all(".MuiDrawer-paper")).scrollTop = 100000;
    await sleep(300);
    await shot("22-bucket-quota-policy");
    await click("Đóng");
    await drawersGone();
    await waitFor(() => hasText("Đang bật"), "quota shown in the bucket list");
    await openBucket(EMPTY_BUCKET);
    await waitFor(() => hasText("Bucket đang rỗng nên có thể xoá."), "empty bucket detail");
    await click("Xoá bucket");
    await type(`Gõ "${EMPTY_BUCKET}" để xác nhận`, EMPTY_BUCKET);
    await shot("23-bucket-delete-confirm");
    await click("Xoá bucket");
    await drawersGone();
    await waitFor(() => !hasText(EMPTY_BUCKET), "bucket removed from the list");
    await shot("24-buckets-after-delete");

    // ---- a user that owns data: buckets tab, delete with purge-data
    await click("Users");
    await loadAllUsers();
    await openUser(DATA_UID);
    await click("Buckets");
    await waitFor(() => hasText(DATA_BUCKET) && hasText("Có quota riêng"), "user's bucket with its quota");
    await shot("25-user-buckets");
    await deleteOpenUser(DATA_UID, true);
    await shot("26-purge-confirm");
    await click("Xoá user và dữ liệu");
    await waitFor(() => !document.querySelector(`[aria-label="Mở chi tiết user ${DATA_UID}"]`), "data user removed", 20000);
    await dialogsGone();
    await openUser(UID);
    await deleteOpenUser(UID, false);
    await click("Xoá user");
    await waitFor(() => !document.querySelector(`[aria-label="Mở chi tiết user ${UID}"]`), "smoke user removed");
    await dialogsGone();
    await click("Buckets");
    await idle("bucket list");
    await waitFor(() => !hasText(DATA_BUCKET), "purge-data removed the bucket");
    await shot("27-buckets-after-purge");

    await click("Clusters");
    await clickSel('[aria-label="Xoá cluster lab"]');
    await waitFor(() => hasText("Chưa có cluster nào."), "cluster removed");
    banner(`SMOKE DONE: ${n + 1} slots, late: [${late.join(", ")}]`, late.length ? "#fc6" : "#8f8");
    await shot("28-clusters-removed");
  } catch (e) {
    banner(`SMOKE ERROR in slot ${n} (${NAMES[n]}): ${e.message}`, "#f88");
  }
})();
