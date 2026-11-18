# BucketAdmin — Ceph RGW Admin & Browse Desktop for Teams

> Desktop app **Linux** quản trị **Ceph RGW** (S3 của nội bộ): users, subusers, keys, caps, quotas, usage, buckets + duyệt bucket nhanh với file preview. Cho team quản trị nội bộ. Tauri 2 + Rust core.

## Bối cảnh (đã verify 18/11/2026)

- Storage nội bộ = **Ceph (S3 qua RGW)**, hạ tầng do bên khác quản lý. Team mình cần tool quản trị user/permission cho cả đội + browse nhanh.
- **Không tồn tại GUI opensource nào cho RGW admin**: chỉ có thư viện client (go-rgwadmin, radosgw-admin4j, UMIACS/rgwadmin — không UI). Ceph Dashboard là web chạy trên cluster, bên ngoài sở hữu.
- Ceph RGW có **Admin Ops API** (`doc/radosgw/adminops.rst`, ceph/ceph): user CRUD, subuser, keys, caps, quota, usage, bucket ops. **Auth = S3 signing chuẩn** → Rust client native từ ngày 1, không cần sidecar.
- Khác MinIO: phân quyền bằng **caps** (`users=*`, `buckets=read`...) + bucket policy (S3-style JSON) + tenant/account, KHÔNG phải IAM policy kiểu MinIO wizard cũ.

## Mục tiêu

1. **P0 — Kết nối cluster:** profiles nhiều cụm RGW, admin credential (user có caps) lưu OS keychain (crate `keyring`), test bằng `GET /admin/info`
2. **P1 — Users (core):**
   - List/create/modify/remove user; suspend/enable
   - **Keys**: tạo S3 key mới, remove key, copy key về clipboard
   - **Subusers + Swift keys** (nếu nội bộ cần)
   - **Caps editor**: thêm/bớt capability theo user (dropdown caps chuẩn + custom)
   - Reset access key cho user (rotate nhanh)
3. **P2 — Quota & Usage:**
   - Set/sửa quota per user / per bucket (max objects, max size KB)
   - Usage stats: xem tiêu thụ per user/bucket (`GET /admin/usage`), trim usage cũ
   - Bucket list + info (owner, stats, policy view), remove bucket
4. **P3 — Browse + file preview (feature chính):**
   - Duyệt bucket/object theo prefix-pagination + cache (pattern brows3); cả bằng credential user thường để verify quyền
   - Preview: text/JSON/YAML/NDJSON (Monaco), CSV/TSV bảng phân trang, **Parquet → bảng (crate `parquet`/arrow, đọc footer không tải cả file)**, ảnh zoom/pan, audio/video + PDF qua presigned URL, hex viewer
   - Upload/download/multipart, presigned URL generator
5. **P4 — Team UX:** bulk onboarding CSV (user+caps+quota trong 1 dòng, dry-run), audit log SQLite mọi thao tác admin, search/filter mọi bảng

## Kiến trúc

```
bucketadmin/
├── src-tauri/src/
│   ├── rgw_admin/     # Admin Ops API client (S3-style SigV4 — xem "Lab đã verify")
│   ├── s3/            # S3 client cho browse (aws-sdk-s3, path-style)
│   ├── clusters/      # profiles + keychain
│   └── audit/         # SQLite audit log
├── src/               # React + MUI (static export)
└── docs/
```

- Signing: **S3-style SigV4 với header `x-amz-content-sha256`** (đã test trên lab: botocore `SigV4Auth` thường bị `SignatureDoesNotMatch`, `S3SigV4Auth` thì 200) → trong Rust dùng signing của `aws-sdk-s3`/`aws-sigv4` kèm payload hash header
- Preview Parquet: `parquet` + `arrow` crate, ranged GET đọc footer + row group
- Mọi request admin: `format=json` (mặc định của API)
- **Add caps đúng cú pháp: `PUT /admin/user?caps&uid=...&user-caps=...`** (thiếu `caps` param → server hiểu là create-user, trả 409 UserAlreadyExists)

## Yêu cầu vận hành (hỏi bên quản trị)

1. 1 **admin user** cho app với caps tối thiểu: `users=*`, `buckets=*`, `usage=read/write`, `info=read`, `quotas`… (caps list trong adminops.rst section "Add A User Capability")
2. Endpoint + port admin (thường cùng port S3: `https://<rgw>:443/admin/...`)
3. Biết RGW chạy bản Ceph nào (một số field như account/tenant tùy version)

## Non-goals

- Không quản lý cluster Ceph (OSD, pool, CRUSH) — bên kia lo
- Không multi-site / replication / dedup / rate-limit trong v1
- Không LDAP/OIDC federation management

## Tên

**BucketAdmin** (`bucketadmin`) — anh chọn 18/11/2026. GitHub chỉ có vài repo 0-3 sao bỏ hoang, tên sạch.

## Baseline nội bộ: tool cũ đội sys "S3 Browser - Web Edition" (đã scan 18/11/2026)

- Đang chạy tại `http://172.24.123.102:80` (FastAPI/uvicorn, web Tailwind 1 trang; HTTPS không mở)
- Đã có: bucket list/create/delete, object list/delete, **versions**, **inspect**, upload, download (`inline` = preview), **presign**, tạo folder, **ACL custom** → BucketAdmin phải phủ được các chức năng này để đội chuyển tool không mất gì
- Thiếu (lý do build BucketAdmin): user/key/caps/quota/usage admin, keychain, multi-profile persistent, audit
- Nhớ bài học: tool cũ truyền `x-s3-secret-key` trong header MỌI request — BucketAdmin KHÔNG làm vậy (secret giữ trong keychain process-local, không qua wire ngoài request S3-signing chuẩn)

## Lab nội bộ (dựng 18/11/2026 — Ceph RGW thật trên máy anh)

- `/mnt/data/ceph-lab/` — cụm cephadm squid 19.2.7 single-node: mon/mgr/OSD-0 (loop 20GB từ `osd0.img`) + **RGW port 7480**, dashboard `https://<host>:8443` (pass trong `dashboard-admin.pass`)
- Creds admin app: `lab-admin-creds.txt` (user `bucketadmin`, caps users/buckets/usage/info/metadata) — chmod 600
- Test script độc lập: `rgw_admin_test.py` + venv botocore (`venv/`) — đã test 200 cho: info, list-users, create-user, add-caps, quota get/set, usage, delete-user
- **Bài học lab (quan trọng cho Rust client):** (1) RGW Admin Ops yêu cầu SigV4 kiểu S3 có header `x-amz-content-sha256` — signer không set header này → `SignatureDoesNotMatch`; (2) add-caps phải là `PUT /admin/user?caps&uid&user-caps`, thiếu `caps` → 409 UserAlreadyExists; (3) OSD lab phải dùng spec `method: raw` vì `ceph-volume lvm batch` từ chối loop device; (4) pool size 1 cần `mon_allow_pool_size_one=true` + `--yes-i-really-mean-it`
- Quy trình phát triển (chốt theo vssh, Long xác nhận 18/11): **Claude Code (claude-fable-5-2) làm app theo chuỗi BRIEF-<milestone>.md** (backgrounded `claude -p`, mechanics như skill claude-code); **Hermes làm toàn bộ phần độc lập với dev**: lab + test scripts + verification (fmt/build/test/clippy, smoke GUI xvfb, test Admin Ops API thật) — không tin self-report, luôn verify bằng tay

## Tài liệu tham khảo đã verify

- `ceph/ceph` `doc/radosgw/adminops.rst` (3169 dòng) — toàn bộ API surface + error codes
- `twonote/radosgw-admin4j` (Java, 66★) — tham khảo object model User/Key/Cap khi làm Rust
- brows3 (MIT, Rust/Tauri) — pattern browse + preview + keychain; KHÔNG fork (không có admin)
