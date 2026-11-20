import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test } from "vitest";
import BucketPanel from "./BucketPanel";
import { applyLang, t } from "./i18n";

const nothing = () => {};
const panel = (props: Partial<Parameters<typeof BucketPanel>[0]>) =>
  renderToString(createElement(BucketPanel, { title: "Your buckets", buckets: [], bucketsError: null, current: "", active: true, onOpen: nothing, onCreate: nothing, ...props }));
// Text as a user reads it: tags dropped, entities of the apostrophes and quotes put back.
const text = (html: string) => html.replace(/<style[^>]*>.*?<\/style>/gs, " ").replace(/<[^>]*>/g, " ").replaceAll("&quot;", '"').replaceAll("&#x27;", "'");

beforeEach(() => applyLang("en"));

test("a key that may not list buckets gets a notice instead of the empty-list text, in both languages", () => {
  const denied = text(panel({ bucketsError: "AccessDenied" }));
  expect(denied).toContain("This key may not list buckets — open a path directly below or use a pinned place");
  expect(denied).not.toContain(t("browse.noBuckets"));
  expect(denied).toContain(t("browse.openPath"));
  expect(denied).toContain("Bucket or bucket/folder/ — use this when you may only list one folder");
  // Not an error: the notice is an info alert.
  expect(panel({ bucketsError: "AccessDenied" })).toMatch(/MuiAlert-[a-zA-Z]*[iI]nfo/);
  expect(panel({ bucketsError: "AccessDenied" })).not.toMatch(/MuiAlert-[a-zA-Z]*[eE]rror/);
  applyLang("vi");
  expect(text(panel({ bucketsError: "AccessDenied" }))).toContain(t("browse.bucketsDenied"));
  expect(t("browse.bucketsDenied")).toMatch(/^Key này không được liệt kê bucket/);
});

test("a key that lists nothing keeps the empty-list text, and one with buckets shows them", () => {
  const empty = text(panel({}));
  expect(empty).toContain(t("browse.noBuckets"));
  expect(empty).not.toContain(t("browse.bucketsDenied"));
  const some = text(panel({ buckets: [{ name: "logs", created: "" }, { name: "team-bucket", created: "" }] }));
  expect(some).toContain("logs");
  expect(some).toContain("team-bucket");
  expect(some).not.toContain(t("browse.noBuckets"));
});
