# Ghi chú: Cơ chế OAuth2/OIDC hiện tại — input cho tính năng Hồ sơ người dùng

## Overview

File này lưu lại phân tích cơ chế xác thực (OAuth2/OIDC qua Keycloak) đang chạy trong luồng login hiện tại (xem chi tiết luồng đầy đủ ở [`docs/address-book.md`](address-book.md)). Mục đích: làm tài liệu nền để xây tính năng mới — **hiển thị "Hi, {tên}" / hồ sơ cá nhân** trên UI Sciter sau khi user login qua Keycloak. Chưa có code nào được implement cho tính năng này — đây chỉ là ghi chú phân tích + hướng triển khai.

## Hiện trạng đã xác nhận qua code (2026-06-19)

- Luồng login dùng **OAuth2 Authorization Code Grant** (`response_type=code`, đổi `code` lấy token tại `/token`), chạy trên endpoint Keycloak theo chuẩn **OIDC** (`/realms/:realm/protocol/openid-connect/*`), và có request `scope: 'openid'` (`server.js:662`).
- Vì có `scope=openid`, Keycloak **thực sự trả về `id_token`** trong response của `/token` — nhưng `server.js:673-701` (`/api/auth/callback`) **chỉ đọc `tokenData.access_token`**, bỏ qua hoàn toàn `tokenData.id_token`. Không có dòng code nào decode/lưu/dùng `id_token` ở bất kỳ đâu trong repo (`grep id_token` → 0 kết quả ngoài comment phân tích).
- `access_token` (JWT, do Keycloak tự nhúng `realm_access.roles` + `resource_access`) hiện được dùng cho 2 việc:
  1. Bearer token gọi API gateway (`Authorization: Bearer <access_token>` — `ab.tis:787,801`, `ui.rs:511`).
  2. Tự decode (`decodeJwtPayload()`, `server.js:253-261`) để lấy `roles`, dùng filter Address Book / check-access. **Không verify chữ ký JWT** — rủi ro đã ghi trong `docs/address-book.md`.
- **Không có claim profile nào** (`name`, `preferred_username`, `email`) đang được lấy ra ở đâu cả → hiện tại app hoàn toàn không biết tên/email của user đã login, chỉ biết roles.
- Không gọi `/userinfo`, không có discovery (`/.well-known/openid-configuration`), không JWKS để verify.
- Không thấy `refresh_token` được lưu hoặc dùng ở đâu trong `server.js` — chỉ `access_token` (TTL ngắn, mặc định Keycloak ~5 phút) được giữ lại trong `sessions` Map và `LocalConfig` phía client.

## 2 hướng để lấy được tên/email cho tính năng hồ sơ

### Hướng A — Gọi `/userinfo` bằng `access_token` hiện có (khuyến nghị)

```
GET {KEYCLOAK_URL}/realms/{REALM}/protocol/openid-connect/userinfo
Authorization: Bearer <access_token>
```

- Đây là endpoint chuẩn OIDC, Keycloak **tự verify token phía server** trước khi trả profile — không cần app tự verify JWT.
- Không cần thay đổi gì ở luồng login hiện tại (vẫn chỉ cần `access_token` đang có sẵn).
- Nhược điểm: thêm 1 round-trip HTTP mỗi lần cần hiển thị hồ sơ (có thể cache phía gateway).

### Hướng B — Lưu và decode `id_token` (cần sửa luồng login)

- Sửa `server.js:688` để lưu thêm `tokenData.id_token` vào `sessions`.
- Sửa `/api/auth/status` (`:703-719`) trả thêm `id_token` (hoặc đã-decode-sẵn `name`/`email`) cho `ab.tis`.
- Cần quyết định: decode tay (như `decodeJwtPayload` hiện tại — **không verify signature**, kế thừa cùng rủi ro) hay verify đúng chuẩn (cần JWKS, thêm dependency/code).
- Cách này đúng tinh thần OIDC hơn (vì `id_token` đúng là nơi OIDC định nghĩa để mang identity), nhưng tốn công sửa nhiều chỗ hơn Hướng A.

**Khuyến nghị: Hướng A** — tận dụng `access_token` đang có, không cần sửa luồng login, không cần tự verify JWT (Keycloak verify hộ qua `/userinfo`).

## Rủi ro cần lưu ý khi implement

- `access_token` TTL ngắn (mặc định Keycloak ~300s) — nếu hồ sơ cần hiển thị liên tục/refresh, phải tính tới việc token hết hạn giữa session (hiện app chưa có refresh flow nào).
- Nếu chọn Hướng B (decode `id_token` tay), sẽ kế thừa đúng lỗ hổng "không verify signature" đã có ở `decodeJwtPayload()` — nên ưu tiên Hướng A hoặc verify đúng chuẩn nếu vẫn chọn B.
- `sessions` Map (`server.js:185`) là in-memory, mất khi gateway restart — nếu cache thêm profile vào đó, cũng mất theo, không phải vấn đề mới nhưng cần biết.

## File liên quan

| File | Vai trò |
|---|---|
| `server.js:656-719` | `/api/auth/init`, `/api/auth/callback`, `/api/auth/status` — nơi cần sửa nếu chọn Hướng B |
| `server.js:253-261` | `decodeJwtPayload()` — pattern decode JWT không verify hiện có, tham khảo nếu làm tương tự cho `id_token` |
| `src/ui/ab.tis:705-757` | Nơi `ab.tis` nhận `access_token` về và lưu — chỗ cần thêm logic gọi API hồ sơ / nhận thêm field tên |
| `src/ui.rs:497-528` | `check_access_blocking` — ví dụ cách Rust tự gọi gateway kèm Bearer token, có thể tham khảo cấu trúc tương tự cho 1 hàm lấy hồ sơ mới |

## Change Log

- **2026-06-19** — Tạo file, ghi lại phân tích cơ chế OAuth2/OIDC hiện tại (đã xác nhận qua code) làm nền cho tính năng hồ sơ cá nhân/hiển thị tên user trên UI. Chưa có thay đổi code.
