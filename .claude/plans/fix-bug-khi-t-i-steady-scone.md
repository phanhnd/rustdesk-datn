# Fix: bấm "Đăng nhập với Keycloak" hiện ngay "Tài khoản không có quyền quản trị"

#date: 20.06.2026

## Tiến độ / Changelog

### 2026-06-20 17:37 +07 — Plan được duyệt, bắt đầu triển khai

Đã exit plan mode, chuẩn bị thực thi các thay đổi trong `server.js` theo mục
"Approach" dưới đây.

### 2026-06-20 (cập nhật) — Chốt lại plan triển khai trước khi code

Plan giữ nguyên root cause + approach đã ghi ở trên. Bổ sung chi tiết cụ thể từng
thay đổi (đã đối chiếu lại với code hiện tại trong `server.js`) trước khi thực thi:

**1. Helper mới** `buildKeycloakLogoutUrl(postLogoutPath)` — đặt cạnh các helper khác
(`getRolesFromPayload`, `introspectToken`, khoảng dòng 270-287):
```js
function buildKeycloakLogoutUrl(postLogoutPath) {
  const params = new URLSearchParams({
    client_id: ADMIN_CLIENT_ID,
    post_logout_redirect_uri: `http://${VM_HOST}${postLogoutPath}`,
  });
  return `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/logout?${params}`;
}
```

**2. Refactor `/admin/logout`** (dòng 442-456): thay đoạn dựng `logoutParams`/
`logoutUrl` thủ công bằng `buildKeycloakLogoutUrl('/admin')`. Không đổi response
shape (`{ ok: true, logoutUrl }`), không đổi cookie-clear logic — `admin.html:302-305`
(`doLogout()`) vẫn fetch `/admin/logout` rồi `location.href = data.logoutUrl` như cũ.

**3. Sửa block role-check thất bại** (dòng 405-409) — đây là trang HTML do server
render trực tiếp (không qua SPA `admin.html`), nên link logout có thể là `<a href>`
thuần, không cần JS fetch:
```js
if (!introspection.active || !roles.includes(ADMIN_ROLE)) {
  const logoutUrl = buildKeycloakLogoutUrl('/admin/login');
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><body><h2>Tài khoản không có quyền quản trị.</h2>
    <p><a href="${logoutUrl}">Đăng xuất tài khoản hiện tại và thử lại</a></p>
    </body></html>`);
  return;
}
```

**Không làm:** không thêm `prompt=login` vào `/admin/login`; không đổi logic
role-check; không đụng `public/admin.html` hay flow `/api/auth/*` của RustDesk desktop
client (`src/ui/ab.tis`).

**Sau khi code xong sẽ cập nhật thêm:** dòng changelog xác nhận đã triển khai, và
`docs/admin-ui.md` (Change Log) ghi nhận helper mới + recovery link + phụ thuộc cấu
hình Keycloak bên dưới.

### 2026-06-20 — Đã triển khai xong code

`node --check server.js` pass. 3 thay đổi đã áp dụng đúng như mục "Approach":
helper `buildKeycloakLogoutUrl`, refactor `/admin/logout`, thêm recovery link vào
trang 403 ở `/admin/auth/callback`. Đã ghi entry vào `docs/admin-ui.md` Change Log.
**Còn lại, cần user tự làm tay:** thêm 2 "Valid post logout redirect URIs" trên
Keycloak Admin Console cho client `rocky-admin` (xem mục "Phụ thuộc cấu hình
Keycloak" ở trên) — fix sẽ không có tác dụng thực tế (vẫn `400 Invalid redirect
uri`) nếu chưa làm bước này. Chưa test end-to-end trong browser (cần user xác nhận
đã có quyền/chuẩn bị 2 tài khoản test theo mục Verification).

## Context

Admin UI (`server.js` + `public/admin.html`) đã triển khai login Keycloak SSO
theo `.claude/plans/admin-login-keycloak-sso.md`. User báo bug: bấm "Đăng nhập
với Keycloak" thì **nhảy thẳng** tới trang lỗi "Tài khoản không có quyền quản
trị" — **không thấy form Keycloak nào** (không được nhập username/password)
trước khi bị báo lỗi.

### Root cause (đã xác nhận bằng Keycloak Admin API, read-only)

Đây không phải lỗi ở logic role-check (`server.js:403-409`) — phần đó hoạt
động đúng. Vấn đề là **trình duyệt đang có sẵn 1 session SSO Keycloak còn
hiệu lực** cho user `testadmin` (xác nhận qua
`GET /admin/realms/rustdesk/clients/{id}/user-sessions`), dùng chung giữa cả
2 client `rocky-admin` và `rustdesk-client` (đặc tính SSO chuẩn — 1 phiên đăng
nhập Keycloak trong browser được mọi client trong cùng realm tái sử dụng).

`testadmin` có role `admin` trên client **`rustdesk-client`** (client cũ),
**không có** role `admin` trên client **`rocky-admin`** (client mới cho admin
UI — chỉ user `admintest` có, đã xác nhận qua
`GET /admin/realms/rustdesk/clients/{rocky-admin-id}/roles/admin/users`).

Luồng xảy ra:
1. User bấm "Đăng nhập với Keycloak" → `GET /admin/login` → redirect Keycloak
   `/auth?client_id=rocky-admin&...`.
2. Vì browser đã có session SSO active (của `testadmin`), Keycloak **không
   hiện form login** — tự động redirect thẳng về
   `/admin/auth/callback?code=...` với code đã gắn sẵn danh tính `testadmin`.
3. `server.js` đổi code → token → introspect → `roles.includes('admin')` với
   `clientId='rocky-admin'` → **false** (vì `testadmin` chỉ có role đó trên
   `rustdesk-client`) → trả 403 tĩnh "Tài khoản không có quyền quản trị"
   (`server.js:405-409`).

**Bug thật sự cần sửa:** trang lỗi 403 đó là **dead-end** — không có nút/link
nào để thử lại bằng tài khoản khác. Vì Keycloak vẫn giữ session SSO của
`testadmin` trong browser, mọi lần bấm lại "Đăng nhập với Keycloak" sẽ lặp lại
đúng vòng lặp trên vô hạn lần, cho đến khi user tự tay xoá cookie Keycloak
hoặc đăng xuất Keycloak từ nơi khác. Đây chính là cái user gặp và gọi là "bug".

## Approach

Giữ nguyên thiết kế SSO đã chốt trong plan gốc (không ép `prompt=login` —
việc đó sẽ phá tính năng "bỏ qua nhập lại password nếu đã có session đúng
tài khoản" mà plan gốc yêu cầu, mục quyết định #2/#5). Thay vào đó, thêm
**đường thoát (recovery path)** ngay tại trang lỗi 403: 1 link "Đăng xuất
tài khoản hiện tại & thử lại" trỏ tới Keycloak end-session endpoint, với
`post_logout_redirect_uri` quay lại `/admin/login` — tức là: kết thúc session
SSO sai tài khoản trước, rồi tự động kích hoạt lại luồng login (lúc này
Keycloak sẽ thực sự hiện form nhập username/password vì không còn session
nào để tái dùng).

### Thay đổi `server.js`

1. Thêm helper `buildKeycloakLogoutUrl(postLogoutPath)` để dùng chung giữa
   route `/admin/logout` (đang có, dòng 442-456) và route mới — tránh lặp code
   dựng URL `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/logout?...`.
   Refactor `/admin/logout` để gọi helper này với `'/admin'`.
2. Trong block role-check thất bại (`server.js:405-409`), thay nội dung HTML
   tĩnh bằng: dựng `logoutUrl = buildKeycloakLogoutUrl('/admin/login')`, render
   trang lỗi có thêm `<a href="${logoutUrl}">Đăng xuất tài khoản hiện tại và
   thử lại</a>`.
3. Không đổi logic role-check, không đổi `/admin/login`, không thêm
   `prompt=login`.

### Phụ thuộc cấu hình Keycloak (thao tác tay, ngoài code — phải làm trước khi fix có tác dụng)

Đã ghi nhận từ trước trong `admin-login-keycloak-sso.md` changelog: client
`rocky-admin` chưa có **"Valid post logout redirect URIs"** nào được set, nên
Keycloak từ chối mọi `post_logout_redirect_uri` với `400 Invalid redirect
uri` — bug này chặn **cả nút "Đăng xuất" hiện tại lẫn link thoát mới này**.
Cần vào Keycloak Admin Console → client `rocky-admin` → Settings → "Valid
post logout redirect URIs" → thêm:
- `http://localhost:3000/admin` (cho nút Đăng xuất hiện có)
- `http://localhost:3000/admin/login` (cho link thoát mới)

Đây là điều kiện bắt buộc, sẽ note rõ cho user làm tay trước khi test.

### Không làm (giữ nguyên theo yêu cầu/thiết kế gốc)

- Không thêm `prompt=login` vào `/admin/login` (sẽ phá yêu cầu SSO convenience
  đã chốt).
- Không đổi cách gán role hoặc cấu hình OTP trên Keycloak.
- Không động tới `src/ui/ab.tis` hay flow `/api/auth/*` của RustDesk desktop
  client.

## Verification

1. Yêu cầu user (hoặc tự thực hiện nếu được cấp quyền) thêm 2 URL trên vào
   "Valid post logout redirect URIs" của client `rocky-admin` trên Keycloak
   Admin Console.
2. Test lại đúng kịch bản bug: trong browser đang có session SSO `testadmin`,
   mở `/admin`, bấm "Đăng nhập với Keycloak" → xác nhận vẫn nhảy thẳng tới
   trang lỗi 403 (đúng như cũ, vì root cause là session cũ, không phải code) —
   nhưng lần này trang lỗi có link "Đăng xuất tài khoản hiện tại và thử lại".
3. Bấm link đó → xác nhận Keycloak xử lý end-session thành công (không còn
   `400 Invalid redirect uri`) → tự động quay lại `/admin/login` → lần này
   Keycloak **phải hiện form nhập username/password** (vì session cũ đã bị
   xoá).
4. Đăng nhập bằng `admintest` (user có đúng role `admin` trên `rocky-admin`)
   → xác nhận vào được app shell admin UI, `GET /admin/session` trả
   `authenticated:true, username:"admintest"`.
5. Test `POST /admin/logout` từ app shell → xác nhận không còn lỗi
   `400 Invalid redirect uri` (do đã thêm `/admin` vào danh sách hợp lệ).
