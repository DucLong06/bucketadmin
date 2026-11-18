import { expect, test } from "vitest";
import { aclWarnings, type Grant } from "./AclEditor";

const grant = (kind: Grant["kind"], grantee: string, permission: string): Grant => ({ kind, grantee, display_name: "", permission });

test("ACL warnings: public access, owner losing control, unfinished rows", () => {
  expect(aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL")])).toEqual([]);
  const open = aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL"), grant("group", "AllUsers", "READ")]);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatch(/AllUsers/);
  expect(aclWarnings("alice", [grant("user", "alice", "READ")])[0]).toMatch(/Owner alice không còn FULL_CONTROL/);
  expect(aclWarnings("alice", [grant("group", "AuthenticatedUsers", "READ")])).toHaveLength(1);
  const unfinished = aclWarnings("alice", [grant("user", "alice", "FULL_CONTROL"), grant("user", " ", "READ")]);
  expect(unfinished).toEqual(["Có grant chưa điền uid."]);
});
