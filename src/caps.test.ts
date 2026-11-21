import { expect, test } from "vitest";
import { accessLevel, capsCommand, hasCap, LEVEL_LABEL, missingCaps, missingForFull, TAB_CAPS, withNeededCaps, type Access } from "./caps";
import { applyLang, t } from "./i18n";

const none: Access = { uid: "me", caps: [], info: false, users: false, metadata: false, buckets: false, usage: false };
const full: Access = {
  uid: "admin",
  caps: ["users", "buckets", "usage"].map((type) => ({ type, perm: "*" })),
  info: true,
  users: true,
  metadata: true,
  buckets: true,
  usage: true,
};

test("level follows what RGW let through", () => {
  expect(accessLevel(none)).toBe("browse");
  // info=read alone opens no screen.
  expect(accessLevel({ ...none, info: true })).toBe("browse");
  expect(accessLevel({ ...none, users: true })).toBe("self");
  expect(accessLevel({ ...none, usage: true })).toBe("self");
  expect(accessLevel(full)).toBe("admin");
  // The Buckets tab works but nothing else does.
  expect(accessLevel({ ...none, buckets: true })).toBe("partial");
  // Reads everything, may change nothing.
  expect(accessLevel({ ...full, caps: [] })).toBe("partial");
});

test("a level is named in the current language", () => {
  applyLang("vi");
  expect(t(LEVEL_LABEL[accessLevel(none)])).toBe("Chỉ xem");
  expect(t(LEVEL_LABEL[accessLevel(full)])).toBe("Admin đầy đủ");
  applyLang("en");
  expect(t(LEVEL_LABEL[accessLevel(none)])).toBe("Browse only");
  expect(t(LEVEL_LABEL[accessLevel(full)])).toBe("Full admin");
});

test("write caps come from the caps listed on the user", () => {
  expect(hasCap(full, "users=write")).toBe(true);
  expect(hasCap({ ...full, caps: [{ type: "users", perm: "read" }] }, "users=write")).toBe(false);
  expect(hasCap({ ...full, caps: [{ type: "users", perm: "write" }] }, "users=write")).toBe(true);
  expect(hasCap(full, "no-such-type=read")).toBe(false);
});

test("missing caps for a tab and for the whole app", () => {
  expect(missingCaps(none, TAB_CAPS.users)).toEqual(["users=read", "metadata=read"]);
  expect(missingCaps({ ...none, users: true }, TAB_CAPS.users)).toEqual(["metadata=read"]);
  expect(missingCaps(full, TAB_CAPS.buckets)).toEqual([]);
  expect(missingForFull(full)).toEqual([]);
  expect(missingForFull({ ...full, caps: [{ type: "users", perm: "*" }] })).toEqual(["buckets=write", "usage=write"]);
});

test("sample command", () => {
  expect(capsCommand("longhd", ["users=read", "metadata=read"])).toBe(
    'radosgw-admin caps add --uid=longhd --caps="users=read;metadata=read"',
  );
  expect(capsCommand("", ["usage=read"])).toBe('radosgw-admin caps add --uid=<uid> --caps="usage=read"');
});

test("an Admin API refusal is tagged with the caps its command needs", () => {
  const denied = "AccessDenied (403): the admin user lacks the caps for this operation";
  expect(withNeededCaps("user_create", denied)).toBe(`${denied} [needs users=write]`);
  expect(withNeededCaps("users_list", denied)).toBe(`${denied} [needs metadata=read;users=read]`);
  // Browsing as another user: the admin key looks that user's key up.
  expect(withNeededCaps("browse_open", denied)).toBe(`${denied} [needs users=read]`);
  // Not about caps: S3 refusals, other errors, commands that never reach the Admin API.
  const s3 = "S3 AccessDenied (403): ";
  expect(withNeededCaps("browse_list", s3)).toBe(s3);
  expect(withNeededCaps("user_create", "UserAlreadyExists (409): user already exists")).toBe("UserAlreadyExists (409): user already exists");
  expect(withNeededCaps("audit_recent", denied)).toBe(denied);
});
