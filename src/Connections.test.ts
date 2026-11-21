import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { Profile } from "./api";
import Connections from "./Connections";
import { applyLang, t } from "./i18n";
import { splitPath, startPath } from "./paths";
import { ClusterSelect, duplicateLabels, filterProfiles, SEARCH_ABOVE } from "./ui";

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

const fake = (n: number, label = `site-${String(n).padStart(2, "0")}`): Profile => ({ id: `f${n}`, label, endpoint: `http://s3-${n}.example.invalid:7480`, access_key: `AKIAEXAMPLE0000000${String(n).padStart(2, "0")}` });
const text = (html: string) => html.replace(/<style[^>]*>.*?<\/style>/gs, " ").replace(/<[^>]*>/g, " ");

test("many connections: a count badge always, a search field above 8, and every row still listed", () => {
  applyLang("en");
  const eight = render(Array.from({ length: 8 }, (_, i) => fake(i + 1)));
  expect(eight).toContain('aria-label="Saved connections: 8"');
  expect(eight).not.toContain("Search connections…");
  const twenty = render(Array.from({ length: 20 }, (_, i) => fake(i + 1)));
  expect(twenty).toContain('aria-label="Saved connections: 20"');
  expect(twenty).toContain('placeholder="Search connections…"');
  expect(twenty.match(/aria-label="Delete connection site-\d\d"/g)).toHaveLength(20);
  expect(render([])).not.toContain("Saved connections:");
  applyLang("vi");
  expect(render(Array.from({ length: 9 }, (_, i) => fake(i + 1)))).toContain(`placeholder="${t("conn.search")}"`);
});

test("the search matches label, endpoint and access key, whatever the case", () => {
  const all = [fake(1, "Lab"), fake(2, "prod-hn"), fake(3, "prod-hcm"), fake(12, "archive")];
  const labels = (search: string) => filterProfiles(all, search).map((p) => p.label);
  expect(labels("PROD")).toEqual(["prod-hn", "prod-hcm"]);
  expect(labels("s3-12.example")).toEqual(["archive"]);
  expect(labels(" akiaexample000000002 ")).toEqual(["prod-hn"]);
  expect(labels("nothing-like-it")).toEqual([]);
  expect(filterProfiles(all, "  ")).toBe(all);
});

test("a label that two connections share is flagged on both rows, and only there", () => {
  applyLang("en");
  const profiles = [fake(1, "lab"), fake(2, "prod"), fake(3, " LAB ")];
  expect([...duplicateLabels(profiles)]).toEqual(["lab"]);
  expect(duplicateLabels([fake(1), fake(2)]).size).toBe(0);
  const html = render(profiles);
  expect(text(html).split("Another connection has this label. Tell them apart by their endpoint.")).toHaveLength(3);
  expect(text(render([fake(1, "lab"), fake(2, "prod")]))).not.toContain("Another connection has this label");
});

const picker = (count: number) => renderToString(createElement(ClusterSelect, { profiles: Array.from({ length: count }, (_, i) => fake(i + 1)), value: "f2", onChange: nothing }));

test("the connection of a tab is a plain select up to 8 connections and a searchable box above", () => {
  applyLang("en");
  expect(SEARCH_ABOVE).toBe(8);
  expect(picker(8)).toMatch(/<select[^>]*>/);
  expect(picker(8)).not.toContain('role="combobox"');
  const many = picker(9);
  expect(many).not.toMatch(/<select/);
  expect(many).toMatch(/<input[^>]*role="combobox"[^>]*value="site-02"|<input[^>]*value="site-02"[^>]*role="combobox"/);
  expect(many).toContain('placeholder="Search connections…"');
});
