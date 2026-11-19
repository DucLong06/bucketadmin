// Turns backend error strings into Vietnamese for the UI. The backend keeps its English text
// (src-tauri/src/rgw_admin/mod.rs, `RgwError`); the original always stays available as `detail`.

export type Explained = {
  /** What to show. Falls back to the original text when the error is not recognised. */
  message: string;
  /** RGW error code or HTTP status when one could be read from the text. */
  code: string | null;
  /** The untouched backend text. */
  detail: string;
};

const BY_CODE: Record<string, string> = {
  AccessDenied: "Không đủ quyền: admin user của cluster thiếu caps cho thao tác này.",
  SignatureDoesNotMatch: "Secret key của cluster không đúng.",
  InvalidAccessKeyId: "Access key không tồn tại trên cluster này.",
  InvalidAccessKey: "Access key không hợp lệ.",
  InvalidSecretKey: "Secret key không hợp lệ.",
  InvalidKeyType: "Loại key không hợp lệ.",
  NoSuchUser: "User không tồn tại (có thể đã bị xoá).",
  NoSuchSubUser: "Subuser không tồn tại (có thể đã bị xoá).",
  NoSuchKey: "Key không tồn tại (có thể đã bị xoá).",
  NoSuchBucket: "Bucket không tồn tại (có thể đã bị xoá).",
  NoSuchCap: "User không có cap này.",
  UserAlreadyExists: "uid này đã tồn tại.",
  // RGW also answers this when asked to remove a user that still owns buckets.
  BucketAlreadyExists: "Bucket đã tồn tại. Nếu đang xoá user: user vẫn còn bucket, hãy xoá bucket trước hoặc chọn xoá cả dữ liệu.",
  BucketNotEmpty: "Bucket vẫn còn object nên không xoá được.",
  KeyExists: "Access key này đang thuộc về user khác.",
  EmailExists: "Email này đã được dùng cho user khác.",
  InvalidCapability: "Cap không hợp lệ với bản Ceph này.",
  InvalidArgument: "Tham số không hợp lệ: RGW từ chối giá trị vừa gửi.",
  QuotaExceeded: "Vượt quá quota.",
  InvalidBucketName: "Tên bucket không hợp lệ.",
  MethodNotAllowed: "RGW này không hỗ trợ thao tác vừa gọi.",
  InternalError: "RGW gặp lỗi nội bộ. Thử lại sau hoặc xem log của RGW.",
};

// Errors of S3 calls made while browsing ("S3 <Code> (<status>): ..."): the key in question
// is the browsed user's (or the caller's own saved key), so the advice differs from the admin API's.
const S3_BY_CODE: Record<string, string> = {
  AccessDenied: "Key của user này không có quyền cho thao tác vừa làm (bị chặn bởi policy, ACL hoặc op-mask).",
  NoSuchBucket: "Bucket không tồn tại.",
  BucketAlreadyExists: "Tên bucket này đã được dùng trên cluster (bởi user khác).",
  BucketAlreadyOwnedByYou: "User này đã có bucket trùng tên.",
  InvalidBucketName: "Tên bucket không hợp lệ.",
  TooManyBuckets: "User đã đạt số bucket tối đa (max-buckets).",
  BucketNotEmpty: "Bucket vẫn còn object.",
  InvalidTag: "Tag không hợp lệ.",
  NoSuchKey: "Object không tồn tại (có thể đã bị xoá).",
  NotFound: "Object không tồn tại (có thể đã bị xoá).",
  NoSuchVersion: "Version này không tồn tại.",
  NoSuchUpload: "Phiên upload multipart không còn tồn tại.",
  PreconditionFailed: "Object đã bị thay đổi trong lúc đang tải. Hãy tải lại từ đầu.",
  InvalidRange: "Khoảng byte yêu cầu nằm ngoài object.",
  EntityTooSmall: "Một phần upload nhỏ hơn mức tối thiểu của S3.",
  MalformedACLError: "ACL không hợp lệ.",
  InvalidBucketState: "Bucket không ở trạng thái phù hợp cho thao tác này (ví dụ chưa bật versioning).",
  SignatureDoesNotMatch: "Secret key đang dùng để browse không khớp. Nếu là key của bạn, bấm Đổi key và nhập lại; nếu không, thử mở lại phiên browse.",
  InvalidAccessKeyId: "Access key đang dùng để browse không tồn tại trên cluster này. Nếu là key của bạn, bấm Đổi key và nhập lại; nếu không, thử mở lại phiên browse.",
};

export function explain(raw: string): Explained {
  const detail = raw;
  const s3 = /^S3 ([A-Za-z0-9]+) \((\d{3})\)/.exec(raw);
  if (s3) {
    const [, code, status] = s3;
    if (S3_BY_CODE[code]) return { message: S3_BY_CODE[code], code, detail };
    if (status === "403") return { message: S3_BY_CODE.AccessDenied, code, detail };
    if (status === "404") return { message: S3_BY_CODE.NotFound, code, detail };
    return { message: `S3 báo lỗi HTTP ${status} (${code}).`, code, detail };
  }
  // "NoSuchUser (404): user does not exist"
  const named = /^([A-Za-z]+) \((\d{3})\)/.exec(raw);
  // "RGW returned HTTP 400 InvalidArgument some message" (the code can be empty)
  const http = /^RGW returned HTTP (\d{3}) ?([A-Za-z]*)/.exec(raw);
  const code = named?.[1] ?? (http?.[2] || null);
  const status = named?.[2] ?? http?.[1] ?? null;

  if (code && BY_CODE[code]) return { message: BY_CODE[code], code, detail };
  if (status === "404") {
    return { message: "Không tìm thấy (HTTP 404): địa chỉ này không phải RGW Admin API, hoặc đối tượng không tồn tại.", code: code ?? "404", detail };
  }
  if (raw.startsWith("cannot reach RGW")) {
    const timedOut = /timed out|timeout/i.test(raw);
    const message = timedOut
      ? "Hết thời gian chờ RGW phản hồi. Kiểm tra mạng rồi thử lại."
      : "Không kết nối được tới RGW. Kiểm tra endpoint, mạng và proxy.";
    return { message, code: timedOut ? "timeout" : "network", detail };
  }
  if (raw.startsWith("unexpected response from RGW")) {
    return { message: "RGW trả về dữ liệu không đúng định dạng. Endpoint có thể không phải RGW Admin API.", code: null, detail };
  }
  if (status) return { message: `RGW báo lỗi HTTP ${status}${code ? ` (${code})` : ""}.`, code: code ?? status, detail };
  return { message: raw, code: null, detail };
}
