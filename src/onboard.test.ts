import { expect, test } from "vitest";
import { ONBOARD_EXAMPLE, onboardReport, parseOnboardCsv, parseQuota, type OnboardResult } from "./onboard";

test("quota sizes use binary units and need a unit", () => {
  expect(parseQuota("")).toBeNull();
  expect(parseQuota(" 512k ")).toBe(512);
  expect(parseQuota("500M")).toBe(500 * 1024);
  expect(parseQuota("10G")).toBe(10 * 1024 * 1024);
  expect(parseQuota("10GB")).toBe(10 * 1024 * 1024);
  expect(parseQuota("2T")).toBe(2 * 1024 ** 3);
  for (const bad of ["10", "0G", "1.5G", "-1G", "ten"]) expect(typeof parseQuota(bad), bad).toBe("string");
});

test("the example file parses into rows the backend takes", () => {
  const { lines, problem } = parseOnboardCsv(ONBOARD_EXAMPLE);
  expect(problem).toBeNull();
  expect(lines.map((l) => l.error)).toEqual([null, null]);
  expect(lines[0]).toEqual({
    line: 2,
    error: null,
    row: { uid: "an.nguyen", display_name: "Nguyen Van An", email: "an@example.com", caps: ["buckets=read", "usage=read"], quota_kb: 10 * 1024 * 1024 },
  });
  expect(lines[1].row).toEqual({ uid: "binh.tran", display_name: "Tran Thi Binh", email: "", caps: [], quota_kb: null });
});

test("bad lines are reported one by one, good ones stay usable", () => {
  const csv = [
    "UID, Display ,email,caps,quota",
    'ok1,"Nguyen, An",,"usage=read, write; buckets=*",1G',
    ",No Uid,,,",
    "has space,Name,,,",
    "ok1,Again,,,",
    "nodisplay,,,,",
    "badcap,Name,,usage:read,",
    "badquota,Name,,,10",
    "extra,Name,,,,surplus",
    "",
  ].join("\n");
  const { lines, problem } = parseOnboardCsv(csv);
  expect(problem).toBeNull();
  expect(lines[0].error).toBeNull();
  expect(lines[0].row).toMatchObject({ display_name: "Nguyen, An", caps: ["usage=read,write", "buckets=*"], quota_kb: 1024 * 1024 });
  expect(lines.slice(1).map((l) => [l.line, l.error?.slice(0, 12)])).toEqual([
    [3, "uid bắt buộc"],
    [4, "uid bắt buộc"],
    [5, "uid bị lặp l"],
    [6, "thiếu displa"],
    [7, 'cap "usage:r'],
    [8, 'quota "10" k'],
    [9, "thừa cột (ô "],
  ]);
});

test("a wrong header or an empty file is refused as a whole", () => {
  expect(parseOnboardCsv("").problem).toBe("File trống.");
  expect(parseOnboardCsv("uid,name\na,b").problem).toMatch(/^Dòng đầu phải là/);
  expect(parseOnboardCsv("uid,display,email,caps,quota\n").problem).toMatch(/không có dòng user/);
});

test("the report has one line per input line, with keys only when asked", () => {
  const { lines } = parseOnboardCsv("uid,display,email,caps,quota\nnew,New User,,,\nold,Old User,,,\n,broken,,,\n");
  const results: OnboardResult[] = [
    { uid: "new", status: "created", message: "", access_key: "AKNEW", secret_key: "s3cr3t+/=" },
    { uid: "old", status: "exists", message: "user already exists; left unchanged", access_key: "", secret_key: "" },
  ];
  expect(onboardReport(lines, results, true).split("\r\n")).toEqual([
    "line,uid,status,message,access_key,secret_key",
    "2,new,created,,AKNEW,s3cr3t+/=",
    "3,old,exists,user already exists; left unchanged,,",
    "4,,invalid,uid bắt buộc và không chứa dấu cách,,",
    "",
  ]);
  const withoutKeys = onboardReport(lines, results, false);
  expect(withoutKeys).not.toContain("s3cr3t");
  expect(withoutKeys.split("\r\n")[0]).toBe("line,uid,status,message");
  expect(onboardReport(lines, [], false)).toContain("2,new,not_run,");
});
