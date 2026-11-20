import { beforeEach, expect, test } from "vitest";
import { aclWarnings, fixedRows, presetGrants, PRESETS, toggleGrant, type Grant } from "./AclEditor";
import { applyLang, t } from "./i18n";

beforeEach(() => applyLang("vi"));

const grant = (kind: Grant["kind"], grantee: string, permission: string): Grant => ({ kind, grantee, display_name: "", permission });

test("ACL warnings: public access, owner losing control, unfinished rows", () => {
  expect(aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL")])).toEqual([]);
  const open = aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL"), grant("group", "AllUsers", "READ")]);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatch(/Đang cấp READ cho "Mọi người \(public\)"/);
  expect(open[0]).not.toMatch(/kể cả ghi/);
  const writable = aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL"), grant("group", "AllUsers", "WRITE")]);
  expect(writable[0]).toMatch(/kể cả ghi, xoá hoặc đổi ACL/);
  expect(aclWarnings("alice", [grant("user", "alice", "READ")])[0]).toMatch(/Owner alice không còn FULL_CONTROL/);
  expect(aclWarnings("alice", [grant("group", "AuthenticatedUsers", "READ")])).toHaveLength(1);
  const unfinished = aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL"), grant("user", " ", "READ")]);
  expect(unfinished).toEqual(["Có grant chưa điền uid."]);
  applyLang("en");
  expect(aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL"), grant("group", "AllUsers", "WRITE")])[0]).toMatch(
    /^Granting WRITE to "Everyone \(public\)": .* — including writing, deleting or changing the ACL\.$/,
  );
  expect(aclWarnings("alice", [grant("user", "alice", "READ"), grant("user", "", "READ")])).toEqual([
    "Owner alice no longer has FULL_CONTROL in the list.",
    "A grant has no uid yet.",
  ]);
});

test("a box of the quick-share table adds the grant, a second click removes every copy of it", () => {
  const owner = grant("user", "alice", "FULL_CONTROL");
  const ticked = toggleGrant([owner], "group", "AllUsers", "READ");
  expect(ticked).toEqual([owner, grant("group", "AllUsers", "READ")]);
  expect(toggleGrant([...ticked, grant("group", "AllUsers", "READ")], "group", "AllUsers", "READ")).toEqual([owner]);
  // Other permissions of the same grantee and other grantees are left alone.
  const mixed = [owner, grant("group", "AllUsers", "READ_ACP"), grant("user", "bob", "READ")];
  expect(toggleGrant(mixed, "group", "AllUsers", "READ").slice(0, 3)).toEqual(mixed);
});

test("presets are the canned ACLs: the owner keeps FULL_CONTROL, other grants are dropped", () => {
  const owner = grant("user", "alice", "FULL_CONTROL");
  expect(presetGrants("alice", "private")).toEqual([owner]);
  expect(presetGrants("alice", "public-read")).toEqual([owner, grant("group", "AllUsers", "READ")]);
  expect(presetGrants("alice", "authenticated-read")).toEqual([owner, grant("group", "AuthenticatedUsers", "READ")]);
  expect(fixedRows("alice").map((r) => r.grantee)).toEqual(["alice", "AuthenticatedUsers", "AllUsers"]);
  // Rows and presets are named in the current language.
  expect(fixedRows("alice").map((r) => r.label)).toEqual(["Chủ sở hữu", "Mọi user đã xác thực (auth)", "Mọi người (public)"]);
  expect(PRESETS.map((p) => t(p.label))[1]).toBe("Công khai đọc (public-read)");
  applyLang("en");
  expect(fixedRows("alice").map((r) => r.label)).toEqual(["Owner", "All authenticated users (auth)", "Everyone (public)"]);
  expect(PRESETS.map((p) => t(p.label))).toEqual(["Private", "Public read (public-read)", "Authenticated read (authenticated-read)"]);
});
