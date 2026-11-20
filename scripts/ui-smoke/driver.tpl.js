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
  // The app's own string table in the language under test (CFG.STR, from src/i18n/strings.ts):
  // the flow names texts by key, so it runs in either language. Same rules as t() in
  // src/i18n/index.ts: {name} is a variable, {n:one|other} picks a form by whether n is 1.
  const HOLE = /\{(\w+)(?::([^|}]*)\|([^}]*))?\}/g;
  const T = (key, vars = {}) => {
    if (!(key in CFG.STR)) throw new Error(`no string "${key}" in the ${CFG.LANG} table`);
    return CFG.STR[key].replace(HOLE, (whole, name, one, other) => {
      if (!(name in vars)) return whole;
      return other === undefined ? String(vars[name]) : vars[name] === 1 ? (one ?? "") : other;
    });
  };
  // The fixed text of a string around the variables the flow cannot know (those left out of `vars`).
  const fixed = (key, vars) => T(key, vars).split(/\{\w+(?::[^}]*)?\}/);
  // The sentence of `key` is on screen, whatever stands in for the variables left out.
  const like = (key, vars) => new RegExp(fixed(key, vars).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+?"));
  const seen = (key, vars) => like(key, vars).test(document.body.innerText);
  // The longest fixed piece of a string: enough to recognise it when no variable is known.
  const piece = (key) => fixed(key).reduce((a, b) => (b.length > a.length ? b : a));
  // Sizes: the decimal mark follows the language ("4.00 KiB" is "4,00 KiB" in Vietnamese).
  const num = (text) => (CFG.LANG === "vi" ? text.replace(".", ",") : text);
  // Selectors by accessible name: the whole name, or how it begins when it ends in a variable.
  const sel = (key, vars) => `[aria-label="${T(key, vars)}"]`;
  const starts = (key) => `[aria-label^="${piece(key)}"]`;
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
  // These close when the request behind them has answered; the lab can take its time over a delete.
  const dialogsGone = () => waitFor(() => all(".MuiDialog-root").length === 0, "dialog to close", 30000);
  const drawersGone = () => waitFor(() => all(".MuiDrawer-root").length === 0, "drawer to close", 30000);
  const menusGone = () => waitFor(() => all(".MuiPopover-root").length === 0, "menu to close");
  const idle = (what) => waitFor(() => all(".MuiLinearProgress-root").length === 0, what, 20000);

  try {
    // __FLOW__
  } catch (e) {
    banner(`SMOKE ERROR in slot ${n} (${NAMES[n]}): ${e.message}`, "#f88");
  }
})();
