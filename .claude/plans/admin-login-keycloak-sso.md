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

## Sequence Diagram — Login Admin (trước khi triển khai)

```mermaid
sequenceDiagram
    actor Admin as Admin (Browser)
    participant Web as Admin Web UI (server.js)
    participant KC as Keycloak (realm rustdesk)

    Admin->>Web: GET /admin
    Web-->>Admin: admin.html
    Admin->>Web: GET /admin/session
    Web-->>Admin: { authenticated: false }
    Admin->>Web: Click "Đăng nhập với Keycloak"
    Admin->>Web: GET /admin/login
    Web->>Web: sinh state (CSRF), lưu tạm
    Web-->>Admin: 302 Redirect tới Keycloak /auth?client_id=rocky-admin&redirect_uri=.../admin/auth/callback&state=...

    Admin->>KC: GET /realms/rustdesk/protocol/openid-connect/auth?...
    KC-->>Admin: Trang login Keycloak (user/pass)
    Admin->>KC: Nhập username/password
    KC->>KC: Xác thực user/pass đúng
    KC->>KC: Check Conditional OTP Form (role = admin?)

    alt Có role admin & CHƯA có OTP credential
        KC-->>Admin: Hiện QR code đăng ký OTP
        Admin->>Admin: Mở app authenticator, quét QR
        Admin->>KC: Nhập mã 6 số để xác nhận đăng ký
        KC->>KC: Lưu secret_key cho user
    else Có role admin & ĐÃ có OTP credential
        KC-->>Admin: Hiện form nhập mã OTP
        Admin->>KC: Nhập mã 6 số hiện tại trên app
        KC->>KC: Verify TOTP(secret_key, time) == mã nhập
    end

    KC-->>Admin: 302 Redirect /admin/auth/callback?code=...&state=...
    Admin->>Web: GET /admin/auth/callback?code=...&state=...
    Web->>Web: Kiểm tra state khớp (chống CSRF)
    Web->>KC: POST /protocol/openid-connect/token (exchange code, client_id=rocky-admin + secret)
    KC-->>Web: access_token

    Web->>KC: POST /protocol/openid-connect/token/introspect (token, client_id=rocky-admin + secret)
    KC-->>Web: { active: true, resource_access, preferred_username, sub }

    alt role "admin" CÓ trong resource_access['rocky-admin'].roles
        Web->>Web: Tạo session trong Map, expiresAt = now + 8h
        Web-->>Admin: Set-Cookie admin_session=...; 302 Redirect /admin
        Admin->>Web: GET /admin (kèm cookie)
        Web-->>Admin: admin.html
        Admin->>Web: GET /admin/session
        Web-->>Admin: { authenticated: true, username, roles }
        Web-->>Admin: Hiện app shell (Users/Roles/Machines)
    else role "admin" KHÔNG có
        Web-->>Admin: 403 "Tài khoản không có quyền quản trị" (không tạo session)
    end
```

Ghi chú đọc sơ đồ:
- Đoạn `alt` đầu (đăng ký OTP lần đầu / nhập OTP đã có) hoàn toàn do Keycloak tự
  render và xử lý ngay trên trang login của nó — `server.js` không tham gia,
  không biết và không cần biết chuyện OTP đã xảy ra ở giữa.
- Đoạn `alt` thứ hai (role admin có/không) là logic duy nhất `server.js` phải
  tự code (bước 5 trong "Thay đổi trong `server.js`" dưới đây).
- Nếu user gõ sai username/password hoặc sai OTP, Keycloak giữ user lại ở
  trang login của nó và không bao giờ phát `code` — `server.js` không thấy
  request nào trong các trường hợp thất bại đó (không cần xử lý lỗi cho case
  này).

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
   `const VM_HOST = 'localhost:3000';` (**tạm dùng localhost để test cục bộ**,
   sẽ đổi lại thành `192.168.1.16:3000` khi deploy lên VM — chỉ cần sửa giá trị
   này, không cần sửa logic), `const KEYCLOAK_HOST = '192.168.1.16:8080';` rồi
   suy ra:
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

### 2026-06-20 — Cấu hình Keycloak (HOÀN TẤT cả 5 bước)

Trạng thái theo checklist "Hướng dẫn cấu hình Keycloak":

- [x] Bước 1 — Tạo client `rocky-admin` (confidential), có `client_secret` —
      XÁC NHẬN XONG.
- [x] Bước 2 — Tạo role `admin` trên client `rocky-admin` — XÁC NHẬN XONG.
- [x] Bước 3 — Gán role `admin` cho 1 user test — XÁC NHẬN XONG.
- [x] **Bước 4 — Tạo authentication flow `browser-admin-otp` — XONG
      (2026-06-20).** Duplicate `Browser` flow, Keycloak tự sinh sẵn nhánh
      Conditional 2FA; đã xoá điều kiện mặc định `Condition - user configured`
      (sai ngữ nghĩa — chỉ bắt OTP nếu user đã từng cấu hình trước, user admin
      mới sẽ không bao giờ bị bắt OTP) và thay bằng `Condition - user role` =
      `rocky-admin.admin` (Required), `OTP Form` đổi `Alternative` → `Required`.
      Cây cuối cùng:
      ```
      browser-admin-otp forms (Alternative)
      ├─ Username Password Form (Required)
      └─ browser-admin-otp Browser - Conditional 2FA (Conditional)
         ├─ Condition - user role (Required) → role = rocky-admin.admin
         ├─ OTP Form (Required)
         ├─ WebAuthn Authenticator (Disabled)
         └─ Recovery Authentication Code Form (Disabled)
      ```
- [ ] Bước 5 — Gán flow `browser-admin-otp` làm Browser Flow override cho
      client `rocky-admin` (client `rustdesk-client` giữ flow gốc) — ĐANG LÀM.

Cả 5 bước cấu hình Keycloak đã xong, đủ điều kiện để bắt đầu code. Tiếp theo:
sang mục "Thay đổi trong `server.js`" ở trên — sẽ chép tiến độ code vào đây
sau khi xong.

### 2026-06-20 — Code `server.js` + `public/admin.html` đã viết xong

Đối chiếu working tree với checklist "Thay đổi trong `server.js`" / "Thay đổi
trong `public/admin.html`" ở trên: cả 2 file đã được sửa khớp toàn bộ các mục
0–7 (VM_HOST refactor, `ADMIN_CLIENT_ID`/`ADMIN_SESSION_TTL_MS`, Map
`adminSessions`, `adminLoginStates` cho CSRF state, `introspectToken()`,
route `GET /admin/login`, `GET /admin/auth/callback`, `GET /admin/session`,
`POST /admin/logout` trả `logoutUrl`, `requireAdminAuth()` đọc cookie
`admin_session`) và admin.html (xoá form user/pass, nút "Đăng nhập với
Keycloak", `checkSession()`, `doLogout()` redirect theo `logoutUrl`). Chưa
chạy `git commit` — vẫn là working tree changes.

### 2026-06-20 — Kiểm thử thủ công qua curl: phát hiện bug ở logout

Test thực hiện (server đang chạy `node server.js`, Keycloak tại
`localhost:8080`):

- `GET /admin/session` (chưa đăng nhập) → `{"authenticated":false}` ✅
- `GET /admin/login` → `302` redirect đúng tới Keycloak `/auth` với
  `client_id=rocky-admin`, `redirect_uri=http://localhost:3000/admin/auth/callback`,
  `state=<random>` ✅
- Theo redirect tới Keycloak → nhận được trang login thật (form action có
  `session_code`/`execution` hợp lệ) → xác nhận client `rocky-admin` + flow
  đã cấu hình đúng, Keycloak chấp nhận `redirect_uri=localhost` ✅ (chưa test
  tiếp phần nhập user/pass/OTP thật vì không có credentials user test trong
  tay — cần user tự test hoặc cung cấp creds ở lượt sau)
- `POST /admin/logout` (có/không có cookie `admin_session`) → `200`, xoá
  cookie (`Max-Age=0`), trả `logoutUrl` đúng cấu trúc Keycloak end-session
  endpoint ✅ (logic server-side đúng theo thiết kế)
- **Bug:** gọi thẳng `logoutUrl` đó tới Keycloak → **`400 Invalid redirect
  uri`**. Tra config thật của client `rocky-admin` qua Keycloak Admin API
  (service account `rustdesk-client`) thấy:
  ```json
  { "clientId": "rocky-admin",
    "redirectUris": ["http://localhost:3000/admin/auth/callback"],
    "attributes": {} }
  ```
  Trường **"Valid post logout redirect URIs"** chưa được set (rỗng) nên
  Keycloak từ chối mọi `post_logout_redirect_uri`, kể cả
  `http://localhost:3000/admin` mà `server.js` (route `/admin/logout`) đang
  gửi. Hậu quả: bấm "Đăng xuất" trên `admin.html` → cookie local bị xoá đúng,
  nhưng browser bị redirect sang trang lỗi Keycloak thay vì logout sạch —
  **session SSO trên Keycloak không bị kết thúc**, không đạt được yêu cầu
  "global SSO logout" đã chốt ở quyết định #3 đầu plan này.

**Cách sửa (thao tác tay trên Keycloak Admin Console, ngoài phạm vi code):**
client `rocky-admin` → Settings → "Valid post logout redirect URIs" → thêm
`http://localhost:3000/admin` (và `http://192.168.1.16:3000/admin` khi deploy
lên VM, theo đúng tinh thần `VM_HOST` ở mục 0).

**Việc còn lại trước khi coi flow login/logout là PASS đầy đủ:**
- [ ] Sửa "Valid post logout redirect URIs" trên Keycloak rồi test lại
      `POST /admin/logout` → theo `logoutUrl` → xác nhận Keycloak logout
      thành công và redirect ngược về `/admin`.
- [ ] Test login thật bằng user có role `admin` trên `rocky-admin` (cần
      username/password — chưa có trong tay ở lượt test này), bao gồm cả
      bước OTP lần đầu (mục 3 trong "Kiểm thử" ở trên).
- [ ] Test user KHÔNG có role `admin` bị chặn (mục 4 trong "Kiểm thử").
- [ ] Test SSO bỏ qua nhập lại password khi đã có session Keycloak từ trước
      (mục 5 trong "Kiểm thử").
