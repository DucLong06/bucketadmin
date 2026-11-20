import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { Profile } from "./api";
import Connections from "./Connections";
import { applyLang, t } from "./i18n";
import { splitPath, startPath } from "./paths";

const nothing = () => {};
const render = (profiles: Profile[]) => renderToString(createElement(Connections, { profiles, onChanged: nothing, scale: 100, onScale: nothing }));
const saved: Profile = { id: "c1", label: "lab", endpoint: "http://rgw.example:7480", access_key: "AKIAEXAMPLE000000001" };

test("the start path round-trips: typed, stored form, shown again in the saved connection's field, and read as the same place", () => {
  applyLang("en");
  // What the form sends to `add_profile` / `profile_set_start_path` for what a user types.
  const sent = startPath("  s3://team-bucket/project-a ");
  expect(sent).toEqual({ path: "team-bucket/project-a/" });
  if (sent.error) return;
  // The profile as `list_profiles` gives it back, on the Connections screen.
  const html = render([{ ...saved, start_path: sent.path }]);
  expect(html).toMatch(/<input[^>]*aria-label="Start path of lab"[^>]*value="team-bucket\/project-a\/"|<input[^>]*value="team-bucket\/project-a\/"[^>]*aria-label="Start path of lab"/);
  // And where Browse lands with it.
  expect(splitPath(sent.path)).toEqual({ bucket: "team-bucket", prefix: "project-a/" });
});

test("the form offers the start path with its help text; a connection without one shows an empty field", () => {
  applyLang("en");
  const html = render([saved]);
  expect(html).toContain("Start path (optional)");
  expect(html).toContain("Opened automatically on connect, e.g. team-bucket/project-a/");
  expect(html).toMatch(/<input[^>]*aria-label="Start path of lab"[^>]*value=""|<input[^>]*value=""[^>]*aria-label="Start path of lab"/);
  applyLang("vi");
  expect(render([saved])).toContain(t("conn.startPath"));
});
