    // The responsive pass (FLOW=responsive): the same screens at every window width and zoom step of
    // the matrix below, in a window 700 px high. Data comes from the browse fixture (tests/s3_lab.rs):
    // the owner's key (one bucket with folders) and the key that owns 32 empty buckets.
    // What must hold in every cell: nothing scrolls sideways, no heading is cut short without a tooltip,
    // the sidebar and its bucket card are wholly in view, a dialog fits, the tab bar scrolls inside itself.
    const WIDTHS = [900, 1000, 1100, 1280, 1440, 1920];
    const SCALES = [100, 125, 150];
    const HEIGHT = 700;
    const BUCKET = "ba-m4-ui-bucket";
    const KEY = (n) => ({ ak: `BAM7UISMOKEKEY00000${n}`, sk: `bam7uismokesecret00000000000000000000000${n}` });
    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
    // A line in the app's stdout (ui-smoke.sh prints it): the result of each cell as text, not only as a banner.
    const say = (line) => invoke("dev_log", { line: `responsive: ${line}` });
    const page = document.documentElement;
    const press = (key) => window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
    const tabs = () => all(`${sel("app.tabs")} [role=tab]`);
    const folder = (prefix) => sel("browse.openFolder", { folder: prefix });
    const bucketButtons = `${sel("browse.bucketList")} [role=button]`;
    const connectionField = () => first(all("aside select"));
    const connectionShown = () => connectionField()?.selectedOptions[0]?.textContent;
    const useConnection = async (label) => {
      const f = await waitFor(connectionField, "the connection field of the tab");
      setValue(f, (await waitFor(() => [...f.options].find((o) => o.textContent === label), `connection ${label} in the tab's list`)).value);
    };
    const addConnection = async (label, key) => {
      await click(T("app.connections"));
      // First run: the screen is one card with one button; the form comes with it.
      const add = await waitFor(() => button(T("conn.add")) || all("form").length, "the Connections screen");
      if (add.click) add.click();
      await type(T("conn.label"), label);
      await type(T("conn.endpoint"), CFG.ENDPOINT);
      await type(T("conn.accessKey"), key.ak);
      await type(T("conn.secretKey"), key.sk);
      // The lab is a private address: "no proxy" is suggested for it.
      await waitFor(() => hasText(T("conn.internalHint")), "the no-proxy suggestion");
      await click(T("conn.noProxy.pick"));
      await click(T("common.save"));
      await waitFor(() => hasText(T("conn.saved", { label })), `connection ${label} saved`, 20000);
    };
    const removeConnection = async (label) => {
      await clickSel(sel("conn.more", { label }));
      await clickSel(sel("conn.remove", { label }));
      await click(T("conn.removeConfirm"));
      await dialogsGone();
    };
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return r.left >= -0.5 && r.top >= -0.5 && r.right <= page.clientWidth + 0.5 && r.bottom <= page.clientHeight + 0.5;
    };
    const problems = [];
    // Every screen: nothing scrolls sideways (the page, the pane of a view, a dialog), and a heading that is cut short has a tooltip.
    function look(where) {
      const bad = (what) => problems.push(`${where}: ${what}`);
      for (const box of [page, ...all(".MuiContainer-root").map((c) => c.parentElement), ...all(".MuiDialog-paper")])
        // (One px is rounding, not a scroll: at 125 % and 150 % a box is a fraction of a CSS px wide, e.g. 733.33,
        // and WebKit then reports scrollWidth 734 in clientWidth 733. The 1100 px at 150 % picture shows no bar.)
        if (box.scrollWidth > box.clientWidth + 1) bad(`${box === page ? "the page" : "a pane"} scrolls sideways (${box.scrollWidth} in ${box.clientWidth} px)`);
      for (const h of all("h1, h2, h6, [role=columnheader]"))
        if (h.scrollWidth > h.clientWidth + 1 && !h.closest("[title]") && !h.querySelector("[title]")) bad(`the heading "${h.textContent}" is cut short and has no tooltip`);
      return bad;
    }
    // A browse tab: also its sidebar, the bucket card, the tab bar and the object list.
    function lookAtBrowse(where) {
      const bad = look(where);
      const [side, card] = [last(all("aside")), last(all("[data-testid=bucket-card]"))];
      if (!side || !inView(side)) bad("the sidebar is not wholly in view");
      if (!card || !inView(card)) bad(`the bucket card is not wholly in view (it ends at ${card ? Math.round(card.getBoundingClientRect().bottom) : "?"} of ${page.clientHeight} px)`);
      if (![button(T("app.pinned")), button(T("app.recent")), last(all(sel("tabs.new")))].every((b) => b && inView(b))) bad("the tab bar pushes its buttons out of the window");
      for (const list of all('[role="table"]')) {
        list.scrollLeft = 8;
        if (list.scrollLeft !== 0) bad(`the object list scrolls sideways (${list.scrollWidth} in ${list.clientWidth} px)`);
        list.scrollLeft = 0;
      }
    }

    await waitFor(() => button(T("app.connections")), "the app", 30000);
    // The canned update (toast and badge) is the whole flow's business, not this one's.
    document.head.appendChild(document.createElement("style")).textContent = '.MuiSnackbar-root, .MuiChip-root[title*="v9.9.9"] { display: none !important; }';
    // First run: no connection yet. The Connections screen is one card with one button.
    await click(T("app.connections"));
    await waitFor(() => button(T("conn.add")) && hasText(T("conn.none")) && all("form").length === 0, "the first-run card");
    look("first run, Connections");
    await shot("connection-empty");
    await addConnection("lab", KEY(1));
    await addConnection("many", KEY(3));
    await shot("-");
    await click(T("app.browse"));
    await useConnection("lab");
    await clickSel(bucketButtons);
    await clickSel(folder("notes/"));
    await waitFor(() => last(all(sel("browse.openObject", { key: "notes/readme.txt" }))), "the first tab: lab, in notes/", 20000);
    press("t");
    await waitFor(() => tabs().length === 2, "a second tab");
    await useConnection("many");
    await waitFor(() => all(bucketButtons).length === 32, "the second tab: the key with 32 buckets", 20000);
    for (let count = 3; count <= 8; count++) {
      press("t");
      await waitFor(() => tabs().length === count, `tab ${count}`);
    }
    await shot("-");

    // One cell of the matrix: the window at `width` and the page at `scale` %, then every screen looked at.
    async function cell(width, scale) {
      await invoke("dev_set_size", { width, height: HEIGHT });
      await invoke("set_ui_scale", { percent: scale });
      const [w, h] = [Math.round((width * 100) / scale), Math.round((HEIGHT * 100) / scale)];
      await waitFor(() => Math.abs(window.innerWidth - w) <= 2 && Math.abs(window.innerHeight - h) <= 2, `a ${width}x${HEIGHT} window at ${scale} % to be ${w}x${h} CSS px (it is ${window.innerWidth}x${window.innerHeight})`);
      const name = `${width}x${HEIGHT} at ${scale} %`;
      const before = problems.length;
      tabs()[0].click();
      await waitFor(() => connectionShown() === "lab", "the first tab");
      await sleep(300); // the media queries and the measured pane follow the resize
      lookAtBrowse(`${name}, a folder open`);
      await click(T("browse.createFolder"));
      const dialog = await waitFor(() => last(all(".MuiDialog-paper")), "a dialog");
      await sleep(250);
      if (!inView(dialog)) problems.push(`${name}: the dialog does not fit the window`);
      look(`${name}, a dialog`);
      await click(T("common.cancel"));
      await dialogsGone();
      tabs()[1].click();
      await waitFor(() => connectionShown() === "many", "the second tab");
      await sleep(150);
      lookAtBrowse(`${name}, 32 buckets`);
      await click(T("app.connections"));
      await waitFor(() => hasText(T("conn.savedList")), "the Connections screen");
      await sleep(150);
      look(`${name}, Connections`);
      await click(T("app.browse"));
      const found = problems.slice(before);
      await say(`${name} (${window.innerWidth}x${window.innerHeight} CSS px): ${found.length ? found.join("; ") : "ok"}`);
    }
    // One slot of the shared clock per width (the shell counts the `shot` lines of this file, so no loop around them).
    for (const scale of SCALES) await cell(WIDTHS[0], scale);
    await shot("-");
    for (const scale of SCALES) await cell(WIDTHS[1], scale);
    await shot("-");
    for (const scale of SCALES) await cell(WIDTHS[2], scale);
    await shot("-");
    for (const scale of SCALES) await cell(WIDTHS[3], scale);
    await shot("-");
    for (const scale of SCALES) await cell(WIDTHS[4], scale);
    await shot("-");
    for (const scale of SCALES) await cell(WIDTHS[5], scale);
    await shot("-");

    // A picture of a cell whose width is a fraction of a CSS px (733.33): no scroll bar along the bottom.
    await invoke("dev_set_size", { width: 1100, height: HEIGHT });
    await invoke("set_ui_scale", { percent: 150 });
    tabs()[0].click();
    await waitFor(() => window.innerWidth === 733 && connectionShown() === "lab", "1100 px at 150 %");
    await shot("responsive-1100-150");
    // Two pictures at 100 %: the narrowest window of the matrix and the widest.
    await invoke("set_ui_scale", { percent: 100 });
    await invoke("dev_set_size", { width: 900, height: HEIGHT });
    tabs()[0].click();
    await waitFor(() => window.innerWidth === 900 && connectionShown() === "lab", "900 px at 100 %");
    await shot("responsive-900");
    await invoke("dev_set_size", { width: 1920, height: 1000 });
    await waitFor(() => window.innerWidth === 1920, "1920 px at 100 %");
    await shot("responsive-1920");

    // Back to the usual window; the two connections (and their keychain entries) are removed again.
    await invoke("dev_set_size", { width: 1200, height: 800 });
    await click(T("app.connections"));
    await removeConnection("lab");
    await removeConnection("many");
    await waitFor(() => !document.querySelector(sel("conn.more", { label: "many" })) && button(T("conn.add")), "the connections removed: the first-run card is back");
    await say(`${WIDTHS.length * SCALES.length} cells, ${problems.length} problems`);
    if (problems.length) throw new Error(`${problems.length} problems, the first: ${problems[0]}`);
    banner(`RESPONSIVE DONE: ${WIDTHS.length * SCALES.length} cells, late: [${late.join(", ")}]`, late.length ? "#fc6" : "#8f8");
    await shot("zz-done");
