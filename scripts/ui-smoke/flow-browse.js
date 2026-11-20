    // The app end to end (FLOW=browse), as a user who only has an S3 key. Data comes from
    // `ui_smoke_browse_fixture_create` in tests/s3_lab.rs; its two users have fixed keys so
    // they can be typed in here: the owner of the bucket, and a read-only user.
    const BUCKET = "ba-m4-ui-bucket";
    const OWNER = "ba-m4-ui";
    const READ_ONLY = "ba-m4-ui-ro";
    const KEY = (n) => ({ ak: `BAM7UISMOKEKEY00000${n}`, sk: `bam7uismokesecret00000000000000000000000${n}` });
    const [MINE, RO] = [KEY(1), KEY(2)];
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
    // Wholly inside the window (menus, the sheet).
    const inWindow = (el) => {
      const [r, page] = [el.getBoundingClientRect(), document.documentElement];
      return r.left >= 0 && r.top >= 0 && r.right <= page.clientWidth && r.bottom <= page.clientHeight;
    };
    const rowOf = async (key) => (await waitFor(() => objectLink(key), `row of ${key}`)).closest('[role="row"]');

    // ---- no connection yet: the app opens where one can be added. The update check (its
    // answer is canned for this run) shows a toast once and a badge that stays.
    await waitFor(() => hasText(T("conn.none")) && hasText(T("conn.add")), "connections screen", 30000);
    await waitFor(() => seen("app.update.toast", { tag: "v9.9.9" }) && button(T("app.update.open")), "update toast");
    check(all(".MuiChip-root").some((c) => c.textContent === T("app.update.badge", { tag: "v9.9.9" })), "update badge in the masthead");
    check(!button("Users") && !button("Buckets") && !button("Audit"), "no admin screens");
    await type(T("conn.label"), "lab");
    await type(T("conn.endpoint"), CFG.ENDPOINT);
    await type(T("conn.accessKey"), MINE.ak);
    await type(T("conn.secretKey"), "not-the-secret-0000000000000000000000000");
    // The lab is a private address: "no proxy" is suggested for it.
    await waitFor(() => hasText(T("conn.internalHint")), "no-proxy suggestion for a private endpoint");
    await click(T("conn.noProxy.pick"));
    await waitFor(() => proxyOf(T("proxy.name.new")).value === "none", "suggestion taken");
    await click(T("conn.test"));
    await waitFor(() => hasText(T("error.s3.SignatureDoesNotMatch")), "a wrong secret is named as such");
    await type(T("conn.secretKey"), MINE.sk);
    await click(T("conn.test"));
    await waitFor(() => hasText(T("conn.ok", { n: 1 })), "connection test over S3, no admin caps needed");
    check(fits(), "Connections does not scroll sideways");
    await shot("01-connection");
    await click(T("common.save"));
    await waitFor(() => hasText(T("conn.saved", { label: "lab" })) && proxyOf(T("proxy.name.of", { label: "lab" }))?.value === "none", "connection saved with its own proxy choice");

    // ---- Browse: the key's buckets as cards, then one bucket
    await click(T("app.browse"));
    await waitFor(() => hasText(T("browse.chooseBucket")) && hasText(T("browse.usingKeyMine")) && hasText(BUCKET), "bucket cards of the key's user", 20000);
    check(all("label").every((l) => !l.textContent.startsWith(T("browse.browseAs"))) && !hasText(piece("myinfo.title")), "a key without caps: no admin extras");
    check(fits(), "the bucket cards do not scroll sideways");
    await shot("02-buckets");
    await clickSel(bucketButtons);
    await waitFor(() => hasText(loaded(4, 0)), "bucket root");
    await waitFor(() => hasText(versioningIs("on")), "versioning chip");
    check(tabs().length === 1 && tabs()[0].textContent.startsWith(BUCKET), "the tab is named after the bucket");
    check(fits(), "Browse does not scroll sideways");
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
    check(wide < 1200 || fits(), "Browse does not scroll sideways at 125 %");
    rightClick(last(all(folder("notes/"))).closest('[role="row"]'));
    await waitFor(() => menuItems().length > 0, "context menu at 125 %");
    check(inWindow(last(all(".MuiMenu-paper"))), "the context menu is not clipped at 125 %");
    last(all(".MuiMenu-root .MuiBackdrop-root")).click();
    await menusGone();
    // A dialog scales with the page and stays inside the window.
    await click(T("browse.createFolder"));
    const dialog = await waitFor(() => last(all(".MuiDialog-paper")), "dialog at 125 %");
    check(inWindow(dialog) && fits(), "the dialog fits the window at 125 %");
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
    const labelled = all("[role=columnheader]").some((h) => h.textContent === T("browse.col.modified", { tz: "UTC+7" }));
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
    await waitFor(() => tabs().length === 2 && hasText(T("browse.chooseBucket")) && tabs()[1].textContent.startsWith(T("tabs.new")), "Ctrl+T: a new tab on the bucket cards");
    await clickSel(bucketButtons);
    await waitFor(() => hasText(loaded(4, 0)), "bucket root in the second tab");
    await clickSel(folder("media/"));
    await waitFor(() => objectLink("media/icon.png") && tabs()[1].textContent.startsWith("media"), "the second tab is in media/ and its title says so");
    check(!objectLink("notes/readme.txt"), "the first tab's rows are not on screen");
    await shot("24-two-tabs");
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
    await waitFor(() => tabs().length === 3 && objectLink("data/people.csv") && tabs()[2].textContent.startsWith("data"), "another recent place opens as a new tab");
    await menusGone(); // the shortcuts are off while a menu, dialog or sheet is open
    press("w");
    await waitFor(() => tabs().length === 2 && objectLink("media/icon.png"), "Ctrl+W closes the tab; its neighbour takes over");
    await menusGone(); // the shortcuts are off while a menu, dialog or sheet is open
    press("w");
    await waitFor(() => tabs().length === 1 && objectLink("notes/readme.txt"), "back to one tab");
    check(all(`${sel("browse.recentList")} [role=button]`).length >= 4, "the sidebar lists recent places too");

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
    await waitFor(() => seen("browse.urlCopied", { key: "notes/readme.txt" }), "URL copied", 5000);
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
    document.querySelector("form details").open = true;
    await type(T("conn.adminAccessKey"), CFG.AK);
    check(!button(T("common.save")), "half an admin key cannot be saved");
    await type(T("conn.adminSecretKey"), CFG.SK);
    await click(T("common.save"));
    await waitFor(() => hasText(T("conn.saved", { label: "chi-doc" })) && all("li").some((row) => row.textContent.includes("chi-doc") && row.textContent.includes(T("conn.adminKeyShort"))), "second connection saved, its row names both keys");
    await click(T("app.browse"));
    await menusGone();
    press("t");
    await waitFor(() => tabs().length === 2 && hasText(T("browse.chooseBucket")), "a new tab");
    const connection = await field(T("common.connection"));
    setValue(connection, [...connection.options].find((o) => o.textContent === "chi-doc").value);
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
    await type(T("browse.openByName"), BUCKET);
    await click(T("browse.openBucket"));
    await waitFor(() => hasText(loaded(4, 0)), "the read-only user can list");
    await click(T("common.upload"));
    await waitFor(() => hasText(T("error.s3.AccessDenied")), "upload refused for the read-only user", 30000);
    await shot("35-readonly-denied");

    // ---- remove both connections: their tabs have nothing left to show
    await click(T("app.connections"));
    await clickSel(sel("conn.remove", { label: "chi-doc" }));
    await waitFor(() => !document.querySelector(sel("conn.remove", { label: "chi-doc" })), "second connection removed");
    await clickSel(sel("conn.remove", { label: "lab" }));
    await waitFor(() => hasText(T("conn.none")), "connections removed");
    banner(`SMOKE DONE: ${n + 1} slots, late: [${late.join(", ")}]`, late.length ? "#fc6" : "#8f8");
    await shot("36-done");
