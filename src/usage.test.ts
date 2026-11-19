import { expect, test } from "vitest";
import type { Usage } from "./api";
import { dayStartUtc, daysAgo, exportName, usageCsv, usageRecords, usageRows, usageTotals } from "./usage";

const stats = (category: string, ops: number, sent: number, received: number) => ({
  category,
  ops,
  successful_ops: ops,
  bytes_sent: sent,
  bytes_received: received,
});

// Shape of `radosgw-admin usage show` / GET /admin/usage.
const usage: Usage = {
  entries: [
    {
      user: "alice",
      buckets: [
        { bucket: "photos", time: "2026-11-18T13:00:00.000000Z", categories: [stats("put_obj", 2, 0, 16), stats("get_obj", 1, 5, 0)] },
        { bucket: "photos", time: "2026-11-18T14:00:00.000000Z", categories: [stats("list_bucket", 3, 900, 0)] },
      ],
    },
  ],
  summary: [],
};

test("rows, totals and record count", () => {
  const rows = usageRows(usage);
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({ bucket: "photos", category: "get_obj", ops: 1, bytes_sent: 5 });
  expect(usageTotals(rows)).toEqual({ ops: 6, successful_ops: 6, bytes_sent: 905, bytes_received: 16 });
  expect(usageRecords(usage)).toBe(2);
  expect(usageRows({ entries: [], summary: [] })).toEqual([]);
});

test("CSV: header, CRLF, quoting and formula guard", () => {
  const csv = usageCsv(usageRows(usage));
  const lines = csv.split("\r\n");
  expect(lines[0]).toBe("bucket,time_utc,category,ops,successful_ops,bytes_sent,bytes_received");
  expect(lines[1]).toBe("photos,2026-11-18T13:00:00.000000Z,put_obj,2,2,0,16");
  expect(lines).toHaveLength(5); // header + 3 rows + trailing empty line
  const tricky = usageCsv([{ bucket: '=cmd|"x",1', time: "t", category: "-", ops: -1, successful_ops: 0, bytes_sent: 0, bytes_received: 0 }]);
  expect(tricky.split("\r\n")[1]).toBe(`"'=cmd|""x"",1",t,'-,-1,0,0,0`);
});

test("date helpers work in days of Vietnam (UTC+7)", () => {
  // 23:30 UTC on the 18th is already 06:30 on the 19th in Vietnam.
  const now = new Date("2026-11-18T23:30:00Z");
  expect(daysAgo(0, now)).toBe("2026-11-19");
  expect(daysAgo(30, now)).toBe("2026-10-20");
  expect(daysAgo(0, new Date("2026-11-18T16:59:59Z"))).toBe("2026-11-18");
  // A day in Vietnam starts at 17:00 UTC of the day before; `end` is the start of the day after.
  expect(dayStartUtc("2026-11-18")).toBe("2026-11-17 17:00:00");
  expect(dayStartUtc("2026-11-18", 1)).toBe("2026-11-18 17:00:00");
  expect(dayStartUtc("2027-01-01")).toBe("2026-12-31 17:00:00");
  expect(dayStartUtc("2028-02-28", 1)).toBe("2028-02-28 17:00:00");
});

test("export file names only use characters the backend accepts", () => {
  expect(exportName("alice", "2026-11-01", "2026-11-18")).toBe("usage-alice-2026-11-01_2026-11-18.csv");
  expect(exportName("acme$bob/../x", "a", "b")).toBe("usage-acme_bob_.._x-a_b.csv");
});
