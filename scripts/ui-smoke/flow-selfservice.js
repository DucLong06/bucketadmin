    // Self-service flow (FLOW=selfservice): the app in the hands of people who are not cluster
    // admins. Users come from `ui_smoke_m6_fixture_create` in tests/rgw_lab.rs, with fixed keys:
    //   ba-m6-ui-plain  no caps at all            -> "Chỉ browse", own-key browse
    //   ba-m6-ui-self   users=read, usage=read    -> "Xem của mình", the "Thông tin của tôi" box
    //   ba-m6-ui-ro     every read cap, no write  -> "Thiếu caps", a refusal that names the cap
    const KEY = (i) => ({ ak: `BAM6UISMOKEKEY00000${i}`, sk: `bam6uismokesecret00000000000000000000000${i}` });
    const [PLAIN, SELF, RO] = [KEY(1), KEY(2), KEY(3)];
    const BUCKET = "ba-m6-ui-bucket";
    const tab = (text) => all("[role=tab]").find((t) => t.textContent.trim() === text);
    const badge = (text) => all("header .MuiChip-root").some((c) => c.textContent === text);
    async function addCluster(label, key) {
      await click("Clusters");
      await type("Tên hiển thị", label);
      await type("Endpoint", CFG.ENDPOINT);
      await type("Access key", key.ak);
      await type("Secret key", key.sk);
    }
    async function useCluster(label) {
      const select = await field("Cluster");
      setValue(select, [...select.options].find((o) => o.textContent === label).value);
    }

    await waitFor(() => button("Clusters"), "app to load", 30000);

    // ---- a normal user: the connection test explains itself, the checkbox hides the admin tabs
    await addCluster("plain", PLAIN);
    await click("Kiểm tra kết nối");
    await waitFor(() => hasText("key hợp lệ, nhưng key này không có caps admin"), "connection test of a key without caps");
    first(all("form input[type=checkbox]")).click();
    await shot("01-plain-test");
    await click("Lưu");
    await waitFor(() => hasText('Đã lưu "plain"'), "profile saved");
    await waitFor(() => badge("Chỉ browse") && !tab("Users") && !tab("Buckets"), "badge and hidden admin tabs");
    await shot("02-plain-badge");

    // ---- Browse opens straight away with the user's own key
    await click("Browse");
    await waitFor(() => hasText("của bạn (lưu trong keychain)") && hasText("User không sở hữu bucket nào."), "own-key session", 20000);
    check(all("label").every((l) => !l.textContent.startsWith("Browse với user")), "no browse-as-uid box for a normal user");
    await shot("03-own-key-session");
    await click("Tạo bucket");
    await type("Tên bucket", BUCKET);
    await click("Tạo bucket");
    await dialogsGone();
    await waitFor(() => hasText("Thư mục trống."), "new bucket opened");
    await click("Upload");
    await waitFor(() => document.querySelector('[aria-label="Mở object hello.txt"]'), "uploaded object listed", 20000);
    await clickSel('[aria-label="Mở object hello.txt"]');
    await waitFor(() => hasText("xin chào từ key của tôi"), "text preview");
    await shot("04-own-key-preview");
    await click("ACL");
    await waitFor(() => all('[aria-label^="Bỏ grant"]').length === 1 && hasText("ba-m6-ui-plain"), "ACL names the key's owner");
    await shot("05-own-key-acl");
    await click("Đóng");
    await drawersGone();
    await clickSel('[aria-label="Chọn hello.txt"]');
    await click("Copy URL");
    await waitFor(() => hasText("Đã copy presigned URL của hello.txt"), "presigned URL made with the own key");
    await click("Xoá (1)");
    await waitFor(() => hasText("Xoá các mục đã chọn?"), "delete confirmation");
    await click("Xoá 1 object");
    await waitFor(() => hasText("Đã xoá 1 object."), "object deleted", 20000);
    await shot("-");

    // ---- the key can be deleted and typed in again
    await click("Xoá key");
    await waitFor(() => hasText("Xoá key của tôi?"), "delete-key confirmation");
    await click("Xoá key");
    await dialogsGone();
    await waitFor(() => hasText("Không có caps admin?") && !hasText("lưu trong keychain") && !button("Xoá key"), "key forgotten");
    await shot("06-key-deleted");
    await click("Duyệt bằng key của tôi");
    await type("Access key của tôi", PLAIN.ak);
    await type("Secret key của tôi", PLAIN.sk);
    await shot("07-key-dialog");
    await click("Lưu và duyệt");
    await dialogsGone();
    await waitFor(() => hasText("của bạn (lưu trong keychain)") && hasText(BUCKET), "session with the re-entered key", 20000);

    await click("Audit");
    await waitFor(() => hasText("as=own-key") && hasText("bucket.create"), "audit rows of the own-key session");
    check(!hasText(PLAIN.sk) && !hasText(PLAIN.ak), "audit shows neither half of the key");
    await shot("08-audit");

    // ---- users=read + usage=read: own info only, admin tabs visible but switched off
    await addCluster("self", SELF);
    await click("Lưu");
    await waitFor(() => hasText('Đã lưu "self"'), "second profile saved");
    await click("Browse");
    await useCluster("self");
    await waitFor(() => badge("Xem của mình"), "badge of the read-caps user", 20000);
    await waitFor(() => hasText("Thông tin của tôi · ba-m6-ui-self") && hasText("Đang hoạt động") && hasText("users=read"), "own info box", 20000);
    // This profile has no personal key: the other cluster's session must not show up under it.
    check(!hasText("lưu trong keychain") && hasText("Không có caps admin?"), "no own-key session without a saved key");
    const usersTab = tab("Users");
    check(usersTab.getAttribute("aria-disabled") === "true" && usersTab.title === "Cần caps: metadata=read", `Users tab is off with its reason, got "${usersTab.title}"`);
    check(tab("Buckets").title === "Cần caps: buckets=read", "Buckets tab is off with its reason");
    usersTab.click();
    await sleep(300);
    check(hasText("Thông tin của tôi") && !hasText("user đã tải"), "a switched-off tab does not open");
    await shot("09-self-info");

    // ---- read-only admin: the refusal names the cap and offers the command
    await addCluster("ro", RO);
    await click("Lưu");
    await waitFor(() => hasText('Đã lưu "ro"'), "third profile saved");
    await click("Browse");
    await useCluster("ro");
    await waitFor(() => badge("Thiếu caps"), "badge of the read-only admin", 20000);
    await click("Users");
    await waitFor(() => all(".MuiLinearProgress-root").length === 0 && hasText("user đã tải"), "user list", 20000);
    await click("Tạo user");
    await type("uid", "ba-m6-ui-new");
    await type("Display name", "must not be created");
    await click("Tạo user");
    const command = 'radosgw-admin caps add --uid=ba-m6-ui-ro --caps="users=write"';
    await waitFor(() => hasText("thiếu caps users=write") && hasText(command), "refusal with the caps command");
    (await waitFor(() => last(all('[aria-label="Copy lệnh cấp caps"]')), "copy button of the command")).focus();
    await shot("10-caps-command"); // the shell presses a real Enter here and reads the clipboard
    await shot("-");
    await click("Huỷ");
    await dialogsGone();

    await click("Clusters");
    for (const label of ["plain", "self", "ro"]) {
      await clickSel(`[aria-label="Xoá cluster ${label}"]`);
      await waitFor(() => !document.querySelector(`[aria-label="Xoá cluster ${label}"]`), `cluster ${label} removed`);
    }
    await waitFor(() => hasText("Chưa có cluster nào."), "all clusters removed");
    banner(`SMOKE DONE: ${n + 1} slots, late: [${late.join(", ")}]`, late.length ? "#fc6" : "#8f8");
    await shot("11-done");
