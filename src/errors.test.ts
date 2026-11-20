import { beforeEach, expect, test } from "vitest";
import { explain } from "./errors";
import { applyLang } from "./i18n";

// Vietnamese unless a test says otherwise.
beforeEach(() => applyLang("vi"));

// The inputs are the exact strings the Rust side produces (RgwError's Display).
test("named RGW errors get a Vietnamese message and keep code + original", () => {
  const e = explain("NoSuchUser (404): user does not exist");
  expect(e.message).toBe("User không tồn tại (có thể đã bị xoá).");
  expect(e.code).toBe("NoSuchUser");
  expect(e.detail).toBe("NoSuchUser (404): user does not exist");
  expect(explain("AccessDenied (403): the admin user lacks the caps for this operation").message).toMatch(/caps/);
  expect(explain("UserAlreadyExists (409): user already exists").code).toBe("UserAlreadyExists");
  expect(explain("NoSuchBucket (404): bucket does not exist").message).toMatch(/^Bucket không tồn tại/);
  expect(explain("NoSuchKey (404): no such access key").message).toMatch(/^Key không tồn tại/);
});

test("errors that only arrive as 'RGW returned HTTP ...' are mapped by their code", () => {
  expect(explain("RGW returned HTTP 409 BucketAlreadyExists ").code).toBe("BucketAlreadyExists");
  expect(explain("RGW returned HTTP 409 BucketAlreadyExists ").message).toMatch(/user vẫn còn bucket/);
  expect(explain("RGW returned HTTP 400 InvalidArgument ").message).toMatch(/^Tham số không hợp lệ/);
  expect(explain("RGW returned HTTP 403 QuotaExceeded ").message).toBe("Vượt quá quota.");
  expect(explain("RGW returned HTTP 400 InvalidAccessKey ").message).toBe("Access key không hợp lệ.");
  expect(explain("RGW returned HTTP 409 BucketNotEmpty ").message).toMatch(/còn object/);
});

test("404 without a known code, unknown codes and bare statuses", () => {
  const notFound = explain("RGW returned HTTP 404  <html>404 Not Found</html>");
  expect(notFound.message).toMatch(/^Không tìm thấy \(HTTP 404\)/);
  expect(notFound.code).toBe("404");
  const unknown = explain("RGW returned HTTP 503 SlowDown please retry");
  expect(unknown.message).toBe("RGW báo lỗi HTTP 503 (SlowDown).");
  expect(unknown.code).toBe("SlowDown");
  expect(explain("RGW returned HTTP 500  <html>Internal Server Error</html>").message).toBe("RGW báo lỗi HTTP 500.");
});

test("network failures: timeout is told apart from connection errors", () => {
  const refused = explain(
    "cannot reach RGW: error sending request for url (http://127.0.0.1:1/admin/info?format=json): client error (Connect): tcp connect error: Connection refused (os error 111)",
  );
  expect(refused.code).toBe("network");
  expect(refused.message).toMatch(/^Không kết nối được/);
  const slow = explain("cannot reach RGW: error sending request for url (http://h/admin/info): operation timed out");
  expect(slow.code).toBe("timeout");
  expect(slow.message).toMatch(/^Hết thời gian chờ/);
});

test("the app's own backend phrases are known by how they begin; anything else gets a plain sentence, never the backend's English", () => {
  const locked = explain("keychain: cannot read secret key: locked");
  expect(locked).toEqual({ message: locked.message, code: "keychain", detail: "keychain: cannot read secret key: locked" });
  expect(locked.message).toMatch(/^Không dùng được keychain/);
  expect(explain("cannot read this file as Parquet: Invalid Parquet file. Corrupt footer").message).toBe("Không đọc được file này như Parquet.");
  expect(explain("cannot read /home/u/a.bin: Permission denied (os error 13)").message).toBe("Không đọc được file trên máy.");
  expect(explain("cannot write /home/u/a.bin.part: No space left on device (os error 28)").message).toBe("Không ghi được file trên máy.");
  expect(explain('invalid bucket name "Bad_Name": only lowercase letters').message).toBe("Tên bucket không hợp lệ.");
  expect(explain('folder "reports/" already exists').message).toBe("Thư mục này đã tồn tại.");
  expect(explain("a version id is required to restore").code).toBe("required");
  expect(explain("no cluster profile with id 0123abcd").message).toBe("Kết nối này không còn tồn tại.");
  const odd = explain("something nobody has seen before: os error 5");
  expect(odd).toEqual({ message: "Thao tác không thành công.", code: null, detail: "something nobody has seen before: os error 5" });
});

test("the same errors in English: every sentence follows the language, the detail never changes", () => {
  applyLang("en");
  const gone = explain("NoSuchUser (404): user does not exist");
  expect(gone).toEqual({ message: "The user does not exist (it may have been deleted).", code: "NoSuchUser", detail: "NoSuchUser (404): user does not exist" });
  expect(explain("S3 AccessDenied (403): ").message).toMatch(/^This user's key is not allowed/);
  expect(explain("S3 SlowDown (503): busy").message).toBe("S3 answered with HTTP 503 (SlowDown).");
  expect(explain("RGW returned HTTP 502  ").message).toMatch(/^RGW answered with HTTP 502\. A proxy in between .*"No proxy"/);
  expect(explain("cannot reach RGW: operation timed out").message).toMatch(/^RGW did not answer in time/);
  expect(explain("AccessDenied (403): refused [needs users=read]").message).toBe("Not allowed: this cluster's key lacks the caps users=read.");
  expect(explain("keychain: cannot read secret key: locked").message).toMatch(/^The system keychain/);
  expect(explain("something nobody has seen before").message).toBe("The operation failed.");
  // No sentence of one language in the other: every known code, both ways.
  for (const raw of ["NoSuchBucket (404): x", "S3 NoSuchKey (404): x", "RGW returned HTTP 500  ", "cannot reach RGW: refused", "nonsense"]) {
    applyLang("en");
    const english = explain(raw).message;
    applyLang("vi");
    expect(explain(raw).message).not.toBe(english);
    expect(explain(raw).message).not.toBe(raw);
  }
});

test("S3 errors made with a user's own key get their own wording", () => {
  const denied = explain("S3 AccessDenied (403): ");
  expect(denied.message).toMatch(/^Key của user này không có quyền/);
  expect(denied.code).toBe("AccessDenied");
  expect(explain("S3 NotFound (404): ").message).toMatch(/^Object không tồn tại/);
  expect(explain("S3 HTTP403 (403): no error document").message).toMatch(/^Key của user này/);
  expect(explain("S3 PreconditionFailed (412): ").message).toMatch(/thay đổi trong lúc đang tải/);
  expect(explain("S3 SlowDown (503): busy").message).toBe("S3 báo lỗi HTTP 503 (SlowDown).");
  // The admin API's AccessDenied keeps its own (caps) wording.
  expect(explain("AccessDenied (403): the admin user lacks the caps for this operation").message).toMatch(/caps/);
});

test("S3 errors of bucket creation", () => {
  expect(explain("S3 BucketAlreadyExists (409): Cannot modify existing access control policy").message).toMatch(/đã được dùng/);
  expect(explain("S3 TooManyBuckets (400): ").message).toMatch(/số bucket tối đa/);
});

test("a refusal tagged with caps names them and keeps the original text", () => {
  const raw = "AccessDenied (403): the admin user lacks the caps for this operation [needs metadata=read;users=read]";
  const e = explain(raw);
  expect(e.caps).toEqual(["metadata=read", "users=read"]);
  expect(e.message).toBe("Không đủ quyền: key của cluster này thiếu caps metadata=read, users=read.");
  expect(e.code).toBe("AccessDenied");
  expect(e.detail).toBe(raw);
  // Untagged, as before M6: no caps to name.
  expect(explain("AccessDenied (403): the admin user lacks the caps for this operation").caps).toBeUndefined();
});

test("answers a proxy usually gives point at the proxy setting; a bad proxy URL is named", () => {
  // Exactly what the Admin Ops and S3 clients report when a proxy answers 502 for a private endpoint.
  const admin = explain("RGW returned HTTP 502  ");
  expect(admin.message).toMatch(/^RGW báo lỗi HTTP 502\. Lỗi này thường do proxy/);
  expect(admin.message).toMatch(/Không dùng proxy/);
  expect(explain("S3 HTTP502 (502): no error document").message).toMatch(/^S3 báo lỗi HTTP 502 \(HTTP502\)\. Lỗi này thường do proxy/);
  expect(explain("RGW returned HTTP 407  ").message).toMatch(/proxy/);
  expect(explain("RGW returned HTTP 500  ").message).toBe("RGW báo lỗi HTTP 500.");
  expect(explain('invalid proxy URL "nope": expected http://host:port').message).toBe("URL proxy không hợp lệ: cần dạng http://host:port.");
});
