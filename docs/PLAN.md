# BucketAdmin — Kế hoạch thực hiện (Ceph RGW)

## Nguyên tắc

- Mỗi phase chốt = **app chạy được demo trên cụm RGW thật/lab** (có thể dựng Ceph 1-node test bằng cephadm container nếu bên kia chưa cấp admin user).
- Native Rust từ đầu — Admin Ops dùng S3 signing chuẩn, không cần sidecar.
- CHỈ Linux: đội dùng desktop Linux (Ubuntu nội bộ) làm nền test chính.
- Git: không push main; nhánh `LongHD/<topic>` + MR.

## Phase 0 — Bootstrap + admin client (tuần 1)

- [ ] Repo `bucketadmin`, scaffolding Tauri 2 + React/MUI static export
- [ ] CI: build Linux (deb/AppImage) — KHÔNG build Windows, rust + pnpm cache
- [ ] Module `rgw_admin`: S3-signed requests (aws-sigv4), `format=json`, error mapping chuẩn (`AccessDenied`, `NoSuchUser`...)
- [ ] Cluster profile: add/edit/remove cụm (endpoint + admin access/secret), secret trong keychain, test `GET /admin/info` → hiện cluster_id, version
- **Demo:** thêm cụm lab, hiện info cluster.

## Phase 1 — Users, Keys, Caps (tuần 2-3)

- [ ] Màn Users: bảng list (uid, display name, suspended, caps, keys ẩn) — `GET /admin/user` metadata all
- [ ] Create user (uid, display name, email, generate keys), Modify, Remove (confirm gõ uid), suspend/enable
- [ ] Keys: tạo key mới / remove key / copy; rotate = tạo mới + remove cũ 1 click
- [ ] Caps editor: add/remove caps từ list chuẩn + custom; hiển thị caps lỗi rõ ràng
- [ ] Subuser (Swift) CRUD cơ bản
- [ ] Audit log SQLite: mọi thao tác admin (thời gian, cụm, thao tác, payload, kết quả)
- **Demo:** onboard 1 user + gán caps read buckets, sinh key, verify S3 access bằng key đó.

## Phase 2 — Quota & Usage (tuần 4)

- [ ] Quota per user (user-quota) & per bucket: set/sửa/off (max objects + max size)
- [ ] Usage: bảng per user/bucket theo khoảng ngày, export CSV, trim usage cũ (confirm)
- [ ] Buckets: list + info (owner, size, objects), view bucket policy (JSON), remove bucket (chỉ rỗng, confirm gõ tên)
- **Demo:** đặt quota 10GB cho user ở P1, upload đến chạm quota, verify hiển thị usage đúng.

## Phase 3 — Browse + Preview (tuần 5-6)

- [ ] S3 browse (aws-sdk-s3, path-style, force-signed): bucket list, prefix navigation, virtualized table, search đệ quy có giới hạn (pattern brows3)
- [ ] Preview: text/JSON/YAML (Monaco), CSV/TSV bảng, **Parquet bảng phân trang** (ranged GET footer + row-groups), ảnh, audio/video, PDF, hex
- [ ] Upload/download + multipart resume, presigned URL generator, drag-drop
- [ ] **Versions view** + **ACL custom editor** (parity với tool cũ đội sys — baseline BRIEF)
- [ ] Chạy được bằng credential user thường (verify caps thật sự có hiệu lực)
- **Demo:** mở bucket dataset, preview file parquet 500MB không tải cả file.

## Phase 4 — Bulk + polish (tuần 7)

- [ ] CSV onboarding (uid,display,caps,quota) + dry-run + report CSV kèm status từng dòng
- [ ] Search/filter mọi bảng, dark/light theme, settings
- [ ] README tiếng Việt + quickstart cho đội
- **Demo:** onboard 20 users từ CSV < 1 phút.

## Rủi ro & phương án

| Rủi ro | Xử lý |
|---|---|
| Chưa có admin user từ bên quản trị | Dựng Ceph 1-node lab (cephadm / container) để dev không bị chặn |
| Caps sai → API 403 | Test matrix caps cho từng endpoint ở Phase 1; ghi rõ README cần caps nào |
| Ceph version cũ thiếu endpoint (usage, account) | Feature-detect qua `/admin/info`, ẩn feature không hỗ trợ |
| Preview parquet schema phức tạp (nested) | v1: flat + list columns, nested hiển thị JSON của cell |
| Proxy công ty | Tauri HTTP qua proxy env; test qua proxy-noi-bo:80 |

## Definition of Done (v1)

- Linux: build deb/AppImage, đội dùng không cần hướng dẫn >5 phút
- Users/Keys/Caps/Quota CRUD + usage + audit log + bulk CSV
- Browse + preview (text, CSV, Parquet, ảnh, PDF, media)
- ≥2 cụm RGW kết nối đồng thời
