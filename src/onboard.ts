// CSV onboarding: parsing the file and writing the report. The backend re-validates every row.
import { parseDelimited } from "./preview/parse";
import { csvCell } from "./usage";

/** What the backend takes for one user (src-tauri/src/ops.rs, `OnboardRow`). */
export type OnboardRow = { uid: string; display_name: string; email: string; caps: string[]; quota_kb: number | null };
/** One data line of the file: either a row to send or the reason it cannot be sent. */
export type ParsedLine = { line: number; row: OnboardRow; error: string | null };
export type OnboardResult = {
  uid: string;
  status: "would_create" | "exists" | "created" | "error";
  message: string;
  access_key: string;
  secret_key: string;
};

export const ONBOARD_HEADER = "uid,display,email,caps,quota";
export const ONBOARD_EXAMPLE = `${ONBOARD_HEADER}
an.nguyen,Nguyen Van An,an@example.com,buckets=read;usage=read,10G
binh.tran,Tran Thi Binh,,,
`;

const UNIT_KIB: Record<string, number> = { K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 };

/** "10G" -> KiB (binary units K, M, G, T). Empty -> null (no quota). Anything else -> an error text. */
export function parseQuota(text: string): number | null | string {
  const value = text.trim().toUpperCase();
  if (!value) return null;
  const match = /^(\d+)([KMGT])B?$/.exec(value);
  if (!match || Number(match[1]) === 0) return `quota "${text.trim()}" không hợp lệ: viết số kèm đơn vị K, M, G hoặc T (ví dụ 10G)`;
  return Number(match[1]) * UNIT_KIB[match[2]];
}

const CAP = /^[a-z0-9-]+=(read|write|\*|read,write|write,read)$/;

/** Parses an onboarding CSV. `problem` is set when the file as a whole cannot be used. */
export function parseOnboardCsv(text: string): { lines: ParsedLine[]; problem: string | null } {
  const table = parseDelimited(text, ",", true).filter((cells) => cells.some((c) => c.trim() !== ""));
  if (table.length === 0) return { lines: [], problem: "File trống." };
  const header = table[0].map((c) => c.trim().toLowerCase()).join(",");
  if (header !== ONBOARD_HEADER) {
    return { lines: [], problem: `Dòng đầu phải là "${ONBOARD_HEADER}" (đang là "${table[0].join(",")}").` };
  }
  const seen = new Set<string>();
  const lines = table.slice(1).map((cells, i) => {
    const [uid = "", display = "", email = "", caps = "", quota = ""] = cells.map((c) => c.trim());
    const capList = caps
      .split(";")
      .map((c) => c.replace(/\s+/g, ""))
      .filter(Boolean);
    const quotaKb = parseQuota(quota);
    let error: string | null = null;
    if (cells.length > 5) error = "thừa cột (ô có dấu phẩy phải đặt trong dấu ngoặc kép)";
    else if (!uid || /\s/.test(uid)) error = "uid bắt buộc và không chứa dấu cách";
    else if (seen.has(uid)) error = "uid bị lặp lại trong file";
    else if (!display) error = "thiếu display name";
    else if (capList.some((c) => !CAP.test(c))) error = `cap "${capList.find((c) => !CAP.test(c))}" sai cú pháp (type=perm, cách nhau bằng dấu ;)`;
    else if (typeof quotaKb === "string") error = quotaKb;
    seen.add(uid);
    const row = { uid, display_name: display, email, caps: capList, quota_kb: typeof quotaKb === "number" ? quotaKb : null };
    return { line: i + 2, row, error };
  });
  return { lines, problem: lines.length === 0 ? "File không có dòng user nào." : null };
}

/** The report: one line per data line of the input, with what happened to it. */
export function onboardReport(lines: ParsedLine[], results: OnboardResult[], withKeys: boolean): string {
  const byUid = new Map(results.map((r) => [r.uid, r]));
  const header = ["line", "uid", "status", "message", ...(withKeys ? ["access_key", "secret_key"] : [])];
  const body = lines.map((l) => {
    const result = l.error ? undefined : byUid.get(l.row.uid);
    const cells = [l.line, l.row.uid, l.error ? "invalid" : (result?.status ?? "not_run"), l.error ?? result?.message ?? ""];
    if (withKeys) cells.push(result?.access_key ?? "", result?.secret_key ?? "");
    return cells.map(csvCell).join(",");
  });
  return [header.join(","), ...body].join("\r\n") + "\r\n";
}
