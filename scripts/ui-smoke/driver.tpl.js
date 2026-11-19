// UI smoke driver, evaluated in the app webview (debug builds, BUCKETADMIN_DEV_SCRIPT).
// It acts through the DOM like a user; screenshots are taken by the shell on a shared clock.
// ui-smoke.sh puts flow-browse.js in place of the __FLOW__ line and creates the data the flow
// expects on the cluster.
(async () => {
  // The app runs this script on every page load; only the first one starts the flow.
  if (window.__smokeStarted) return;
  window.__smokeStarted = true;
  const CFG = __CFG__;
  const { START, STEP, NAMES } = CFG;
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
  // A browse tab that is not on screen stays mounted but hidden (visibility), and so do its rows.
  const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
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
  const button = (text) => last(all("button, [role=tab], [role=menuitem]").filter((e) => e.textContent.trim() === text && !e.disabled));
  const click = async (text) => (await waitFor(() => button(text), `button "${text}"`)).click();
  const clickSel = async (sel) => (await waitFor(() => last(all(sel)), sel)).click();
  function setValue(el, value) {
    const proto = [HTMLSelectElement, HTMLTextAreaElement].find((c) => el instanceof c)?.prototype ?? HTMLInputElement.prototype;
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
  const menusGone = () => waitFor(() => all(".MuiPopover-root").length === 0, "menu to close");
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
    // __FLOW__
  } catch (e) {
    banner(`SMOKE ERROR in slot ${n} (${NAMES[n]}): ${e.message}`, "#f88");
  }
})();
