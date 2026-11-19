    // Browse flow (FLOW=browse). Data comes from `ui_smoke_browse_fixture_create` in tests/s3_lab.rs.
    const BUCKET = "ba-m4-ui-bucket";
    const OWNER = "ba-m4-ui";
    const READ_ONLY = "ba-m4-ui-ro";
    const drawer = () => last(all(".MuiDrawer-paper"));
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
    await waitFor(() => hasText("Versioning: Enabled"), "versioning chip");
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
    await waitFor(() => drawer().querySelector("img")?.naturalWidth === 128, "PNG loaded");
    await clickSel('[aria-label="Phóng to"]');
    await waitFor(() => hasText("150%"), "zoomed");
    await shot("07-image");
    await closeDrawer();
    await openObject("media/shape.svg");
    await waitFor(() => drawer().querySelector("img")?.naturalWidth > 0, "SVG loaded");
    await closeDrawer();
    await openObject("media/tone.wav");
    await waitFor(() => drawer().querySelector("audio")?.duration > 0.9, "audio metadata loaded", 20000);
    await shot("08-audio");
    await closeDrawer();
    if (CFG.MP4) {
      await openObject("media/clip.mp4");
      await waitFor(() => drawer().querySelector("video")?.videoWidth === 320, "video metadata loaded", 20000);
      drawer().querySelector("video").currentTime = 1;
      await sleep(1500);
    }
    await shot("09-video");
    if (CFG.MP4) await closeDrawer();
    await openObject("media/doc.pdf");
    await waitFor(() => drawer().querySelector("iframe"), "PDF frame");
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
    await click("Chi tiết");
    await type("Hết hạn sau", "30");
    await type("Đơn vị", "s");
    await click("Tạo URL");
    const urlField = await field("Presigned URL");
    await waitFor(() => /X-Amz-Signature=/.test(urlField.value) && /X-Amz-Expires=30(&|$)/.test(urlField.value), "URL with a 30 s expiry");
    await shot("12-presign");
    await click("Tải về");
    await waitFor(() => hasText(`Đã lưu vào ${CFG.FILES.replace("/files", "/dl")}/blob.bin`), "download finished", 20000);
    await closeDrawer();

    // ---- upload: the Upload button (20 MiB, multipart) and a dropped file
    await click("Upload");
    await waitFor(() => hasText("Xong · 20.0 MiB") && objectLink("bin/upload-20m.bin"), "multipart upload listed", 90000);
    await shot("13-upload-done");
    await openObject("bin/upload-20m.bin");
    await click("Chi tiết");
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
    await click("Versions");
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
    await waitFor(() => hasText("Owner:") && grants() === 1, "object ACL");
    await click("Thêm grant");
    setValue(await waitFor(() => last(all('input[aria-label="uid của grant 2"]')), "uid field"), READ_ONLY);
    await click("Áp dụng ACL");
    await waitFor(() => hasText("khớp với ACL vừa gửi") && grants() === 2, "ACL applied and read back");
    await shot("15-acl");
    await closeDrawer();
    await click("ACL của bucket");
    await waitFor(() => hasText(`ACL của bucket ${BUCKET}`) && hasText("Owner:"), "bucket ACL");
    await shot("16-bucket-acl");
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
    await click("Chi tiết");
    await click("Xoá object");
    await waitFor(() => hasText("Xoá object?"), "delete confirmation");
    await click("Xoá object");
    await drawersGone();
    await waitFor(() => !objectLink("bin/upload-20m.bin"), "object gone from the listing");

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

    await click("Clusters");
    await clickSel('[aria-label="Xoá cluster lab"]');
    await waitFor(() => hasText("Chưa có cluster nào."), "cluster removed");
    banner(`SMOKE DONE: ${n + 1} slots, late: [${late.join(", ")}]`, late.length ? "#fc6" : "#8f8");
    await shot("20-done");
