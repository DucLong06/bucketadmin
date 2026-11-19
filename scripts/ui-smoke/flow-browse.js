    // Browse flow (FLOW=browse). Data comes from `ui_smoke_browse_fixture_create` in tests/s3_lab.rs.
    const BUCKET = "ba-m4-ui-bucket";
    const OWNER = "ba-m4-ui";
    const READ_ONLY = "ba-m4-ui-ro";
    const drawer = () => last(all(".MuiDrawer-paper"));
    // Media is shown by /preview.html inside a frame of the drawer.
    const media = (tag) => drawer().querySelector("iframe")?.contentDocument?.querySelector(tag);
    const objectLink = (key) => document.querySelector(`[aria-label="Mở object ${key}"]`);
    const openObject = (key) => clickSel(`[aria-label="Mở object ${key}"]`);
    const openFolder = async (prefix) => {
      await click(BUCKET); // breadcrumb root
      await clickSel(`[aria-label="Mở thư mục ${prefix}"]`);
    };
    const closeDrawer = async () => {
      await click("Đóng");
      await drawersGone();
    };
    const versions = () => all('[aria-label^="Tải về version"]').length;
    const grants = () => all('[aria-label^="Bỏ grant"]').length;

    await waitFor(() => button("Clusters"), "app to load", 30000);
    await click("Clusters");
    await type("Tên hiển thị", "lab");
    await type("Endpoint", CFG.ENDPOINT);
    await type("Access key", CFG.AK);
    await type("Secret key", CFG.SK);
    await click("Lưu");
    await waitFor(() => hasText("Đã lưu"), "profile saved");

    // ---- from a user's drawer into Browse, working as that user
    await click("Users");
    await clickSel(`[aria-label="Mở chi tiết user ${OWNER}"]`);
    await clickSel(`[aria-label="Browse với user ${OWNER}"]`);
    await waitFor(() => hasText(`của chính user ${OWNER}`) && hasText(BUCKET), "browse session", 20000);
    await shot("01-browse-session");
    await clickSel('[aria-label="Danh sách bucket"] [role=button]');
    await waitFor(() => hasText("4 thư mục, 0 object đã tải"), "bucket root");
    await waitFor(() => hasText("Versioning: Bật"), "versioning chip");
    await shot("02-bucket-root");

    // ---- text: line numbers, Ctrl-F, find
    await openFolder("notes/");
    await openObject("notes/readme.txt");
    await waitFor(() => hasText("dòng 1: ok"), "text preview");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    check(document.activeElement === (await field("Tìm trong file (Ctrl-F)")), "Ctrl-F focuses the find box");
    await type("Tìm trong file (Ctrl-F)", "error");
    await waitFor(() => hasText("1/3 dòng") && hasText("dòng 50: ERROR"), "first hit scrolled into view");
    await click("Sau");
    await waitFor(() => hasText("2/3 dòng") && hasText("dòng 250: ERROR"), "second hit scrolled into view");
    await shot("03-text-find");
    await closeDrawer();
    await openObject("notes/config.json");
    await waitFor(() => hasText('"retention_days": 30'), "re-indented JSON");
    await shot("04-json");
    await closeDrawer();

    // ---- CSV and Parquet
    await openFolder("data/");
    await openObject("data/people.csv");
    await waitFor(() => hasText("200 dòng dữ liệu, 4 cột") && hasText("Nguyen, An 1"), "CSV table with a quoted comma");
    (await waitFor(() => first(all('[aria-label="Copy dòng 1"]')), "copy button of row 1")).focus();
    await shot("05-csv"); // the shell presses a real Enter here and reads the clipboard
    await shot("-");
    await closeDrawer();
    await openObject("data/sample.parquet");
    await waitFor(() => hasText("Dòng 1–100 / 2000") && hasText("row-1") && hasText("meta : Struct"), "first Parquet page", 20000);
    await click("Trang sau");
    await waitFor(() => hasText("Dòng 101–200 / 2000") && hasText("row-100"), "second Parquet page", 20000);
    await type("Tới dòng", "1990");
    (await field("Tới dòng")).form.requestSubmit();
    await waitFor(() => hasText("Dòng 1990–2000 / 2000") && hasText("row-1999"), "jump to the last rows", 20000);
    await shot("06-parquet");
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
    await clickSel('[aria-label="Phóng to"]');
    await waitFor(() => hasText("150%") && media("img").width === 192, "zoomed to 150%");
    await shot("07-image");
    await closeDrawer();
    await openObject("media/shape.svg");
    await waitFor(() => media("img")?.naturalWidth > 0, "SVG loaded");
    await closeDrawer();
    await openObject("media/tone.wav");
    await waitFor(() => media("audio")?.duration > 0.9, "audio metadata loaded", 20000);
    await shot("08-audio");
    await closeDrawer();
    if (CFG.MP4) {
      await openObject("media/clip.mp4");
      await waitFor(() => media("video")?.videoWidth === 320, "video metadata loaded", 20000);
      media("video").currentTime = 1;
      await sleep(1500);
    }
    await shot("09-video");
    if (CFG.MP4) await closeDrawer();
    await openObject("media/doc.pdf");
    await waitFor(() => media("iframe"), "PDF frame inside the preview frame");
    await sleep(4000);
    await shot("10-pdf"); // what the frame shows can only be judged from the screenshot
    await closeDrawer();

    // ---- hex, presign, download through the save dialog (answered by the debug-only env)
    await openFolder("bin/");
    await openObject("bin/blob.bin");
    await waitFor(() => hasText("00000000  ") && hasText("Đã tải 4.00 KiB / 10.0 KiB"), "first 4 KiB as hex");
    await click("Tải thêm 4 KiB");
    await waitFor(() => hasText("Đã tải 8.00 KiB / 10.0 KiB") && hasText("00001000  "), "next 4 KiB");
    await shot("11-hex");
    await click("Properties");
    await type("Hết hạn sau", "30");
    await type("Đơn vị", "s");
    await click("Tạo URL");
    const urlField = await field("Presigned URL");
    await waitFor(() => /X-Amz-Signature=/.test(urlField.value) && /X-Amz-Expires=30(&|$)/.test(urlField.value), "URL with a 30 s expiry");
    await shot("12-presign");
    await waitFor(() => /Content-Type\s+\S*octet-stream/.test(drawer().innerText), "content type from a HEAD");
    await click("Headers");
    await waitFor(() => hasText("x-amz-request-id") && hasText("content-length") && hasText("10240"), "raw HEAD headers");
    await shot("12b-headers");
    await click("Tags");
    await waitFor(() => hasText("Object chưa có tag nào."), "no tags yet");
    await click("Thêm tag");
    setValue(await waitFor(() => last(all('input[aria-label="Key của tag 1"]')), "tag key field"), "env");
    setValue(last(all('input[aria-label="Value của tag 1"]')), "lab");
    await click("Lưu tag");
    await waitFor(() => hasText("Đã lưu. Danh sách trên là tag đang có trên object."), "tags saved and read back");
    await shot("12c-tags");
    await click("Properties");
    await click("Tải về");
    await waitFor(() => hasText(`Đã lưu vào ${CFG.FILES.replace("/files", "/dl")}/blob.bin`), "download finished", 20000);
    await closeDrawer();

    // ---- upload: the Upload button (20 MiB, multipart) and a dropped file
    await click("Upload");
    (await waitFor(() => last(all('[aria-label^="Huỷ ↑"]')), "cancel button of the running upload")).click();
    await waitFor(() => hasText("Đã huỷ.") && !objectLink("bin/upload-20m.bin"), "upload cancelled, nothing uploaded", 60000);
    check(hasText("Tasks —"), "the task panel is shown");
    await shot("13a-task-cancelled");
    await click("Xoá mục đã xong");
    await click("Upload");
    await waitFor(() => hasText("Xong · 20.0 MiB") && objectLink("bin/upload-20m.bin"), "multipart upload listed", 90000);
    // ---- times are Vietnam's (UTC+7) although this process runs with TZ=UTC. The expected value is
    // worked out by plain arithmetic here, not with the Intl call the app itself uses.
    check(new Date().getTimezoneOffset() === 0, "the app under test runs in UTC");
    const secondsOfDay = (hms) => hms.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    const vietnamNow = (Math.floor(Date.now() / 1000) + 7 * 3600) % 86400;
    const apart = (shown) => Math.min((shown - vietnamNow + 86400) % 86400, (vietnamNow - shown + 86400) % 86400);
    const taskTime = last(all('[aria-label="Tasks"] p').filter((p) => /^\d\d:\d\d:\d\d$/.test(p.textContent.trim()))).textContent.trim();
    check(hasText("giờ UTC+7") && apart(secondsOfDay(taskTime)) < 300, `task time ${taskTime} is the time in Vietnam`);
    const modified = [...objectLink("bin/upload-20m.bin").closest('[role="row"], tr').querySelectorAll("*")]
      .map((cell) => /^\d{4}-\d\d-\d\d (\d\d:\d\d)$/.exec(cell.textContent.trim()))
      .find(Boolean);
    check(hasText("Sửa lần cuối (UTC+7)") && modified && apart(secondsOfDay(`${modified[1]}:00`)) < 300, `last-modified ${modified?.[0]} is the time in Vietnam`);
    await shot("13-upload-done");
    await openObject("bin/upload-20m.bin");
    await click("Properties");
    await click("Tải về");
    await waitFor(() => hasText("/dl/upload-20m.bin"), "20 MiB download finished", 90000);
    await closeDrawer();
    // A synthetic drop event: it proves the page's drop handling, not GTK's delivery of real drops.
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: { paths: [`${CFG.FILES}/dropped.txt`], position: { x: 10, y: 10 } },
    });
    await waitFor(() => objectLink("bin/dropped.txt"), "dropped file uploaded", 20000);

    // ---- versions
    await openFolder("notes/");
    await openObject("notes/versioned.txt");
    await click("Phiên bản");
    await waitFor(() => versions() === 3, "three versions");
    await shot("14-versions");
    last(all('[aria-label^="Khôi phục version"]')).click();
    await waitFor(() => hasText("Khôi phục version?"), "restore confirmation");
    await click("Khôi phục");
    await dialogsGone();
    await waitFor(() => versions() === 4, "restore wrote a fourth version");
    last(all('[aria-label^="Xoá version"]')).click();
    await waitFor(() => hasText("Xoá version?"), "delete confirmation");
    await click("Xoá version");
    await dialogsGone();
    await waitFor(() => versions() === 3, "one version deleted");

    // ---- ACL of the object, then of the bucket
    await click("ACL");
    await waitFor(() => hasText("Owner:") && hasText("Chủ sở hữu") && grants() === 0, "object ACL as a quick-share table");
    check(document.querySelector('input[aria-label="Chủ sở hữu: FULL_CONTROL"]').checked, "the owner row shows FULL_CONTROL");
    await click("Thêm user");
    setValue(await waitFor(() => last(all('input[aria-label="uid của grant 2"]')), "uid field"), READ_ONLY);
    await click("Áp dụng ACL");
    await waitFor(() => hasText("khớp với ACL vừa gửi") && grants() === 1, "ACL applied and read back");
    await shot("15-acl");
    await closeDrawer();
    await click("ACL của bucket");
    await waitFor(() => hasText(`ACL của bucket ${BUCKET}`) && hasText("Owner:"), "bucket ACL");
    await shot("16-bucket-acl");
    await click("Đóng");
    await dialogsGone();

    // ---- one ACL for every object of a folder: preset, warning, count, progress
    await openFolder("notes/");
    await click("ACL thư mục");
    await waitFor(() => hasText("ACL cho object trong thư mục notes/") && hasText("Owner:"), "folder ACL");
    await click("Công khai đọc (public-read)");
    await waitFor(() => hasText('Đang cấp READ cho "Mọi người (public)"'), "public access warning");
    check(!button("Áp dụng ACL"), "a folder has nothing to apply to until the recursive box is ticked");
    last(all(".MuiDialog-root input[type=checkbox]")).click();
    await waitFor(() => hasText("Áp dụng đệ quy cho 3 object trong thư mục notes/"), "object count");
    await shot("16b-folder-acl");
    await click("Áp dụng ACL cho 3 mục");
    await waitFor(() => hasText("Đã đặt ACL cho 3/3 object."), "ACL applied to the folder", 20000);
    await click("Đóng");
    await dialogsGone();

    // ---- search from the bucket root
    await click(BUCKET);
    await type("Tìm trong thư mục này và các thư mục con", "*.parquet");
    await click("Tìm");
    await waitFor(() => hasText("1 object khớp") && hasText("đã quét hết") && objectLink("data/sample.parquet"), "search result");
    await shot("17-search");
    await click("Đóng kết quả");

    // ---- delete an object
    await openFolder("bin/");
    await openObject("bin/upload-20m.bin");
    await click("Properties");
    await click("Xoá object");
    await waitFor(() => hasText("Xoá object?") && hasText("khôi phục được từ tab Phiên bản"), "delete confirmation says it can be undone");
    await click("Xoá object");
    await drawersGone();
    await waitFor(() => hasText("Đã đánh dấu xoá 1 object") && button("Hoàn tác") && !objectLink("bin/upload-20m.bin"), "object gone, undo offered");
    // ---- the deleted object can still be found, with nothing but its versions
    await click("Hiện object đã xoá");
    await waitFor(() => hasText("1 object đã xoá còn khôi phục được") && objectLink("bin/upload-20m.bin"), "deleted object listed");
    check(!document.querySelector('input[aria-label="Chọn upload-20m.bin"]'), "a deleted object cannot be ticked");
    await openObject("bin/upload-20m.bin");
    await waitFor(() => hasText("đang ở trạng thái đã xoá") && all('[aria-label^="Gỡ marker"]').length === 1, "versions of the deleted object");
    check(all(".MuiDrawer-paper [role=tab]").length === 1, "a deleted object only has its versions tab");
    await shot("17a-deleted-shown");
    await closeDrawer();
    await click("Ẩn object đã xoá");
    await waitFor(() => !objectLink("bin/upload-20m.bin"), "deleted objects hidden again");

    // ---- Copy URL of the one ticked object (a real Enter from the shell: the clipboard ignores synthetic clicks)
    await openFolder("notes/");
    (await waitFor(() => last(all('input[aria-label="Chọn readme.txt"]')), "checkbox of readme.txt")).click();
    const copyUrl = await waitFor(() => button("Copy URL"), "Copy URL enabled for one object");
    check(!!button("Xoá (1)"), "the delete button shows the number of ticked rows");
    copyUrl.focus();
    await shot("17b-copy-url");
    // The toast hides itself after 8 s: look for it before sitting out the next slot.
    await waitFor(() => hasText("Đã copy presigned URL của notes/readme.txt"), "URL copied", 5000);
    await shot("-");

    // ---- create a bucket (versioning on), a folder in it, then delete everything ticked
    await click("Tạo bucket");
    await type("Tên bucket", "Bad_Name");
    await waitFor(() => hasText("Chỉ dùng chữ thường, số, dấu chấm và dấu gạch ngang."), "bucket name rule shown");
    await type("Tên bucket", "ba-m5-ui-new");
    last(all(".MuiDialog-root .MuiSwitch-input")).click();
    await shot("17c-create-bucket");
    await click("Tạo bucket");
    await dialogsGone();
    await waitFor(() => hasText("Versioning: Bật") && hasText("Thư mục trống.") && button("ba-m5-ui-new"), "new versioned bucket opened");
    await click("Tạo thư mục");
    await type("Tên thư mục", "reports");
    await click("Tạo thư mục");
    await dialogsGone();
    await waitFor(() => all('[aria-label="Mở thư mục reports/"]').length === 1, "folder listed");
    await clickSel('[aria-label="Mở thư mục reports/"]');
    await waitFor(() => hasText("0 thư mục, 0 object đã tải"), "the folder's own marker is not shown as content");
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: { paths: [`${CFG.FILES}/dropped.txt`], position: { x: 10, y: 10 } },
    });
    await waitFor(() => objectLink("reports/dropped.txt"), "file dropped into the new folder", 20000);
    await shot("17d-new-folder");
    await click("ba-m5-ui-new");
    await waitFor(() => all('[aria-label="Mở thư mục reports/"]').length === 1, "bucket root");
    last(all('input[aria-label="Chọn tất cả các dòng đang hiện"]')).click();
    await click("Xoá (1)");
    await waitFor(
      () => hasText("Xoá 2 object trong bucket ba-m5-ui-new") && hasText("toàn bộ nội dung của 1 thư mục (reports/)") && hasText("khôi phục được từ tab Phiên bản"),
      "confirmation counts the folder's content",
    );
    await shot("17e-delete-confirm");
    await click("Xoá 2 object");
    await dialogsGone();
    await waitFor(() => hasText("Đã đánh dấu xoá 2 object") && hasText("Thư mục trống."), "selection deleted");
    // ---- undo from the toast, then versioning off: the same delete is now final
    await click("Hoàn tác");
    await waitFor(() => hasText("Đã khôi phục 2 object.") && all('[aria-label="Mở thư mục reports/"]').length === 1, "delete undone");
    await shot("17f-undone");
    await click("Tắt versioning");
    await waitFor(() => hasText("Tắt versioning?"), "versioning confirmation");
    await click("Tắt versioning");
    await dialogsGone();
    await waitFor(() => hasText("Versioning: Tạm dừng") && button("Bật versioning"), "versioning suspended");
    last(all('input[aria-label="Chọn tất cả các dòng đang hiện"]')).click();
    await click("Xoá (1)");
    await waitFor(() => hasText("KHÔNG THỂ HOÀN TÁC"), "red warning: this delete is final");
    await shot("17g-final-delete");
    await click("Xoá 2 object");
    await dialogsGone();
    await waitFor(() => hasText("Đã xoá 2 object.") && hasText("Thư mục trống.") && !button("Hoàn tác"), "deleted for good, no undo offered");
    all('[aria-label="Danh sách bucket"] [role=button]')[0].click(); // the first of the two buckets now listed
    await waitFor(() => hasText("4 thư mục, 0 object đã tải"), "back in the fixture bucket");

    // ---- the same bucket as a read-only user: can look, cannot upload
    await type("Browse với user (uid)", READ_ONLY);
    await click("Mở");
    await waitFor(() => hasText(`của chính user ${READ_ONLY}`) && hasText("User không sở hữu bucket nào."), "read-only session", 20000);
    await type("Mở bucket theo tên", BUCKET);
    await click("Mở bucket");
    await waitFor(() => hasText("4 thư mục"), "read-only user can list");
    await click("Upload");
    await waitFor(() => hasText("Key của user này không có quyền"), "upload refused for the read-only user", 30000);
    await shot("18-readonly-denied");

    await click("Audit");
    await waitFor(() => rows() >= 8, "audit rows");
    await shot("19-audit");
    await type("Action", "acl.set");
    await waitFor(() => rows() === 1 && hasText("verified=true"), "acl.set row");
    await type("Action", "acl.set_many");
    await waitFor(() => rows() === 1 && hasText("objects=3 applied=3 unverified=0 failed=0"), "acl.set_many row");
    for (const action of ["bucket.create", "folder.create", "object.undelete", "bucket.versioning.set", "object.tags.set"]) {
      await type("Action", action);
      await waitFor(() => rows() === 1, `one ${action} row`);
    }
    await type("Action", "object.delete_many");
    await waitFor(() => rows() === 2 && hasText("delete_markers=2") && hasText("delete_markers=0"), "two object.delete_many rows");

    await click("Clusters");
    await clickSel('[aria-label="Xoá cluster lab"]');
    await waitFor(() => hasText("Chưa có cluster nào."), "cluster removed");
    banner(`SMOKE DONE: ${n + 1} slots, late: [${late.join(", ")}]`, late.length ? "#fc6" : "#8f8");
    await shot("20-done");
