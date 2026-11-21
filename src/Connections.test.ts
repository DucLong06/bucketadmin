import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { Profile } from "./api";
import Connections, { connected, outcomeAlert, saveBlocker, type ConnectionForm } from "./Connections";
import { applyLang, t } from "./i18n";
import { splitPath, startPath } from "./paths";
import { ClusterSelect, duplicateLabels, filterProfiles, SEARCH_ABOVE } from "./ui";

const nothing = () => {};
const render = (profiles: Profile[]) => renderToString(createElement(Connections, { profiles, onChanged: nothing, scale: 100, onScale: nothing, onBrowse: nothing }));
const saved: Profile = { id: "c1", label: "lab", endpoint: "http://rgw.example:7480", access_key: "AKIAEXAMPLE000000001" };

test("the start path round-trips: typed, stored form, shown again on the saved connection's row, and read as the same place", () => {
  applyLang("en");
  // What the form sends to `add_profile` / `profile_set_start_path` for what a user types.
  const sent = startPath("  s3://team-bucket/project-a ");
  expect(sent).toEqual({ path: "team-bucket/project-a/" });
  if (sent.error) return;
  // The profile as `list_profiles` gives it back, on the Connections screen.
  const html = render([{ ...saved, start_path: sent.path }]);
  expect(text(html)).toMatch(/starts at\s+team-bucket\/project-a\//);
  // And where Browse lands with it.
  expect(splitPath(sent.path)).toEqual({ bucket: "team-bucket", prefix: "project-a/" });
});

// ---- M12.4: the form for a first-time user

const blank: ConnectionForm = { label: "", endpoint: "https://", accessKey: "", secretKey: "", startPath: "", adminAccessKey: "", adminSecretKey: "" };
const saveButton = (html: string) => /<span title="([^"]*)">(?:<style[^>]*>.*?<\/style>)?<button[^>]*type="submit"[^>]*>/s.exec(html);

test("Save stays disabled until the four required fields are filled, and its tooltip names the first one missing", () => {
  applyLang("en");
  expect(saveBlocker(blank)).toBe("Still to fill in: Display name");
  // The prefilled scheme is not an endpoint yet.
  expect(saveBlocker({ ...blank, label: "lab" })).toBe("Still to fill in: Endpoint");
  expect(saveBlocker({ ...blank, label: "lab", endpoint: "https://s3.example.com" })).toBe("Still to fill in: My access key");
  expect(saveBlocker({ ...blank, label: "lab", endpoint: "https://s3.example.com", accessKey: "AK" })).toBe("Still to fill in: My secret key");
  // Spaces are nothing: keys are trimmed before they are used.
  expect(saveBlocker({ ...blank, label: "lab", endpoint: "https://s3.example.com", accessKey: "AK", secretKey: "  " })).toBe("Still to fill in: My secret key");
  const filled = { ...blank, label: "lab", endpoint: "https://s3.example.com", accessKey: " AK ", secretKey: "SK" };
  expect(saveBlocker(filled)).toBeNull();
  // Filled, but wrong: the endpoint is not a URL, half an admin key, a start path that cannot be one.
  expect(saveBlocker({ ...filled, endpoint: "s3.example.com" })).toBe(t("endpoint.url"));
  expect(saveBlocker({ ...filled, adminAccessKey: "ADMIN" })).toBe(t("conn.adminHalf"));
  expect(saveBlocker({ ...filled, startPath: "my bucket/x" })).toBe(t("paths.bucketSpace"));
  // On screen: the empty form's Save button is disabled, inside a wrapper that says why.
  const html = render([saved]);
  expect(saveButton(html)?.[1]).toBe("Still to fill in: Display name");
  expect(saveButton(html)?.[0]).toContain("disabled");
  expect(html).toMatch(/<input[^>]*value="https:\/\/"/);
  applyLang("vi");
  expect(saveButton(render([saved]))?.[1]).toBe("Còn thiếu: Tên hiển thị");
});

test("Required is always open; Advanced (start path, admin key, proxy) is collapsed by default and stays as it was left", () => {
  applyLang("en");
  const html = render([saved]);
  for (const label of ["Display name", "Endpoint", "My access key", "My secret key"]) expect(html).toContain(`${label}`);
  expect(text(html)).toContain("Required");
  expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="conn-advanced"/);
  expect(html).not.toContain("Start path (optional)");
  expect(html).not.toContain("Admin access key");
  // Opened once in this run of the app: open the next time the screen is shown.
  const kept: Record<string, string> = { "ba.conn.advanced": "1" };
  Object.assign(globalThis, { sessionStorage: { getItem: (key: string) => kept[key] ?? null, setItem: (key: string, value: string) => (kept[key] = value) } });
  try {
    const open = render([saved]);
    expect(open).toMatch(/<button[^>]*aria-expanded="true"[^>]*aria-controls="conn-advanced"/);
    expect(open).toContain("Start path (optional)");
    expect(open).toContain("Opened automatically on connect, e.g. team-bucket/project-a/");
    expect(open).toContain("Admin access key");
    applyLang("vi");
    expect(render([saved])).toContain(t("conn.startPath"));
  } finally {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("the test's answer renders inline: green when connected, amber for a key that may not list buckets, red with S3's code", () => {
  applyLang("en");
  const shown = (outcome: Parameters<typeof outcomeAlert>[0]) => renderToString(outcomeAlert(outcome));
  const ok = shown(connected({ buckets: [{ name: "a", created: "" }], buckets_error: null }));
  expect(ok).toMatch(/MuiAlert-[a-zA-Z]*[sS]uccess/);
  expect(text(ok)).toContain("Connected: the key is valid and its user owns 1 bucket.");
  const scoped = shown(connected({ buckets: [], buckets_error: "AccessDenied" }));
  expect(scoped).toMatch(/MuiAlert-[a-zA-Z]*[wW]arning/);
  expect(text(scoped)).toContain("it may not list buckets. Give the connection a start path");
  const refused = shown({ severity: "error", text: "S3 InvalidAccessKeyId (403): The access key does not exist" });
  expect(refused).toMatch(/MuiAlert-[a-zA-Z]*[eE]rror/);
  expect(text(refused)).toContain("InvalidAccessKeyId");
  // The Test button is part of the form, next to Save; nothing here is a toast.
  const form = /<form.*?<\/form>/s.exec(render([saved]))?.[0] ?? "";
  expect(form).toContain("Test connection");
  expect(render([saved])).not.toContain("MuiSnackbar");
});

test("first run: a centred card with one button and what is needed; a saved row has the masked key, the host, Open, Edit and a menu", () => {
  applyLang("vi");
  const empty = render([]);
  expect(text(empty)).toContain("Chưa có kết nối");
  expect(text(empty)).toContain("endpoint S3 của cluster và một cặp key");
  expect(empty.match(/MuiButton-contained[^>]*>Thêm kết nối</g)).toHaveLength(1);
  expect(empty).not.toContain("<form");
  expect(empty).not.toContain(t("conn.savedList"));
  const row = render([{ ...saved, access_key: "BAM7UISMOKEKEY000001" }]);
  expect(text(row)).toContain("rgw.example:7480");
  expect(row).toContain('title="http://rgw.example:7480"');
  expect(text(row)).toContain("BAM7…0001");
  expect(row).toMatch(/MuiButton-contained[^>]*aria-label="Mở bucket của lab"/);
  expect(row).toContain('aria-label="Sửa kết nối lab"');
  expect(row).toMatch(/aria-label="Thao tác khác với lab"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*aria-label="Thao tác khác với lab"/);
  // Delete and Test are in the menu, the per-connection settings behind Edit.
  expect(row).not.toContain(t("conn.remove", { label: "lab" }));
  expect(row).not.toContain(t("conn.saveProxy"));
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
  expect(twenty.match(/aria-label="More actions for site-\d\d"/g)).toHaveLength(20);
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
