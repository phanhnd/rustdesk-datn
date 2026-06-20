# Thay login admin (admin/admin123) bằng Keycloak SSO + 2FA

#date: 20.06.2026

> **Trạng thái: ĐÃ DUYỆT PLAN — CHƯA THỰC THI.** Không sửa code/cấu hình cho
> đến khi nhận lệnh thực hiện rõ ràng từ user.

## Context

Admin Web UI (`server.js` + `public/admin.html`) hiện đăng nhập bằng credential
hardcode `admin/admin123` (`server.js:16-17`), session là token random lưu trong
`Set` in-memory `adminSessions` (`server.js:18`), cookie `admin_token` không có
hạn, không CSRF/rate-limit/hash password (`server.js:285-293, 338-362`).

Trong khi đó client ROCKY desktop đã có sẵn flow Keycloak SSO hoàn chỉnh
(`/api/auth/init|callback|status|logout`, `server.js:636-719`, gọi từ
`loginWithKeycloak()`/`pollKeycloakAuth()` trong `src/ui/ab.tis`) nhưng đây là
flow polling dành riêng cho desktop app mở browser hệ thống — không phù hợp tái
dùng 1:1 cho web UI (web UI có thể redirect trực tiếp, không cần polling).

Mục tiêu: xoá cơ chế login cứng của admin UI, thay bằng đăng nhập Keycloak
(authorization-code flow chuẩn cho web app), yêu cầu role admin, bắt buộc 2FA
**chỉ** cho người dùng có role admin (client ROCKY desktop giữ nguyên, không bị
ảnh hưởng), và đạt SSO thật (nếu user đã có session Keycloak trong cùng browser
thì không phải nhập lại mật khẩu). Logout sẽ là **global SSO logout** (kết thúc
luôn session Keycloak trong browser, theo yêu cầu user).

Các quyết định đã chốt với user:
1. Tạo **Keycloak client mới `rocky-admin`** (confidential, redirect_uri riêng
   `/admin/auth/callback`) — không tái dùng `rustdesk-client`, để tách biệt role
   và policy 2FA khỏi client ROCKY desktop, vẫn SSO chung vì cùng realm
   `rustdesk`.
2. **2FA = TOTP qua app authenticator** (Google Authenticator/Authy/Keycloak
   app), built-in Keycloak core, không cần SMTP/SMS gateway. Áp dụng qua
   **Conditional OTP Form chỉ khi user có role admin** — không ảnh hưởng login
   thường của ROCKY desktop (client `rustdesk-client` dùng flow gốc, không đổi).
3. **Logout = global SSO logout** — gọi Keycloak end-session endpoint để kết
   thúc session SSO trong browser, không chỉ xoá session local.
4. **Gom URL phụ thuộc IP VM về 1 constant `VM_HOST`** — `KEYCLOAK_URL`,
   `REDIRECT_URI`, `ADMIN_REDIRECT_URI` đều suy ra từ `VM_HOST` duy nhất, để mỗi
   lần đổi IP/mạng chỉ cần sửa 1 dòng trong `server.js` (hiện đang phải sửa rời
   rạc nhiều hằng số, dễ quên — xem ghi chú trong `CLAUDE.md` mục "Web Admin
   UI").
5. **Session admin TTL cố định 8 giờ kể từ lúc login**, không phụ thuộc vào
   thời gian sống ngắn của access_token Keycloak (vì sau khi login xong,
   backend không cần dùng lại access_token của user — mọi gọi Keycloak Admin
   API đã dùng service account riêng qua `getServiceToken()`). Hết 8 giờ phải
   đăng nhập + OTP lại, không tự refresh ngầm.
6. **Role gate dùng client role `admin` gắn trên client `rocky-admin`** (không
   dùng realm role) — phạm vi rõ ràng, không lẫn với role nào khác trong
   realm `rustdesk`.
7. **Token introspection chỉ gọi 1 lần lúc đổi code → token** (tại
   `/admin/auth/callback`), kết quả (roles, username, sub) được cache trong
   session Map server-side; các request sau chỉ kiểm tra Map + TTL, không gọi
   lại Keycloak mỗi request (đơn giản, giảm round-trip, phù hợp quy mô admin
   panel nội bộ).

## Phần cấu hình Keycloak (thực hiện trên Keycloak admin console, ngoài code)

- Tạo client `rocky-admin`: Access Type = confidential, Standard Flow Enabled,
  Valid Redirect URI = `http://192.168.1.16:3000/admin/auth/callback`. Lấy
  `client_secret`.
- Tạo realm role (hoặc client role trên `rocky-admin`) tên `admin` — gán cho
  (các) user được phép vào trang quản trị.
- Authentication flow: copy "Browser" flow → thêm execution "Conditional OTP
  Form" với điều kiện "Condition - User Role" = role `admin` (REQUIRED), giữ
  flow gốc cho `rustdesk-client` không đổi (vì copy flow riêng, gán theo
  binding của client `rocky-admin`).

Phần này nằm ngoài phạm vi code, nhưng cần ghi rõ trong `docs/admin-ui.md` vì là
tiền điều kiện để code hoạt động đúng.

## Thay đổi trong `server.js`

0. **Refactor `VM_HOST`** (dòng 9-13 hiện tại): thêm
   `const VM_HOST = '192.168.1.16:3000';` (hoặc tách riêng IP/port nếu cần),
   `const KEYCLOAK_HOST = '192.168.1.16:8080';` rồi suy ra:
   `KEYCLOAK_URL = http://${KEYCLOAK_HOST}`, `REDIRECT_URI = http://${VM_HOST}/api/auth/callback`,
   `ADMIN_REDIRECT_URI = http://${VM_HOST}/admin/auth/callback`. Khi đổi IP/mạng
   sau này chỉ cần sửa `VM_HOST`/`KEYCLOAK_HOST` (2 dòng, do Keycloak và gateway
   có thể nằm trên port/host khác nhau dù cùng VM).

1. **Hằng số cấu hình mới**: `ADMIN_CLIENT_ID = 'rocky-admin'`,
   `ADMIN_CLIENT_SECRET`, `ADMIN_ROLE = 'admin'` (client role trên
   `rocky-admin`), `ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000`.
   Xoá `ADMIN_USER`, `ADMIN_PASS`, `adminSessions` Set (dòng 16-18).

2. **Session store mới**: thay `Set` bằng `Map adminSessions` lưu
   `{ sub, username, roles, expiresAt }` (không cần giữ accessToken/idToken vì
   không dùng lại sau bước introspect ban đầu — bước 3 dưới) keyed theo session
   token random (giữ pattern `crypto.randomBytes`). `expiresAt = Date.now() +
   ADMIN_SESSION_TTL_MS`, độc lập với thời gian sống của access_token.

3. **Verify token sau khi đổi code → token**: thay vì chỉ
   `decodeJwtPayload()` (không verify signature — rủi ro đã biết, chấp nhận
   được cho flow client vì token chỉ tự dùng cho chính client đó, nhưng
   **không chấp nhận được cho admin** vì gate hành động nhạy cảm), dùng
   **token introspection** (`POST /realms/{REALM}/protocol/openid-connect/token/introspect`
   với `client_id=rocky-admin&client_secret=...&token=...`) — Keycloak tự
   verify signature + expiry, trả `active:true/false` kèm `realm_access`. Chỉ
   tạo session nếu `active === true` và `admin` nằm trong roles (dùng lại logic
   tương tự `getRolesFromPayload()`, dòng 263-273, generalize để nhận client_id
   tham số thay vì hardcode `CLIENT_ID`).

4. **Route mới thay cho `/admin/login` (POST, dòng 338-354) và logic redirect**:
   - `GET /admin/login` — redirect 302 tới Keycloak `/auth` endpoint
     (tương tự cách dựng URL ở `/api/auth/init`, dòng 656-666) với
     `client_id=rocky-admin`, `redirect_uri=ADMIN_REDIRECT_URI`,
     `response_type=code`, `scope=openid`, `state=<csrf random, lưu tạm để
     verify ở callback>`.
   - `GET /admin/auth/callback` — nhận `code`+`state`, verify `state` khớp giá
     trị đã phát (chống CSRF — flow `/api/auth/callback` hiện tại không verify
     state, đây là điểm cải thiện thêm), đổi code lấy token tại token endpoint
     (theo pattern dòng 673-701), introspect + check role `admin` (bước 3), nếu
     hợp lệ tạo session trong `adminSessions` Map, set cookie
     `admin_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/` với
     `Max-Age` = thời gian sống token, redirect 302 về `/admin`. Nếu role
     thiếu → trả trang lỗi "Tài khoản không có quyền quản trị".

5. **`/admin/logout` (POST, dòng 356-362)** sửa thành: xoá session khỏi Map,
   clear cookie, rồi trả về cho client URL Keycloak end-session
   (`{KEYCLOAK_URL}/realms/{REALM}/protocol/openid-connect/logout?client_id=rocky-admin&post_logout_redirect_uri=http://192.168.1.16:3000/admin`)
   để client-side redirect (global SSO logout thật cần redirect browser tới
   Keycloak, không chỉ gọi revoke ngầm như `/api/auth/logout` hiện tại ở dòng
   637-654).

6. **`requireAdminAuth()` (dòng 285-293)**: đổi cookie name `admin_token` →
   `admin_session`, tra trong Map mới, kiểm tra `expiresAt` chưa hết hạn (nếu
   hết hạn thì xoá session + trả 401, không tự refresh — đơn giản hoá, bắt
   login lại, vì admin UI không cần trải nghiệm "âm thầm refresh" như client).

7. **`GET /admin` (dòng 325-335)**: thêm kiểm tra session trước khi serve HTML —
   nếu chưa có session hợp lệ, vẫn serve `admin.html` (trang sẽ tự gọi API và
   nhận biết chưa login để hiện nút "Đăng nhập với Keycloak"), không cần đổi
   nhiều ở route này, gating thật nằm ở `/admin/api/*` (đã có `requireAdminAuth`
   ở mọi handler dùng nó).

   Cần thêm 1 endpoint nhẹ `GET /admin/session` trả `{ authenticated, username,
   roles }` dựa trên cookie hiện tại, để `admin.html` biết hiện login-page hay
   app-shell khi load trang (thay cho logic cũ dựa vào response của
   `doLogin()`).

## Thay đổi trong `public/admin.html`

- Xoá form login cứng (dòng 187-200: input `inp-user`/`inp-pass`, nút gọi
  `doLogin()`), thay bằng 1 nút duy nhất "Đăng nhập với Keycloak" điều hướng
  `window.location.href = '/admin/login'`.
- Xoá hàm `doLogin()` (dòng ~290-314 theo báo cáo Explore) và sự kiện Enter-key
  gắn với nó (dòng 317).
- Sửa `doLogout()` (dòng 320-323): gọi `POST /admin/logout`, nhận URL
  end-session Keycloak từ response, rồi `window.location.href = <url đó>` để
  thực hiện global SSO logout (browser sẽ được Keycloak redirect lại về
  `/admin` sau khi xong, theo `post_logout_redirect_uri`).
- Thêm logic khi trang load (`DOMContentLoaded` hoặc đầu script): gọi
  `GET /admin/session` để quyết định hiện `#login-page` hay `#app`, set
  `#admin-label` = username trả về (hiện đang hardcode tên "admin" tĩnh ở dòng
  210).

## Dọn dẹp / không làm

- Không đổi gì ở flow `/api/auth/*` và `ab.tis` của client ROCKY desktop — yêu
  cầu là chỉ thay login admin, client giữ nguyên 100%.
- Không thêm dependency npm mới — toàn bộ dùng `http`, `crypto`,
  `querystring`, `URLSearchParams` đã có sẵn trong `server.js`.
- Không implement JWKS/verify signature thủ công — dùng token introspection
  endpoint của Keycloak (đơn giản hơn, không cần tự quản lý key rotation).

## Tài liệu cần cập nhật sau khi code xong (theo quy tắc trong CLAUDE.md)

- `docs/admin-ui.md`: thêm mục mô tả flow login Keycloak mới của admin UI (sequence,
  endpoint, cookie, role yêu cầu, bước cấu hình Keycloak phải làm tay), Change
  Log entry.
- `CLAUDE.md` phần "Web Admin UI": cập nhật để không còn nhắc "Credentials:
  admin / admin123".

## Quy trình theo dõi & lưu plan

- Plan này được lưu tại `.claude/plans/admin-login-keycloak-sso.md` trong repo
  (đúng quy tắc `CLAUDE.md` mục "Planning").
- Sau **mỗi bước triển khai** (mỗi lần sửa `server.js`, `public/admin.html`,
  hoặc cấu hình Keycloak), sẽ cập nhật mục "Tiến độ / Changelog" dưới đây — ghi:
  việc đã làm, bug/vấn đề phát sinh (nếu có), và nội dung thay đổi cụ thể
  (file/dòng) — để user xem lại trước khi cho phép thực hiện bước tiếp theo.
- Việc triển khai sẽ làm theo từng bước nhỏ (Keycloak config → `server.js`
  backend → `public/admin.html` frontend → docs), dừng lại sau mỗi bước lớn để
  user review thay vì làm liền một lúc toàn bộ.
- **Chưa có lệnh thực thi từ user — KHÔNG bắt đầu code/cấu hình** cho đến khi
  được yêu cầu rõ ràng.

## Kiểm thử

1. Set up Keycloak: tạo client `rocky-admin`, role `admin`, gán role cho 1 user
   test, cấu hình Conditional OTP cho role đó.
2. Chạy `node server.js`, mở `http://192.168.1.16:3000/admin` — phải thấy nút
   "Đăng nhập với Keycloak" (không còn form user/pass).
3. Click đăng nhập → redirect Keycloak → login → (nếu lần đầu) bị bắt cấu hình
   OTP → nhập OTP → redirect ngược về `/admin` → thấy app shell, đúng username.
4. Test user KHÔNG có role `admin` đăng nhập → phải bị chặn, thấy lỗi "không có
   quyền quản trị", không tạo được session.
5. Test SSO: đăng nhập ROCKY desktop client trước (cùng browser hệ thống) rồi mở
   `/admin` — xác nhận có thể bỏ qua bước nhập lại password Keycloak (do session
   SSO của Keycloak còn hiệu lực) — vẫn phải qua OTP nếu chưa qua trong session
   này (do role-based step-up).
6. Test logout: bấm "Đăng xuất" → xác nhận cookie `admin_session` bị xoá, và
   Keycloak session cũng bị kết thúc (mở lại `/admin` phải yêu cầu đăng nhập từ
   đầu, không tự động SSO lại).
7. `cargo build`/`cargo clippy` không bị ảnh hưởng (toàn bộ thay đổi nằm ở
   `server.js`/`public/admin.html`, không đụng Rust code).

## Tiến độ / Changelog

_(chưa có mục nào — sẽ cập nhật sau mỗi bước triển khai)_
