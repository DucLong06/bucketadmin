import { expect, test } from "vitest";
import { explain } from "./errors";

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
  expect(explain("RGW returned HTTP 502  <html>Bad Gateway</html>").message).toBe("RGW báo lỗi HTTP 502.");
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

test("unrecognised text is passed through unchanged", () => {
  const e = explain("keychain: cannot read secret key: locked");
  expect(e).toEqual({ message: e.detail, code: null, detail: "keychain: cannot read secret key: locked" });
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
