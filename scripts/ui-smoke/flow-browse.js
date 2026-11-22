    // The app end to end (FLOW=browse), as a user who only has an S3 key. Data comes from
    // `ui_smoke_browse_fixture_create` in tests/s3_lab.rs; its two users have fixed keys so
    // they can be typed in here: the owner of the bucket, and a read-only user.
    const BUCKET = "ba-m4-ui-bucket";
    const OWNER = "ba-m4-ui";
    const READ_ONLY = "ba-m4-ui-ro";
    const KEY = (n) => ({ ak: `BAM7UISMOKEKEY00000${n}`, sk: `bam7uismokesecret00000000000000000000000${n}` });
    const [MINE, RO, MANY_KEY, SCOPED, NO_LIST] = [KEY(1), KEY(2), KEY(3), KEY(4), KEY(5)];
    // M9: the fixture's third user owns this many empty buckets, named ba-m9-ui-many-01 and up.
    const MANY = 32;
    const manyBucket = (n) => `ba-m9-ui-many-${String(n).padStart(2, "0")}`;
    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
    const drawer = () => last(all(".MuiDrawer-paper"));
    // Media is shown by /preview.html inside a frame of the drawer.
    const media = (tag) => drawer().querySelector("iframe")?.contentDocument?.querySelector(tag);
    // Every text the flow looks for or clicks comes from the app's own string table (T, seen, sel,
    // starts: see the driver), so the same flow runs with the app in Vietnamese and in English.
    const objectLink = (key) => last(all(sel("browse.openObject", { key })));
    const openObject = (key) => clickSel(sel("browse.openObject", { key }));
    const folder = (prefix) => sel("browse.openFolder", { folder: prefix });
    const openFolder = async (prefix) => {
      await click(BUCKET); // breadcrumb root
      await clickSel(folder(prefix));
    };
    const closeDrawer = async () => {
      await click(T("common.close"));
      await drawersGone();
    };
    const versions = () => all(starts("versions.downloadOne")).length;
    const grants = () => all(starts("acl.removeGrant")).length;
    const proxyOf = (name) => document.querySelector(`select${sel("proxy.aria", { name })}`);
    const tabs = () => all(`${sel("app.tabs")} [role=tab]`);
    const bucketButtons = `${sel("browse.bucketList")} [role=button]`;
    const tick = (name) => `input${sel("browse.selectRow", { name })}`;
    // Sentences the flow meets more than once.
    const loaded = (folders, objects) => T("browse.loaded", { folders, objects });
    const versioningIs = (status) => T("browse.versioningChip", { status: T(`browse.versioning.${status}`) });
    const rowsShown = (from, to) => T("preview.range", { from, to, total: 2000 });
    const taskHeader = () => seen("tasks.header", { tz: "UTC+7" });
    const menuItems = () => all("[role=menuitem]").map((m) => m.textContent.trim());
    const press = (key, shiftKey = false) => window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey, bubbles: true }));
    const rightClick = (el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 560, clientY: 430 }));
    // Nothing scrolls sideways: the page, the pane of each view, the object sheet.
    const fits = () => [document.documentElement, ...all(".MuiContainer-root").map((c) => c.parentElement), ...all(".MuiDrawer-paper")].every((e) => e.scrollWidth <= e.clientWidth);
    // The object list shows every column it has and cannot be scrolled sideways. Asked by scrolling it:
    // at a fractional zoom scrollWidth and clientWidth are rounded apart by a pixel on a list that fits.
    const lists = () => all(`[role="table"][aria-label="${T("browse.objectList")}"]`);
    const listFits = () =>
      lists().every((e) => {
        e.scrollLeft = 8;
        const moved = e.scrollLeft;
        e.scrollLeft = 0;
        return moved === 0;
      });
    const listOver = () => lists().map((e) => `${e.scrollWidth} in ${e.clientWidth} px`).join(", ");
    // Wholly inside the window (menus, the sheet).
    const inWindow = (el) => {
      const [r, page] = [el.getBoundingClientRect(), document.documentElement];
      return r.left >= 0 && r.top >= 0 && r.right <= page.clientWidth && r.bottom <= page.clientHeight;
    };
    const rowOf = async (key) => (await waitFor(() => objectLink(key), `row of ${key}`)).closest('[role="row"]');
    // The sidebar of the tab on screen: its connection, its bucket rows, its pinned rows.
    // The connection of the tab on screen: a plain select up to 8 connections, a searchable box above that.
    const connectionField = () => first(all("aside select, aside input[role=combobox]"));
    const connectionShown = () => {
      const f = connectionField();
      return f?.tagName === "SELECT" ? f.selectedOptions[0]?.textContent : f?.value;
    };
    const useConnection = async (label) => {
      const f = await waitFor(connectionField, "the connection field of the tab");
      if (f.tagName === "SELECT") {
        // A connection saved a moment ago reaches the tab's list with the next reload of the profiles.
        const option = await waitFor(() => [...f.options].find((o) => o.textContent === label), `connection ${label} in the tab's list`);
        return setValue(f, option.value);
      }
      // Type-ahead: the label is typed, the matching choice (label, endpoint under it) is clicked.
      f.focus();
      setValue(f, label);
      // A connection saved a moment ago arrives with the next reload of the profiles; the typed text must survive it.
      (await waitFor(() => {
        if (connectionField().value !== label) throw new Error(`the typed "${label}" was replaced by "${connectionField().value}" when the profiles reloaded`);
        return all("[role=option]").find((o) => o.textContent.trim().startsWith(label));
      }, `connection ${label} among the choices`)).click();
      await waitFor(() => connectionShown() === label && all("[role=option]").length === 0, `connection ${label} chosen`);
    };
    const bucketRow = (name) => all(bucketButtons).find((row) => row.textContent.trim() === name);
    const pinnedButtons = () => all(`${sel("browse.pinnedList")} [role=button]`);
    const pinnedRows = () => pinnedButtons().map((row) => row.textContent.trim());
    const savedPins = async () => (await invoke("pin_list")).map((pin) => `${pin.place.bucket}/${pin.place.prefix}${pin.label ? `=${pin.label}` : ""}`).join(" | ");
    const panelOf = (key) => last(all(sel(key)))?.closest(".MuiPaper-root");
    // M12.4: start path, admin key and proxy are in the form's Advanced group, closed until it is asked for
    // (and then open for the rest of the run).
    const openAdvanced = async () => {
      if (!document.getElementById("conn-advanced")) await clickSel('[aria-controls="conn-advanced"]');
      await waitFor(() => document.getElementById("conn-advanced"), "the Advanced group of the form");
    };
    const maskedMine = `${MINE.ak.slice(0, 4)}…${MINE.ak.slice(-4)}`;
    // What a saved connection's row says (label, host, keys, start path).
    const rowSays = (label, text) => all("li").some((row) => row.querySelector(sel("conn.more", { label })) && row.textContent.includes(text));
    const addConnection = async (label, key, startPath) => {
      await click(T("app.connections"));
      await type(T("conn.label"), label);
      await type(T("conn.endpoint"), CFG.ENDPOINT);
      await type(T("conn.accessKey"), key.ak);
      await type(T("conn.secretKey"), key.sk);
      // The form's own field: every saved connection below it has a start path field too.
      if (startPath !== undefined) {
        await openAdvanced();
        await type(T("conn.startPath"), startPath, first);
      }
    };
    // The add-connection form is the first form of the Connections screen; every saved connection
    // below it has a "Test connection" button of its own, so the form's is asked for by position.
    const testForm = async () => (await waitFor(() => first(all("form button").filter((b) => b.textContent.trim() === T("conn.test") && !b.disabled)), "the form's test button")).click();
    const formSays = (text) => first(all("form")).innerText.includes(text);
    const notes = [];

    // ---- no connection yet: the app opens where one can be added. The update check (its
    // answer is canned for this run) shows a toast once and a badge that stays.
    // ---- M10.3 the app starts with 20 saved connections (seeded by the shell: fake endpoints, no keys;
    // two of them share a label). The update check (its answer is canned for this run) shows a toast
    // once and a badge that stays.
    await waitFor(() => button(T("app.connections")), "the app", 30000);
    await waitFor(() => seen("app.update.toast", { tag: "v9.9.9" }) && button(T("app.update.open")), "update toast");
    check(all(".MuiChip-root").some((c) => c.textContent === T("app.update.badge", { tag: "v9.9.9" })), "update badge in the masthead");
    check(!button("Users") && !button("Buckets") && !button("Audit"), "no admin screens");
    await click(T("app.connections"));
    const savedRows = () => all(starts("conn.more")).length;
    await waitFor(() => all(sel("conn.countAria", { n: 20 })).length === 1 && savedRows() === 20 && hasText(T("conn.add")), "twenty saved connections, counted in a badge");
    // One picture with the badge (docs/images/update*.png); the later pictures do not show the canned release.
    await shot("00a-update-badge");
    // visibility, not display: the masthead keeps its width for the "does not scroll sideways" checks.
    document.head.appendChild(document.createElement("style")).textContent = '.MuiChip-root[title*="v9.9.9"] { visibility: hidden; }';
    const search = await waitFor(() => last(all(`input${sel("conn.search")}`)), "the search field of the saved connections");
    setValue(search, "s3-07.");
    await waitFor(() => savedRows() === 1 && hasText(T("browse.filterCount", { n: 1, m: 20 })), "search by a part of the endpoint");
    setValue(search, "site-01");
    const flagged = () => all("[role=note]").filter((n) => n.textContent === T("conn.duplicateLabel")).length;
    await waitFor(() => savedRows() === 2 && flagged() === 2, "two connections share a label: both are listed and flagged");
    setValue(search, "SITE-1");
    await waitFor(() => savedRows() === 10 && flagged() === 0 && hasText(T("browse.filterCount", { n: 10, m: 20 })), "search by label, whatever the case: 10 of 20");
    check(all(starts("conn.more")).every((b) => b.closest("li").getBoundingClientRect().height >= 40) && search.getBoundingClientRect().height >= 23 && search.closest(".MuiInputBase-root").getBoundingClientRect().height >= 40, "rows and the search field keep the size floor");
    all("h2").find((h) => h.textContent === T("conn.savedList")).scrollIntoView({ block: "start" });
    check(fits(), "Connections with many rows does not scroll sideways");
    await shot("00-connections-many");
    setValue(search, "");
    await waitFor(() => savedRows() === 20, "the search cleared: all of them again");
    // M10.2: the theme switch of General settings does what the app-bar menu does.
    const themeSwitch = last(all(".MuiSwitch-input"));
    themeSwitch.click();
    await waitFor(() => document.documentElement.dataset.theme === "light" && themeSwitch.checked, "the settings switch turns the light theme on");
    themeSwitch.click();
    await waitFor(() => document.documentElement.dataset.theme === "dark" && !themeSwitch.checked, "and off again");
    all(".MuiContainer-root").forEach((c) => (c.parentElement.scrollTop = 0));
    // M12.4: the endpoint starts with its scheme; Save is disabled and says which field comes first.
    const saveTip = () => first(all("form")).querySelector("button[type=submit]").parentElement.title;
    check((await field(T("conn.endpoint"))).value === "https://" && !button(T("common.save")) && saveTip() === T("conn.missing", { field: T("conn.label") }), `an empty form: Save is disabled and its tooltip names the first missing field (${saveTip()})`);
    await type(T("conn.label"), "lab");
    await type(T("conn.endpoint"), CFG.ENDPOINT);
    await type(T("conn.accessKey"), MINE.ak);
    await type(T("conn.secretKey"), "not-the-secret-0000000000000000000000000");
    // The lab is a private address: "no proxy" is suggested for it.
    await waitFor(() => hasText(T("conn.internalHint")), "no-proxy suggestion for a private endpoint");
    await click(T("conn.noProxy.pick"));
    await waitFor(() => !hasText(T("conn.internalHint")), "suggestion taken: the hint is gone");
    check(first(all("form")).querySelector('[aria-controls="conn-advanced"]').getAttribute("aria-expanded") === "false" && !document.getElementById("conn-advanced"), "the Advanced group is closed on a first visit");
    await openAdvanced();
    check(proxyOf(T("proxy.name.new")).value === "none", "and the proxy choice in the Advanced group says so");
    check(button(T("common.save")) && !saveTip(), "the four required fields are filled: Save is enabled and its tooltip is gone");
    await testForm();
    await waitFor(() => hasText(T("error.s3.SignatureDoesNotMatch")), "a wrong secret is named as such");
    await type(T("conn.secretKey"), MINE.sk);
    await testForm();
    await waitFor(() => hasText(T("conn.ok", { n: 1 })), "connection test over S3, no admin caps needed");
    check(fits(), "Connections does not scroll sideways");
    await shot("01-connection");
    // M13.3: Region (empty = us-east-1) and Path-style addressing (on) are in the Advanced group, under the proxy.
    const advancedGroup = document.getElementById("conn-advanced");
    const regionField = [...advancedGroup.querySelectorAll("input")].find((i) => i.placeholder === "us-east-1");
    const pathStyle = advancedGroup.querySelector('input[type="checkbox"]');
    check(regionField && regionField.value === "" && pathStyle && pathStyle.checked && hasText(T("conn.regionHelp")) && hasText(T("conn.pathStyleHelp")), "Advanced: Region empty and Path-style addressing on by default (the test above passed with them)");
    pathStyle.closest("label").scrollIntoView({ block: "center" });
    await shot("01b-connection-advanced");
    await click(T("common.save"));
    await waitFor(() => hasText(T("conn.saved", { label: "lab" })) && rowSays("lab", maskedMine), "connection saved; its row shows the host and the masked key");
    // The row's own settings are behind Edit; Test and Delete are in its menu.
    await clickSel(sel("conn.editFor", { label: "lab" }));
    await waitFor(() => proxyOf(T("proxy.name.of", { label: "lab" }))?.value === "none", "saved with its own proxy choice");
    // M13.3: Edit also has the connection's Region and Path-style, with their own Save (off until something changes).
    const savedRegion = all("input").find((i) => i.getAttribute("aria-label") === `${T("conn.region")} ${T("proxy.name.of", { label: "lab" })}`);
    check(savedRegion && savedRegion.value === "" && all("button").find((b) => b.textContent.trim() === T("conn.saveAddressing"))?.disabled, "Edit: the saved connection's Region is empty and Save addressing waits for a change");
    savedRegion?.scrollIntoView({ block: "center" });
    await shot("01c-connection-edit");
    await clickSel(sel("conn.editFor", { label: "lab" }));
    await clickSel(sel("conn.more", { label: "lab" }));
    await clickSel(sel("conn.testFor", { label: "lab" }));
    await waitFor(() => rowSays("lab", T("conn.ok", { n: 1 })), "the saved connection's test, from its menu, answers in its row", 20000);

    // ---- Browse: the key's buckets as cards, then one bucket
    await click(T("app.browse"));
    // The first tab is on the first saved connection (one of the seeded ones): the tab's connection is searched for.
    check(connectionField().getAttribute("role") === "combobox", "with more than 8 connections the tab's connection is a searchable box");
    await useConnection("lab");
    await waitFor(() => hasText(T("browse.chooseBucket")) && hasText(T("browse.usingKeyMine")) && hasText(BUCKET), "bucket cards of the key's user", 20000);
    check(all("label").every((l) => !l.textContent.startsWith(T("browse.browseAs"))) && !hasText(piece("myinfo.title")), "a key without caps: no admin extras");
    check(fits(), "the bucket cards do not scroll sideways");
    await shot("02-buckets");
    await clickSel(bucketButtons);
    await waitFor(() => hasText(loaded(4, 0)), "bucket root");
    await waitFor(() => hasText(versioningIs("on")), "versioning chip");
    check(tabs().length === 1 && tabs()[0].textContent === `lab · ${BUCKET}×`, `the tab is named after connection and bucket: ${tabs()[0].textContent}`);
    check(fits() && listFits(), "Browse does not scroll sideways, nor does its object list");
    await shot("03-bucket-root");

    // ---- zoom: the webview's own zoom, so the window keeps its size and the page gets narrower in CSS px
    const wide = window.innerWidth;
    const zoomed = () => Math.round((wide / window.innerWidth) * 100);
    const savedScale = () => window.__TAURI_INTERNALS__.invoke("get_ui_scale");
    press("=");
    await waitFor(() => zoomed() === 110, "Ctrl+=: 110 %");
    press("+");
    await waitFor(() => zoomed() === 125, "Ctrl++: 125 %");
    check((await savedScale()) === 125, "the size is written to settings.json at once");
    // Asked of the standard window (1200 px, 960 CSS px at 125 %); a smaller window may scroll at this size.
    // Waited for: the page learns its new width (a media query) a moment after the zoom.
    await waitFor(() => wide < 1200 || (fits() && listFits()), "Browse does not scroll sideways at 125 %, nor does its object list").catch((e) => {
      throw new Error(`${e.message} (list: ${listOver()})`);
    });
    rightClick(last(all(folder("notes/"))).closest('[role="row"]'));
    await waitFor(() => menuItems().length > 0, "context menu at 125 %");
    check(inWindow(last(all(".MuiMenu-paper"))), "the context menu is not clipped at 125 %");
    last(all(".MuiMenu-root .MuiBackdrop-root")).click();
    await menusGone();
    // A dialog scales with the page and stays inside the window.
    await click(T("browse.createFolder"));
    const dialog = await waitFor(() => last(all(".MuiDialog-paper")), "dialog at 125 %");
    // The page itself is asked of the standard window only, as above (900 px at 125 % is 720 CSS px).
    check(inWindow(dialog) && (wide < 1200 || fits()), "the dialog fits the window at 125 %");
    await click(T("common.cancel"));
    await dialogsGone();
    await shot("03b-zoom-125");
    press("-");
    await waitFor(() => zoomed() === 110, "Ctrl+-: 110 %");
    press("0");
    await waitFor(() => zoomed() === 100 && window.innerWidth === wide, "Ctrl+0: 100 %");
    check((await savedScale()) === 100, "and saved again");

    // ---- text: line numbers, Ctrl-F, find
    await openFolder("notes/");
    await openObject("notes/readme.txt");
    await waitFor(() => hasText("dòng 1: ok"), "text preview");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    check(document.activeElement === (await field(T("preview.find"))), "Ctrl-F focuses the find box");
    await type(T("preview.find"), "error");
    await waitFor(() => hasText(T("preview.hits", { at: 1, total: 3 })) && hasText("dòng 50: ERROR"), "first hit scrolled into view");
    await click(T("preview.next"));
    await waitFor(() => hasText(T("preview.hits", { at: 2, total: 3 })) && hasText("dòng 250: ERROR"), "second hit scrolled into view");
    check(fits() && inWindow(drawer()), "the object sheet fits the window");
    await shot("04-text-find");
    await closeDrawer();
    await openObject("notes/config.json");
    await waitFor(() => hasText('"retention_days": 30'), "re-indented JSON");
    await shot("05-json");
    await closeDrawer();

    // ---- CSV and Parquet
    await openFolder("data/");
    await openObject("data/people.csv");
    await waitFor(() => hasText(T("preview.csvCount", { rows: 200, cols: 4 })) && hasText("Nguyen, An 1"), "CSV table with a quoted comma");
    (await waitFor(() => first(all(sel("preview.copyRow", { n: 1 }))), "copy button of row 1")).focus();
    await shot("06-csv"); // the shell presses a real Enter here and reads the clipboard
    await shot("-");
    await closeDrawer();
    await openObject("data/sample.parquet");
    await waitFor(() => hasText(rowsShown(1, 100)) && hasText("row-1") && hasText("meta : Struct"), "first Parquet page", 20000);
    await click(T("preview.nextPage"));
    await waitFor(() => hasText(rowsShown(101, 200)) && hasText("row-100"), "second Parquet page", 20000);
    await type(T("preview.goto"), "1990");
    (await field(T("preview.goto"))).form.requestSubmit();
    await waitFor(() => hasText(rowsShown(1990, 2000)) && hasText("row-1999"), "jump to the last rows", 20000);
    await shot("07-parquet");
    await closeDrawer();

    // ---- media straight from presigned URLs
    await openFolder("media/");
    await openObject("media/icon.png");
    await waitFor(() => media("img")?.naturalWidth === 128, "PNG loaded");
    // The CSP at work: which directive (if any) refuses loading `url` as an image in a document.
    const refusedBy = (doc, win, url) =>
      new Promise((resolve) => {
        const on = (e) => resolve(e.effectiveDirective || e.violatedDirective);
        doc.addEventListener("securitypolicyviolation", on, { once: true });
        new win.Image().src = url;
        setTimeout(() => resolve(null), 3000);
      });
    const frame = drawer().querySelector("iframe");
    const pngUrl = new URLSearchParams(frame.src.split("#")[1]).get("url");
    check((await refusedBy(document, window, pngUrl)) === "img-src", "the main window is refused the very image the frame shows");
    check(
      (await refusedBy(frame.contentDocument, frame.contentWindow, "https://example.invalid/x.png")) === "img-src",
      "the preview frame is refused any origin but the cluster's",
    );
    await clickSel(sel("preview.zoomIn"));
    await waitFor(() => hasText("150%") && media("img").width === 192, "zoomed to 150%");
    await shot("08-image");
    await closeDrawer();
    await openObject("media/shape.svg");
    await waitFor(() => media("img")?.naturalWidth > 0, "SVG loaded");
    await closeDrawer();
    await openObject("media/tone.wav");
    await waitFor(() => media("audio")?.duration > 0.9, "audio metadata loaded", 20000);
    await shot("09-audio");
    await closeDrawer();
    if (CFG.MP4) {
      await openObject("media/clip.mp4");
      await waitFor(() => media("video")?.videoWidth === 320, "video metadata loaded", 20000);
      media("video").currentTime = 1;
      await sleep(1500);
    }
    await shot("10-video");
    if (CFG.MP4) await closeDrawer();
    await openObject("media/doc.pdf");
    await waitFor(() => media("iframe"), "PDF frame inside the preview frame");
    await sleep(4000);
    await shot("11-pdf"); // what the frame shows can only be judged from the screenshot
    await closeDrawer();

    // ---- hex, presign, download through the save dialog (answered by the debug-only env)
    await openFolder("bin/");
    await openObject("bin/blob.bin");
    await waitFor(() => hasText("00000000  ") && hasText(T("preview.loaded", { done: num("4.00 KiB"), total: num("10.0 KiB") })), "first 4 KiB as hex");
    await click(T("preview.more4k"));
    await waitFor(() => hasText(T("preview.loaded", { done: num("8.00 KiB"), total: num("10.0 KiB") })) && hasText("00001000  "), "next 4 KiB");
    await shot("12-hex");
    await click(T("object.tab.details"));
    await type(T("object.expiresIn"), "30");
    await type(T("object.unit"), "s");
    await click(T("object.createUrl"));
    const urlField = await field(T("object.presignedUrl"));
    await waitFor(() => /X-Amz-Signature=/.test(urlField.value) && /X-Amz-Expires=30(&|$)/.test(urlField.value), "URL with a 30 s expiry");
    await shot("13-presign");
    await waitFor(() => new RegExp(`${T("object.contentType")}\\s+\\S*octet-stream`).test(drawer().innerText), "content type from a HEAD");
    await click(T("object.tab.headers"));
    await waitFor(() => hasText("x-amz-request-id") && hasText("content-length") && hasText("10240"), "raw HEAD headers");
    await shot("14-headers");
    await click(T("object.tab.tags"));
    await waitFor(() => hasText(T("inspect.noTags")), "no tags yet");
    await click(T("inspect.addTag"));
    setValue(await waitFor(() => last(all(`input${sel("inspect.tagKeyOf", { n: 1 })}`)), "tag key field"), "env");
    setValue(last(all(`input${sel("inspect.tagValueOf", { n: 1 })}`)), "lab");
    await click(T("inspect.saveTags"));
    await waitFor(() => hasText(T("inspect.saved")), "tags saved and read back");
    await shot("15-tags");
    await click(T("object.tab.details"));
    await click(T("common.download"));
    await waitFor(() => hasText(T("object.saved", { path: `${CFG.FILES.replace("/files", "/dl")}/blob.bin` })), "download finished", 20000);
    await closeDrawer();

    // ---- upload: the Upload button (20 MiB, multipart) and a dropped file
    await click(T("common.upload"));
    (await waitFor(() => last(all(`[aria-label^="${piece("tasks.cancel")}↑"]`)), "cancel button of the running upload")).click();
    await waitFor(() => hasText(T("tasks.note.cancelled")) && !objectLink("bin/upload-20m.bin"), "upload cancelled, nothing uploaded", 60000);
    check(taskHeader(), "the task panel is shown");
    await shot("16-task-cancelled");
    await click(T("tasks.clear"));
    await click(T("common.upload"));
    await waitFor(() => hasText(T("tasks.doneSize", { size: num("20.0 MiB") })) && objectLink("bin/upload-20m.bin"), "multipart upload listed", 90000);
    // ---- times are Vietnam's (UTC+7) although this process runs with TZ=UTC. The expected value is
    // worked out by plain arithmetic here, not with the Intl call the app itself uses.
    check(new Date().getTimezoneOffset() === 0, "the app under test runs in UTC");
    const secondsOfDay = (hms) => hms.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    const vietnamNow = (Math.floor(Date.now() / 1000) + 7 * 3600) % 86400;
    const apart = (shown) => Math.min((shown - vietnamNow + 86400) % 86400, (vietnamNow - shown + 86400) % 86400);
    const taskTime = last(all(`${sel("tasks.title")} p`).filter((p) => /^\d\d:\d\d:\d\d$/.test(p.textContent.trim()))).textContent.trim();
    check(taskHeader() && apart(secondsOfDay(taskTime)) < 300, `task time ${taskTime} is the time in Vietnam`);
    const modified = [...objectLink("bin/upload-20m.bin").closest('[role="row"], tr').querySelectorAll("*")]
      .map((cell) => /^\d{4}-\d\d-\d\d (\d\d:\d\d)$/.exec(cell.textContent.trim()))
      .find(Boolean);
    // (Column headers are shown in capitals by a style, so their own text is compared, not what is painted.)
    // M12.2: the heading is short enough for a 900 px window; the zone is its tooltip and one caption under the list.
    const labelled = all("[role=columnheader]").some((h) => h.textContent === T("browse.col.modified") && h.querySelector("[title]")?.title === T("browse.col.modifiedTip", { tz: "UTC+7" })) && hasText(T("browse.timesIn", { tz: "UTC+7" }));
    check(labelled && modified && apart(secondsOfDay(`${modified[1]}:00`)) < 300, `last-modified ${modified?.[0]} is the time in Vietnam`);
    await shot("17-upload-done");
    await openObject("bin/upload-20m.bin");
    await click(T("object.tab.details"));
    await click(T("common.download"));
    await waitFor(() => hasText("/dl/upload-20m.bin"), "20 MiB download finished", 90000);
    await closeDrawer();
    // A synthetic drop event: it proves the page's drop handling, not GTK's delivery of real drops.
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: { paths: [`${CFG.FILES}/dropped.txt`], position: { x: 10, y: 10 } },
    });
    await waitFor(() => objectLink("bin/dropped.txt"), "dropped file uploaded", 20000);

    // ---- versions
    // ---- the right-click menu of a row, and through it the versions of an object
    await openFolder("notes/");
    rightClick(await rowOf("notes/versioned.txt"));
    await waitFor(() => menuItems().join(" | ") === [T("common.download"), T("browse.copyUrl"), T("browse.acl"), T("browse.versions"), T("common.delete")].join(" | "), "context menu of an object");
    check(inWindow(last(all(".MuiMenu-paper"))), "the context menu is not clipped");
    await shot("18-context-menu");
    await click(T("browse.versions"));
    await waitFor(() => versions() === 3 && all(".MuiDrawer-paper [role=tab][aria-selected=true]")[0]?.textContent === T("object.tab.versions"), "the sheet opens on its versions tab");
    check(getComputedStyle(drawer().querySelector("[role=tablist]")).flexDirection === "column", "the sheet's tabs are vertical");
    await shot("19-versions");
    last(all(starts("versions.restoreOne"))).click();
    await waitFor(() => hasText(T("versions.restoreTitle")), "restore confirmation");
    await click(T("versions.restore"));
    await dialogsGone();
    await waitFor(() => versions() === 4, "restore wrote a fourth version");
    last(all(starts("versions.deleteOne"))).click();
    await waitFor(() => hasText(T("versions.deleteTitle")), "delete confirmation");
    await click(T("versions.deleteConfirm"));
    await dialogsGone();
    await waitFor(() => versions() === 3, "one version deleted");

    // ---- ACL of the object, then of the bucket
    await click(T("object.tab.acl"));
    await waitFor(() => hasText(T("acl.ownerLabel")) && hasText(T("acl.owner")) && grants() === 0, "object ACL as a quick-share table");
    check(document.querySelector(`input[aria-label="${T("acl.owner")}: FULL_CONTROL"]`).checked, "the owner row shows FULL_CONTROL");
    await click(T("acl.addUser"));
    setValue(await waitFor(() => last(all(`input${sel("acl.grantUid", { n: 2 })}`)), "uid field"), READ_ONLY);
    await click(T("acl.apply"));
    await waitFor(() => hasText(T("acl.verified")) && grants() === 1, "ACL applied and read back");
    await shot("20-acl");
    await closeDrawer();
    await click(T("browse.bucketAcl"));
    await waitFor(() => hasText(T("browse.aclOfBucket", { bucket: BUCKET })) && hasText(T("acl.ownerLabel")), "bucket ACL");
    await shot("21-bucket-acl");
    await click(T("common.close"));
    await dialogsGone();

    // ---- one ACL for every object of a folder: preset, warning, count, progress
    await openFolder("notes/");
    await click(T("browse.folderAcl"));
    await waitFor(() => hasText(T("browse.aclOfFolder", { folder: "notes/" })) && hasText(T("acl.ownerLabel")), "folder ACL");
    await click(T("acl.preset.publicRead"));
    await waitFor(() => hasText(T("acl.warn.public", { perms: "READ", who: T("acl.public") })), "public access warning");
    check(!button(T("acl.apply")), "a folder has nothing to apply to until the recursive box is ticked");
    last(all(".MuiDialog-root input[type=checkbox]")).click();
    await waitFor(() => hasText(T("acl.recursive.count", { n: 3, where: T("acl.where.folder", { key: "notes/" }) })), "object count");
    await shot("22-folder-acl");
    await click(T("acl.applyMany", { n: 3 }));
    await waitFor(() => hasText(T("acl.report.applied", { applied: 3, objects: 3 })), "ACL applied to the folder", 20000);
    await click(T("common.close"));
    await dialogsGone();

    // ---- search from the bucket root
    await click(BUCKET);
    await type(T("browse.searchLabel"), "*.parquet");
    await click(T("browse.search"));
    await waitFor(() => seen("browse.found.done", { n: 1 }) && objectLink("data/sample.parquet"), "search result");
    await shot("23-search");
    // An object opened from a search: the folder it lies in becomes a recent place.
    await openObject("data/sample.parquet");
    await waitFor(() => hasText(rowsShown(1, 100)), "Parquet from the search result", 20000);
    await closeDrawer();
    await click(T("browse.closeResults"));

    // ---- tabs: each one keeps its own place, listing and selection
    await openFolder("notes/");
    (await waitFor(() => last(all(tick("readme.txt"))), "checkbox of readme.txt")).click();
    await waitFor(() => button(T("browse.deleteCount", { n: 1 })), "one row ticked in the first tab");
    press("t");
    await waitFor(() => tabs().length === 2 && hasText(T("browse.chooseBucket")) && tabs()[1].textContent.includes(T("tabs.new")), "Ctrl+T: a new tab on the bucket cards");
    await clickSel(bucketButtons);
    await waitFor(() => hasText(loaded(4, 0)), "bucket root in the second tab");
    await clickSel(folder("media/"));
    await waitFor(() => objectLink("media/icon.png") && tabs()[1].textContent === `lab · ${BUCKET}/media×`, "the second tab is in media/ and its title says so");
    check(!objectLink("notes/readme.txt"), "the first tab's rows are not on screen");
    await shot("24-two-tabs");
    // ---- M10.2 the light theme, chosen in the app-bar menu: shown at once, saved, and back again
    const pageColour = () => getComputedStyle(document.body).backgroundColor;
    const chooseTheme = async (name) => {
      await click(T("app.menu"));
      await clickSel(`[role=menuitemradio][aria-checked="false"]`);
      await waitFor(() => last(all('[role=menuitemradio][aria-checked="true"]'))?.textContent.trim() === T(`theme.${name}`), `${name} is the checked choice`);
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await menusGone();
    };
    check(document.documentElement.dataset.theme === "dark" && pageColour() === "rgb(24, 21, 18)", `the app starts dark: ${pageColour()}`);
    await chooseTheme("light");
    await waitFor(() => document.documentElement.dataset.theme === "light" && pageColour() === "rgb(250, 247, 242)", "the whole page is on warm paper");
    check((await invoke("get_theme")) === "light", "the choice is in settings.json");
    const row = last(all(bucketButtons)).getBoundingClientRect().height;
    check(row >= 40, `the row floor holds in the light theme: row ${row}px`);
    check(fits(), "nothing scrolls sideways in the light theme");
    await shot("24b-light");
    await chooseTheme("dark");
    await waitFor(() => pageColour() === "rgb(24, 21, 18)" , "and dark again");
    check((await invoke("get_theme")) === "dark", "saved again");
    press("Tab");
    await waitFor(() => objectLink("notes/readme.txt") && !objectLink("media/icon.png"), "Ctrl+Tab: the first tab again");
    check(last(all(tick("readme.txt"))).checked && !!button(T("browse.deleteCount", { n: 1 })), "the first tab kept its place and its selection");
    last(all(tick("readme.txt"))).click();
    // Recent places: newest first; one that is already open is shown in its tab, another opens a new tab.
    await click(T("app.recent"));
    await waitFor(() => menuItems().length >= 5, "recent places listed");
    check(menuItems()[0] === `lab · ${BUCKET}/media` && menuItems().includes(`lab · ${BUCKET}/data`), `newest first, the search hit's folder is there: ${menuItems().join(", ")}`);
    check(fits() && inWindow(last(all(".MuiMenu-paper"))), "the recent menu fits the window");
    await shot("25-recent");
    all("[role=menuitem]").find((m) => m.textContent.trim() === `lab · ${BUCKET}/media`).click();
    await waitFor(() => objectLink("media/icon.png") && tabs().length === 2 && menuItems().length === 0, "a place already open is shown in its tab, not opened twice");
    await click(T("app.recent"));
    (await waitFor(() => all("[role=menuitem]").find((m) => m.textContent.trim() === `lab · ${BUCKET}/data`), "data/ in the recent menu")).click();
    await waitFor(() => tabs().length === 3 && objectLink("data/people.csv") && tabs()[2].textContent.includes("data"), "another recent place opens as a new tab");
    await menusGone(); // the shortcuts are off while a menu, dialog or sheet is open
    press("w");
    await waitFor(() => tabs().length === 2 && objectLink("media/icon.png"), "Ctrl+W closes the tab; its neighbour takes over");
    await menusGone(); // the shortcuts are off while a menu, dialog or sheet is open
    press("w");
    await waitFor(() => tabs().length === 1 && objectLink("notes/readme.txt"), "back to one tab");
    const recentRows = () => all(`${sel("browse.recentList")} [role=button]`).length;
    check(recentRows() >= 4 && recentRows() <= 5, `the sidebar lists the newest recent places too: ${recentRows()}`);
    // M11: the Recent card folds to its heading, and the choice is written to settings.json (shared by every tab).
    const recentHeading = () => last(all("aside h2 button[aria-expanded]").filter((b) => b.textContent.startsWith(T("browse.recent"))));
    recentHeading().click();
    await waitFor(() => recentRows() === 0 && recentHeading().getAttribute("aria-expanded") === "false", "Recent folded to its heading");
    let foldedSaved = [];
    for (let i = 0; i < 30 && foldedSaved.join() !== "recent"; i++) {
      await sleep(100);
      foldedSaved = await invoke("folded_get");
    }
    check(foldedSaved.join() === "recent", `the folded section is in settings.json: [${foldedSaved}]`);
    recentHeading().click();
    await waitFor(() => recentRows() >= 4, "and unfolded again");

    // ---- delete from the right-click menu, and undo it
    rightClick(await rowOf("notes/config.json"));
    await waitFor(() => menuItems().length === 5, "context menu");
    await click(T("common.delete"));
    await waitFor(() => hasText(T("browse.deleteTitle")) && hasText(T("object.undeleteHint")), "delete confirmation says it can be undone");
    await click(T("browse.deleteConfirm", { n: 1 }));
    await dialogsGone();
    await waitFor(() => hasText(T("browse.deletedMarked", { n: 1 })) && !objectLink("notes/config.json"), "deleted from the menu");
    await click(T("browse.undo"));
    await waitFor(() => hasText(T("browse.restored", { n: 1 })) && objectLink("notes/config.json"), "and restored from the toast");
    await shot("26-undo");

    // ---- delete an object
    await openFolder("bin/");
    await openObject("bin/upload-20m.bin");
    await click(T("object.tab.details"));
    await click(T("object.delete"));
    await waitFor(() => hasText(T("object.deleteTitle")) && hasText(T("object.undeleteHint")), "delete confirmation says it can be undone");
    await click(T("object.delete"));
    await drawersGone();
    await waitFor(() => hasText(T("browse.deletedMarked", { n: 1 })) && button(T("browse.undo")) && !objectLink("bin/upload-20m.bin"), "object gone, undo offered");
    // ---- the deleted object can still be found, with nothing but its versions
    await click(T("browse.showDeleted"));
    await waitFor(() => hasText(T("browse.gone", { n: 1 })) && objectLink("bin/upload-20m.bin"), "deleted object listed");
    check(!document.querySelector(tick("upload-20m.bin")), "a deleted object cannot be ticked");
    await openObject("bin/upload-20m.bin");
    await waitFor(() => hasText(T("versions.deletedState")) && all(starts("versions.unmarkOne")).length === 1, "versions of the deleted object");
    check(all(".MuiDrawer-paper [role=tab]").length === 1, "a deleted object only has its versions tab");
    await shot("27-deleted-shown");
    await closeDrawer();
    await click(T("browse.hideDeleted"));
    await waitFor(() => !objectLink("bin/upload-20m.bin"), "deleted objects hidden again");

    // ---- Copy URL of the one ticked object (a real Enter from the shell: the clipboard ignores synthetic clicks)
    await openFolder("notes/");
    (await waitFor(() => last(all(tick("readme.txt"))), "checkbox of readme.txt")).click();
    const copyUrl = await waitFor(() => button(T("browse.copyUrl")), "Copy URL enabled for one object");
    check(!!button(T("browse.deleteCount", { n: 1 })), "the delete button shows the number of ticked rows");
    copyUrl.focus();
    await shot("28-copy-url");
    // The toast hides itself after 8 s: look for it before sitting out the next slot.
    await waitFor(() => seen("browse.urlCopied", { key: "notes/readme.txt" }), "URL copied", 5000).catch((e) => {
      throw new Error(`${e.message} (busy: ${all(".MuiLinearProgress-root").length}, alerts: ${all("[role=alert]").map((x) => x.textContent).join(" / ")})`);
    });
    await shot("-");

    // ---- create a bucket (versioning on), a folder in it, then delete everything ticked
    await click(T("browse.createBucket"));
    await type(T("dialogs.bucketName"), "Bad_Name");
    await waitFor(() => hasText(T("names.bucket.chars")), "bucket name rule shown");
    await type(T("dialogs.bucketName"), "ba-m5-ui-new");
    last(all(".MuiDialog-root .MuiSwitch-input")).click();
    await shot("29-create-bucket");
    await click(T("browse.createBucket"));
    await dialogsGone();
    await waitFor(() => hasText(versioningIs("on")) && hasText(T("browse.emptyFolder")) && button("ba-m5-ui-new"), "new versioned bucket opened");
    await click(T("browse.createFolder"));
    await type(T("dialogs.folderName"), "reports");
    await click(T("browse.createFolder"));
    await dialogsGone();
    await waitFor(() => all(folder("reports/")).length === 1, "folder listed");
    await clickSel(folder("reports/"));
    await waitFor(() => hasText(loaded(0, 0)), "the folder's own marker is not shown as content");
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: { paths: [`${CFG.FILES}/dropped.txt`], position: { x: 10, y: 10 } },
    });
    await waitFor(() => objectLink("reports/dropped.txt"), "file dropped into the new folder", 20000);
    await shot("30-new-folder");
    await click("ba-m5-ui-new");
    await waitFor(() => all(folder("reports/")).length === 1, "bucket root");
    last(all(`input${sel("browse.selectAll")}`)).click();
    await click(T("browse.deleteCount", { n: 1 }));
    await waitFor(
      () => seen("browse.deletePlanFolders", { objects: 2, bucket: "ba-m5-ui-new", folders: 1, list: "reports/" }) && hasText(T("object.undeleteHint")),
      "confirmation counts the folder's content",
    );
    await shot("31-delete-confirm");
    await click(T("browse.deleteConfirm", { n: 2 }));
    await dialogsGone();
    await waitFor(() => hasText(T("browse.deletedMarked", { n: 2 })) && hasText(T("browse.emptyFolder")), "selection deleted");
    // ---- undo from the toast, then versioning off: the same delete is now final
    await click(T("browse.undo"));
    await waitFor(() => hasText(T("browse.restored", { n: 2 })) && all(folder("reports/")).length === 1, "delete undone");
    await shot("32-undone");
    await click(T("browse.versioningOff"));
    await waitFor(() => hasText(T("browse.versioningOffTitle")), "versioning confirmation");
    await click(T("browse.versioningOff"));
    await dialogsGone();
    await waitFor(() => hasText(versioningIs("suspended")) && button(T("browse.versioningOn")), "versioning suspended");
    last(all(`input${sel("browse.selectAll")}`)).click();
    await click(T("browse.deleteCount", { n: 1 }));
    await waitFor(() => hasText(T("object.finalSuspended")), "red warning: this delete is final");
    await shot("33-final-delete");
    await click(T("browse.deleteConfirm", { n: 2 }));
    await dialogsGone();
    await waitFor(() => hasText(T("browse.deletedFinal", { n: 2 })) && hasText(T("browse.emptyFolder")) && !button(T("browse.undo")), "deleted for good, no undo offered");
    all(bucketButtons)[0].click(); // the first of the two buckets now listed
    await waitFor(() => hasText(loaded(4, 0)), "back in the fixture bucket");

    // ---- a second connection in a second tab: a read-only user's key, with the optional admin key
    await click(T("app.connections"));
    await type(T("conn.label"), "chi-doc");
    await type(T("conn.endpoint"), CFG.ENDPOINT);
    await type(T("conn.accessKey"), RO.ak);
    await type(T("conn.secretKey"), RO.sk);
    await openAdvanced();
    await type(T("conn.adminAccessKey"), CFG.AK);
    check(!button(T("common.save")), "half an admin key cannot be saved");
    await type(T("conn.adminSecretKey"), CFG.SK);
    await click(T("common.save"));
    await waitFor(() => hasText(T("conn.saved", { label: "chi-doc" })) && all("li").some((row) => row.textContent.includes("chi-doc") && row.textContent.includes(T("conn.adminKeyShort"))), "second connection saved, its row names both keys");
    await click(T("app.browse"));
    await menusGone();
    press("t");
    await waitFor(() => tabs().length === 2 && hasText(T("browse.chooseBucket")), "a new tab");
    await useConnection("chi-doc");
    await waitFor(() => hasText(T("browse.noBuckets")) && hasText(T("myinfo.title", { uid: READ_ONLY })), "read-only session; my info, read with the admin key", 20000);
    await clickSel("#my-info-header");
    await waitFor(() => hasText(T("myinfo.readOnly")) && hasText(T("myinfo.userQuota")) && hasText("M4 browse test"), "my own record, quota and usage", 20000);
    await shot("34-my-info");
    await clickSel("#my-info-header");
    // The admin key also lets this connection browse with another user's key.
    await type(T("browse.browseAs"), OWNER);
    await click(T("common.open"));
    await waitFor(() => hasText(T("browse.usingKeyOfUser", { uid: OWNER })) && all(bucketButtons).length === 2, "browsing with the owner's key", 20000);
    await click(T("browse.backToMyKey"));
    await waitFor(() => hasText(T("browse.usingKeyMine")) && hasText(T("browse.noBuckets")), "back on my own key", 20000);
    // M12.5: the path is typed into the field of the bucket card itself.
    const sidePath = await field(T("browse.openPath"));
    setValue(sidePath, BUCKET);
    sidePath.form.requestSubmit();
    await waitFor(() => sidePath.value === "", "the path field empties once its path is opened");
    await waitFor(() => hasText(loaded(4, 0)), "the read-only user can list");
    await click(T("common.upload"));
    await waitFor(() => hasText(T("error.s3.AccessDenied")), "upload refused for the read-only user", 30000);
    await shot("35-readonly-denied");

    // ---- M9.3 pinned places: back in the first tab (the owner's key). The task panel is folded:
    // it keeps the refused upload on show, and the sidebar needs the room.
    await click(T("tasks.fold"));
    await waitFor(() => button(T("tasks.unfold")), "task panel folded");
    // Errors shown by the tab on screen (the task panel has its own).
    const pane = () => last(all("[role=tabpanel]"));
    const paneErrors = () => [...pane().querySelectorAll('[class*="MuiAlert-"][class*="rror"]')].filter(visible).length;
    await menusGone();
    press("Tab");
    await waitFor(() => connectionShown() === "lab" && hasText(loaded(4, 0)), "Ctrl+Tab: the first tab again");
    check(pinnedRows().length === 0 && !panelOf("browse.pinnedList"), "nothing pinned yet: no Pinned panel");
    // (a) the toggle at the end of the breadcrumb row pins the open folder
    await clickSel(folder("notes/"));
    await waitFor(() => objectLink("notes/readme.txt"), "notes/");
    await clickSel(sel("browse.pinCurrent"));
    await waitFor(() => pinnedRows().join() === `${BUCKET}/notes` && last(all(sel("browse.unpinCurrent")))?.getAttribute("aria-pressed") === "true", "the open folder is pinned: a row in the panel, the toggle filled");
    // (c) the context menu of a folder row
    await click(BUCKET);
    await waitFor(() => hasText(loaded(4, 0)), "bucket root");
    rightClick(last(all(folder("media/"))).closest('[role="row"]'));
    await waitFor(() => menuItems().join(" | ") === [T("common.open"), T("browse.acl"), T("browse.pinFolder"), T("common.delete")].join(" | "), "a folder's menu offers to pin it");
    await click(T("browse.pinFolder"));
    await menusGone();
    await waitFor(() => pinnedRows().length === 2, "folder pinned from its menu");
    // (b) the context menu of a bucket row
    rightClick(bucketRow(BUCKET));
    await waitFor(() => menuItems().join(" | ") === [T("common.open"), T("pins.openTab"), T("browse.pinBucket")].join(" | "), "a bucket's menu");
    await click(T("browse.pinBucket"));
    await menusGone();
    await waitFor(() => pinnedRows().join(" | ") === [`${BUCKET}/notes`, `${BUCKET}/media`, BUCKET].join(" | "), "three pins, in the order they were pinned");
    check((await savedPins()) === [`${BUCKET}/notes/`, `${BUCKET}/media/`, `${BUCKET}/`].join(" | "), `the pins are in settings.json: ${await savedPins()}`);
    // (d) a recent place is pinned from its row, and unpinned from the menu of its pin
    first(all(`${sel("browse.recentList")} button[aria-pressed="false"]`)).click();
    await waitFor(() => pinnedRows().length === 4, "a recent place pinned from its row");
    rightClick(last(pinnedButtons()));
    await waitFor(() => menuItems().join(" | ") === [T("pins.openTab"), T("pins.rename"), T("browse.unpin"), T("pins.moveUp"), T("pins.moveDown")].join(" | "), "menu of a pinned place");
    check(last(all("[role=menuitem]")).getAttribute("aria-disabled") === "true", "the last pin cannot move down");
    check(inWindow(last(all(".MuiMenu-paper"))), "the menu of a pin is not clipped");
    await shot("36-pin-menu");
    await click(T("browse.unpin"));
    await menusGone();
    await waitFor(() => pinnedRows().length === 3, "unpinned from the menu");
    // Rename, then manual order.
    rightClick(first(pinnedButtons()));
    await click(T("pins.rename"));
    await type(T("pins.label"), "daily notes");
    await click(T("common.save"));
    await dialogsGone();
    await waitFor(() => pinnedRows()[0] === "daily notes" && first(pinnedButtons()).title === `lab · ${BUCKET}/notes`, "renamed; the tooltip still says where it leads");
    rightClick(first(pinnedButtons()));
    await click(T("pins.moveDown"));
    await menusGone();
    await waitFor(() => pinnedRows().join(" | ") === [`${BUCKET}/media`, "daily notes", BUCKET].join(" | "), "moved down");
    rightClick(pinnedButtons()[1]);
    await click(T("pins.moveUp"));
    await menusGone();
    await waitFor(() => pinnedRows().join(" | ") === ["daily notes", `${BUCKET}/media`, BUCKET].join(" | "), "and up again");
    check((await savedPins()) === [`${BUCKET}/notes/=daily notes`, `${BUCKET}/media/`, `${BUCKET}/`].join(" | "), `name and order are saved: ${await savedPins()}`);
    // A click opens the pin in this tab; Ctrl+click in a new one.
    first(pinnedButtons()).click();
    await waitFor(() => objectLink("notes/readme.txt") && tabs().length === 2, "a pin opens in the tab on screen");
    pinnedButtons()[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    await waitFor(() => tabs().length === 3 && objectLink("media/icon.png") && tabs()[2].textContent.includes("media"), "Ctrl+click opens the pin in a new tab");
    press("w");
    await waitFor(() => tabs().length === 2, "that tab closed again");
    press("Tab");
    press("Tab");
    await waitFor(() => connectionShown() === "lab" && objectLink("notes/readme.txt"), "the first tab, in the pinned folder");
    // The app bar's Pinned menu lists them too; a place that is open is shown in its tab.
    await click(T("app.pinned"));
    await waitFor(() => menuItems().join(" | ") === [T("pins.add"), `daily notes · lab · ${BUCKET}/notes`, `lab · ${BUCKET}/media`, `lab · ${BUCKET}`].join(" | "), "the Pinned menu of the app bar: pin a path, then the pins");
    check(fits() && inWindow(last(all(".MuiMenu-paper"))), "the Pinned menu fits the window");
    all("[role=menuitem]")[1].click();
    await waitFor(() => menuItems().length === 0 && tabs().length === 2 && objectLink("notes/readme.txt"), "an open place is not opened twice");
    check(fits(), "Browse with the Pinned panel does not scroll sideways");
    await shot("37-pinned");
    // Ctrl+D: first as the page sees it, then pressed for real by the shell (a synthetic event proves no shortcut).
    await openFolder("data/");
    await waitFor(() => objectLink("data/people.csv") && all(sel("browse.pinCurrent")).length === 1, "data/, not pinned");
    press("d");
    await waitFor(() => pinnedRows().length === 4 && all(sel("browse.unpinCurrent")).length === 1, "Ctrl+D pins the open folder");
    press("d");
    await waitFor(() => pinnedRows().length === 3 && all(sel("browse.pinCurrent")).length === 1, "Ctrl+D again unpins it");
    await shot("38-ctrl-d"); // the shell presses a real Ctrl+D here
    await waitFor(() => pinnedRows().join(" | ") === ["daily notes", `${BUCKET}/media`, BUCKET, `${BUCKET}/data`].join(" | "), "a real Ctrl+D pinned the open folder");
    press("d");
    await waitFor(() => pinnedRows().length === 3, "and it is unpinned again");

    // ---- M10.1 / M12.5 the path picker is the field of the bucket card: known places, and the folders S3
    // lists at the typed path, are rows in a dropdown under it
    const chipPaths = () => all(`${sel("pathPicker.chips")} [role=listitem]`).map((c) => c.textContent.trim());
    const children = () => all(`${sel("pathPicker.children")} [role=listitem]`);
    const picker = await field(T("browse.openPath"));
    check(chipPaths().length === 0 && children().length === 0, "no dropdown until the field has the keyboard");
    picker.focus();
    await waitFor(() => document.activeElement === picker && chipPaths().length > 0, "with the keyboard in the field its dropdown opens");
    check([`${BUCKET}/notes/`, `${BUCKET}/media/`, BUCKET].every((path) => chipPaths().includes(path)) && all(`${sel("pathPicker.chips")} [data-source=pin]`).length === 3, `pins and recent places are rows of it: ${chipPaths().join(" ")}`);
    // A bucket's name half typed: the listed buckets that start with it.
    setValue(picker, BUCKET.slice(0, 5));
    await waitFor(() => children().some((c) => c.textContent.trim() === `${BUCKET}/`), "a half-typed name suggests the bucket");
    setValue(picker, BUCKET);
    await waitFor(() => children().length === 4, "the bucket's folders are suggested", 15000);
    const firstFolder = children()[0].textContent.trim();
    check(children()[0].classList.contains("Mui-focusVisible"), "the first row is the highlighted one");
    // Tab, pressed for real by the shell after this picture, takes that row; the next level is asked about.
    picker.setSelectionRange(picker.value.length, picker.value.length);
    await shot("38a-path-suggest");
    await waitFor(() => picker.value === `${BUCKET}/${firstFolder}/` && document.activeElement === picker, `a real Tab completes the highlighted folder (${picker.value}) and stays in the field`, 15000);
    // The arrow down and the arrow right, as the page sees them: the second row, completed.
    setValue(picker, BUCKET);
    await waitFor(() => children().length === 4, "the folders again", 15000);
    const secondFolder = children()[1].textContent.trim();
    picker.setSelectionRange(picker.value.length, picker.value.length);
    for (const key of ["ArrowDown", "ArrowRight"]) picker.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await waitFor(() => picker.value === `${BUCKET}/${secondFolder}/`, `arrow down, then arrow right, complete the second folder (${picker.value})`);
    setValue(picker, BUCKET);
    await waitFor(() => children().length === 4, "the folders once more", 15000);
    children().find((c) => c.textContent.trim() === "media").click();
    await waitFor(() => picker.value === `${BUCKET}/media/` && children().length < 4, "a click on a folder appends it, and the new path is asked about", 15000);
    check(paneErrors() === 0, "no error on the way");
    check(fits(), "the open dropdown does not scroll the page sideways");
    await shot("38b-path-picker");
    picker.form.requestSubmit();
    await waitFor(() => objectLink("media/icon.png"), "the picked path opens", 20000);

    // ---- M9.1 a key that was granted one folder: start path, the refused root, Open path
    await addConnection("du-an", SCOPED, "my bucket/notes");
    await waitFor(() => hasText(T("paths.bucketSpace")), "a start path that cannot be one is refused while typing");
    check(!button(T("common.save")), "and cannot be saved");
    await type(T("conn.startPath"), ` s3://${BUCKET}/notes`, first);
    await testForm();
    await waitFor(() => formSays(T("conn.ok", { n: 0 })), "the scoped key connects (the lab lets every user list the buckets it owns: none)");
    await click(T("common.save"));
    await waitFor(() => hasText(T("conn.saved", { label: "du-an" })) && rowSays("du-an", `${BUCKET}/notes/`), "saved; the start path reads back in its stored form");
    check(!rowSays("lab", `${BUCKET}/`), "a connection without a start path shows none");
    await click(T("app.browse"));
    await menusGone();
    press("t");
    await waitFor(() => tabs().length === 3 && hasText(T("browse.chooseBucket")), "a new tab");
    await useConnection("du-an");
    await waitFor(() => objectLink("notes/readme.txt") && hasText(loaded(0, 3)) && tabs()[2].textContent.includes("notes"), "the connection lands at its start path", 20000);
    // M12.5: the connection's start path is the first row of the Pinned card, under "From the connection".
    const separators = () => all(`${sel("browse.pinnedList")} [role=separator]`).map((d) => d.textContent.trim());
    check(pinnedRows().length === 4 && pinnedRows()[0] === `${BUCKET}/notes/` && pinnedButtons()[0].querySelector("[data-source=start]"), `the start path is the first row of the Pinned card: ${pinnedRows().join(" | ")}`);
    check(separators().join(" | ") === [T("pins.fromConnection"), T("browse.pinsElsewhere")].join(" | "), `the start path and another connection's pins are each under a divider: ${separators().join(" | ")}`);
    // Above the granted folder S3 refuses; the error says what to do and leads to the field.
    await click(BUCKET);
    await waitFor(() => paneErrors() === 1 && pane().innerText.includes(T("error.s3.AccessDenied")) && hasText(T("browse.deniedHint")), "the bucket root is refused, with the way out");
    await shot("39-scoped-denied");
    await click(T("browse.openPath"));
    const pathField = await field(T("browse.openPath"));
    await waitFor(() => document.activeElement === pathField && !pathField.closest(".MuiDialog-root") && chipPaths().length > 0, "the hint leads to the path field of the bucket card, keyboard in it");
    check(chipPaths()[0] === `${BUCKET}/notes/` && all(`${sel("pathPicker.chips")} [role=listitem]`)[0].querySelector("[data-source=start]"), `the connection's start path is the first row: ${chipPaths().join(" ")}`);
    setValue(pathField, "bad bucket/x");
    await waitFor(() => hasText(T("paths.bucketSpace")), "a path that cannot be one says why");
    // Only the bucket typed: its root is refused. An amber hint; the path can still be submitted.
    setValue(pathField, BUCKET);
    await waitFor(() => hasText(T("pathPicker.deniedHint")) && button(T("common.open")), "a refused probe is a hint, and Open stays enabled", 15000);
    check(paneErrors() === 1, "the hint is no new error");
    await shot("39b-picker-denied");
    setValue(pathField, `s3://${BUCKET}/notes/readme.txt`);
    pathField.form.requestSubmit();
    await waitFor(() => objectLink("notes/readme.txt") && hasText(loaded(0, 3)) && paneErrors() === 0 && !hasText(T("browse.deniedHint")), "a file's path opens the folder the file is in", 20000);
    check(fits(), "nothing scrolls sideways");
    await shot("40-scoped-path");

    // ---- M9.1 a key RGW refuses ListBuckets: a notice, not an error
    await addConnection("no-list", NO_LIST);
    await testForm();
    await waitFor(() => formSays(T("conn.okNoList")), "the connection test passes and says the key may not list buckets");
    await click(T("common.save"));
    await waitFor(() => hasText(T("conn.saved", { label: "no-list" })), "saved");
    await click(T("app.browse"));
    await useConnection("no-list");
    await waitFor(() => hasText(T("browse.bucketsDenied")) && hasText(T("browse.chooseBucketDenied")), "the bucket panel explains instead of failing", 20000);
    check(paneErrors() === 0 && !hasText(T("browse.noBuckets")), "no error, and not the empty-list text");
    // No bucket list to choose from: the path picker is on the page itself, with the keyboard.
    const inline = await field(T("browse.openPath"));
    await waitFor(() => document.activeElement === inline && !inline.closest(".MuiDialog-root") && !inline.closest("aside"), "the path picker on the page has the keyboard");
    // M12.5: a bucket's name half typed by a key that cannot list buckets: nothing is said, in amber or otherwise.
    setValue(inline, BUCKET.slice(0, 5));
    await sleep(2500);
    check(!hasText(T("pathPicker.deniedHint")) && !pane().innerText.includes(piece("pathPicker.error")) && paneErrors() === 0, "a half-typed bucket name is probed silently");
    setValue(inline, "");
    await shot("41-no-list");

    // ---- M9.2 many buckets: a list of bounded height with a filter
    await addConnection("many", MANY_KEY);
    await testForm();
    await waitFor(() => formSays(T("conn.ok", { n: MANY })), "the key owns many buckets");
    await click(T("common.save"));
    await waitFor(() => hasText(T("conn.saved", { label: "many" })), "saved");
    await click(T("app.browse"));
    await useConnection("many");
    const counted = T("browse.bucketsCount", { title: T("browse.bucketsMine"), n: MANY });
    await waitFor(() => all(bucketButtons).length === MANY && all("aside h2").some((h) => h.textContent === counted), "every bucket listed, counted in the header", 20000);
    const list = last(all(sel("browse.bucketList")));
    const limit = Math.max(200, 0.38 * window.innerHeight);
    check(list.scrollHeight > list.clientHeight && list.clientHeight <= limit + 1 && getComputedStyle(list).overflowY === "auto", `the list scrolls inside its card: ${list.clientHeight} of ${list.scrollHeight} px, limit ${limit}`);
    const box = (key) => panelOf(key).getBoundingClientRect();
    const paneBox = pane().getBoundingClientRect();
    // M11 (the sidebar at a small window): right after connecting, with nothing scrolled, the bucket list is in view,
    // whole, with the buttons of its card; Pinned and Recent come after it and never push it down.
    const listBox = list.getBoundingClientRect();
    check(pane().scrollTop === 0 && listBox.top >= paneBox.top && listBox.bottom <= paneBox.bottom && box("browse.bucketList").bottom <= paneBox.bottom, `the bucket list is visible without scrolling the sidebar: list ${Math.round(listBox.top)}-${Math.round(listBox.bottom)}, card to ${Math.round(box("browse.bucketList").bottom)}, pane ${Math.round(paneBox.top)}-${Math.round(paneBox.bottom)}`);
    check(box("browse.pinnedList").top >= box("browse.bucketList").bottom && box("browse.recentList").top >= box("browse.pinnedList").bottom, "Pinned, then Recent, follow the bucket card");
    // Asked of the sidebar: the pane is as long as the bucket cards beside it (32 cards are 16 rows in a 900 px window).
    const side = last(all("aside"));
    check(box("browse.pinnedList").top - box("browse.bucketList").bottom < 24 && side.scrollHeight < 2 * window.innerHeight, `Pinned starts right under the bucket card; the sidebar is not thousands of pixels long: ${side.scrollHeight}`);
    notes.push(`window ${window.innerWidth}x${window.innerHeight}: pinned ${Math.round(box("browse.pinnedList").top)}-${Math.round(box("browse.pinnedList").bottom)}, bucket card ${Math.round(box("browse.bucketList").top)}-${Math.round(box("browse.bucketList").bottom)} (list ${list.clientHeight} of ${list.scrollHeight}), recent from ${Math.round(box("browse.recentList").top)}, pane ${Math.round(paneBox.top)}-${Math.round(paneBox.bottom)} scrolls ${pane().scrollHeight}`);
    check(fits(), "nothing scrolls sideways");
    const filter = await waitFor(() => last(all(`input${sel("browse.filterBuckets")}`)), "the filter field");
    // For the picture: as it is right after connecting, nothing scrolled.
    await shot("42-buckets-many");
    filter.focus();
    setValue(filter, "MANY-1");
    await waitFor(() => all(bucketButtons).length === 10 && hasText(T("browse.filterCount", { n: 10, m: MANY })), "a case-insensitive filter: 10 of 32");
    const key = (name) => filter.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    key("ArrowDown");
    key("ArrowDown");
    await waitFor(() => all(bucketButtons)[2].classList.contains("Mui-focusVisible"), "the arrow keys move a highlight down the list");
    await shot("43-buckets-filter");
    key("Enter");
    await waitFor(() => hasText(T("browse.emptyFolder")) && tabs()[2].textContent.includes(manyBucket(12)), "Enter opens the highlighted bucket", 20000);
    key("Escape");
    await waitFor(() => filter.value === "" && all(bucketButtons).length === MANY, "Esc clears the filter");
    // The open bucket is in view, and again when its tab is shown again.
    const selected = bucketRow(manyBucket(12));
    await waitFor(() => selected.classList.contains("Mui-selected") && selected.offsetTop >= list.scrollTop && selected.offsetTop + selected.offsetHeight <= list.scrollTop + list.clientHeight, "the open bucket is scrolled into view");
    bucketRow(manyBucket(30)).click();
    await waitFor(() => tabs()[2].textContent.includes(manyBucket(30)), "a bucket far down the list", 20000);
    list.scrollTop = 0;
    const open30 = () => bucketRow(manyBucket(30));
    check(open30().offsetTop > list.clientHeight, "it is out of view after scrolling the list back up");
    tabs()[0].click();
    await waitFor(() => connectionShown() === "lab", "another tab");
    tabs()[2].click();
    await waitFor(() => connectionShown() === "many" && open30().offsetTop + open30().offsetHeight <= list.scrollTop + list.clientHeight && open30().offsetTop >= list.scrollTop, "the open bucket is scrolled into view when its tab is shown again");
    // M9.4: the open tabs are written to settings.json (read back at the next start).
    await sleep(700);
    const kept = await invoke("tabs_get");
    check(kept.tabs.length === 3 && kept.tabs[2].at.bucket === manyBucket(30) && kept.active === kept.tabs[2].id, `open tabs saved: ${JSON.stringify(kept)}`);
    await shot("-"); // a slot of its own for the steps above

    // ---- M10.3 many tabs: the bar scrolls, the tab on screen is in view, a change of connection closes none
    const bar = document.querySelector(sel("app.tabs"));
    const inBar = (tab) => tab.getBoundingClientRect().left >= bar.getBoundingClientRect().left - 1 && tab.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1;
    for (let count = 4; count <= 12; count++) {
      press("t");
      await waitFor(() => tabs().length === count && last(tabs()).getAttribute("aria-selected") === "true", `tab ${count}`);
    }
    await waitFor(() => bar.scrollWidth > bar.clientWidth && inBar(last(tabs())) && !inBar(tabs()[0]), "twelve tabs: the bar scrolls and the new tab is in view");
    check(tabs().every((tab) => tab.getBoundingClientRect().width >= 100) && fits(), "tabs keep a readable width; the page does not scroll sideways");
    tabs()[0].click();
    await waitFor(() => inBar(tabs()[0]) && connectionShown() === "lab", "a tab chosen at the other end scrolls into view");
    await useConnection("many");
    await waitFor(() => all(bucketButtons).length === MANY && tabs().length === 12, "another connection in this tab: every tab is still there", 20000);
    notes.push(`12 tabs: bar ${bar.clientWidth} of ${bar.scrollWidth} px`);
    await shot("-"); // the removals below get the next slot

    // ---- M10.4 the audit log viewer: read-only, times in UTC+7, filterable
    await click(T("app.menu"));
    await clickSel("[role=menuitem]:last-child");
    const auditRows = () => all(`table${sel("audit.table")} tbody tr`);
    await waitFor(() => auditRows().length >= 10 && all("th").some((h) => h.textContent === T("audit.col.time", { tz: "UTC+7" })), "the audit log lists what the flow did", 20000);
    check(auditRows().every((r) => r.getBoundingClientRect().height >= 40), "audit rows keep the size floor");
    check(!button(T("common.delete")) && !hasText("CSV") && fits(), "no delete or export, nothing scrolls sideways");
    const auditFilter = await waitFor(() => last(all(`input${sel("audit.filter")}`)), "the audit filter");
    setValue(auditFilter, "acl.set");
    await waitFor(() => auditRows().length >= 2 && auditRows().every((r) => r.textContent.includes("acl.set")), "the filter narrows the list");
    setValue(auditFilter, "");
    await waitFor(() => auditRows().length >= 10, "and clears");
    await shot("44a-audit-log");

    // ---- remove every connection: their tabs and pins have nothing left to show
    await click(T("app.connections"));
    for (const label of ["chi-doc", "du-an", "no-list", "many", "lab"]) {
      await clickSel(sel("conn.more", { label }));
      await clickSel(sel("conn.remove", { label }));
      // M11: a connection is not removed by one click; the dialog says what goes with it.
      await waitFor(() => hasText(T("conn.removeTitle")) && hasText(T("conn.removeText", { label })), `the removal of ${label} is asked about`);
      await click(T("conn.removeConfirm"));
      await dialogsGone();
      await waitFor(() => !document.querySelector(sel("conn.more", { label })), `connection ${label} removed`);
    }
    await waitFor(() => all(sel("conn.countAria", { n: 20 })).length === 1 && savedRows() === 20, "the flow's connections are removed; the seeded ones are left");
    check((await invoke("pin_list")).length === 0, "the pins of removed connections are gone");
    banner(`SMOKE DONE: ${n + 1} slots, late: [${late.join(", ")}] | ${notes.join(" | ")}`, late.length ? "#fc6" : "#8f8");
    await shot("44-done");
