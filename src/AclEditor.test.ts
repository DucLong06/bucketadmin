import { expect, test } from "vitest";
import { aclWarnings, fixedRows, presetGrants, toggleGrant, type Grant } from "./AclEditor";

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
});
