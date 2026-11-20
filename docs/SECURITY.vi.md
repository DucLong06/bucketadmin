# Bảo mật: CSP và presigned URL

[English](SECURITY.md)

Tài liệu này giải thích từng directive trong Content-Security-Policy của BucketAdmin và cách app xử lý
presigned URL. File cấu hình JSON không viết được comment, nên phần giải thích nằm ở đây.

## Ba lớp policy

App có ba document, mỗi document chịu một policy riêng (các policy cộng dồn, cái chặt nhất thắng):

| Document | Policy | Được tải gì từ ngoài app |
|---|---|---|
| Mọi trang của app | header, khai báo trong `src-tauri/tauri.conf.json` | xem bảng dưới |
| Cửa sổ chính (`index.html`) | thêm thẻ `<meta>` trong `index.html` | **không gì cả** |
| Khung xem trước (`public/preview.html`) | tự thêm `<meta>` lúc chạy (`public/preview.js`) | đúng **một origin**: endpoint RGW của object đang xem |

Lý do tách khung xem trước: endpoint RGW do người dùng tự cấu hình nên không thể ghi tên host vào policy tĩnh.
Thay vì cho cả cửa sổ chính tải ảnh / media từ mọi địa chỉ, chỉ một trang nhỏ không có logic nào khác được phép,
và trước khi tạo thẻ `<img>` / `<audio>` / `<video>` / `<iframe>` nó tự siết policy về đúng origin của URL nhận được.

## Policy chung (`tauri.conf.json`)

| Directive | Giá trị | Vì sao cần |
|---|---|---|
| `default-src` | `'self'` | Mặc định chỉ tài nguyên đóng gói cùng app. |
| `script-src` | `'self'` | Chỉ chạy script của app; không inline, không `eval`, không script từ xa. |
| `style-src` | `'self' 'unsafe-inline'` | MUI (emotion) chèn thẻ `<style>` lúc chạy. Không cho tải CSS từ xa. |
| `img-src` | `'self' data: http: https:` | Giới hạn trên cho khung xem trước (ảnh của object). Cửa sổ chính bị thẻ `<meta>` siết lại còn `'self' data:`. |
| `media-src` | `http: https:` | Giới hạn trên cho khung xem trước (audio / video stream từ RGW). Cửa sổ chính: `'none'`. |
| `frame-src` | `'self' http: https:` | `'self'` để cửa sổ chính nhúng khung xem trước; `http: https:` là giới hạn trên để khung xem trước nhúng trình xem PDF. Cửa sổ chính: chỉ `'self'`. |
| `connect-src` | `ipc: http://ipc.localhost` | Chỉ kênh IPC của Tauri. Frontend không gọi mạng trực tiếp: mọi request tới RGW đi từ backend Rust. |
| `object-src` | `'none'` | Không dùng `<object>` / `<embed>`. |
| `base-uri` | `'none'` | Không cho thẻ `<base>` đổi gốc URL. |
| `form-action` | `'none'` | Không form nào được gửi đi đâu. |

`http:` / `https:` ở ba directive trên là dạng "mọi host" vì policy tĩnh không biết trước endpoint; phần siết theo host
được làm lúc chạy trong `preview.js`: `default-src 'none'; img-src <origin>; media-src <origin>; frame-src <origin>`.

## Presigned URL

Có hai loại, đều ký bằng key của chính user đang được browse (không bao giờ bằng admin secret):

1. **URL nội bộ cho khung xem trước** (ảnh, audio, video, PDF). Hạn 15 phút. Không hiển thị, không ghi vào audit log,
   không ghi ra file. Một video tạm dừng lâu hơn 15 phút phải mở lại.
2. **URL người dùng tự tạo** (tab Properties, nút Copy URL). Hạn do người dùng chọn, mặc định 15 phút, tối đa 7 ngày.
   Audit log ghi việc tạo URL (object, hạn, user) nhưng **không ghi bản thân URL**.

Trước khi trả URL nào ra, backend kiểm tra URL đó trỏ đúng scheme + host + port của endpoint cluster đang kết nối
(`same_origin` trong `src-tauri/src/s3/transfer.rs`); không khớp thì từ chối.

## Secret

- Secret key của admin cluster: chỉ nằm trong keychain của hệ điều hành.
- Secret key của user được browse: backend lấy qua Admin API khi mở phiên browse, giữ trong bộ nhớ, không ghi ra đĩa,
  không gửi cho giao diện.
- Key cá nhân ở chế độ "Duyệt bằng key của tôi": người dùng tự dán vào, secret nằm trong keychain (entry `<id profile>.browse`,
  tách khỏi secret admin), access key nằm trong `profiles.json`. Chế độ này không gửi request nào tới Admin API; xoá key
  hoặc xoá profile thì entry trong keychain bị xoá theo. Audit log ghi `as=own-key`, không ghi access key hay secret.
- Profile được tick "Tôi là user thường": key của profile được dùng luôn làm key cá nhân (chép sang entry `.browse`), các tab
  admin bị ẩn và app không gửi request nào tới Admin API cho profile đó.
- Với profile không tick, mỗi lần kết nối app hỏi key thuộc user nào (S3 ListBuckets, không cần cap) rồi thử đọc đúng 5 endpoint
  Admin API (info, user của chính mình, metadata, bucket, usage) để biết key có caps gì. Các lần thử này chỉ đọc, không ghi audit.
- Audit log không bao giờ chứa secret key hay presigned URL.
- Bộ chọn đường dẫn chỉ đọc bucket policy (`GetBucketPolicy`) bằng key của chính kết nối để gợi ý đường dẫn; không bao giờ dùng
  key admin cho việc đó, và mọi lần bị từ chối đều im lặng.
- Trang nhật ký thao tác (trình đơn trên thanh app) chỉ để xem: app không có lệnh nào xoá, sửa hay xuất nhật ký.
