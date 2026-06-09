# Kế hoạch: Keycloak Login + Address Book phân quyền theo role

## Context
Thay thế login dialog username/password hiện tại của Address Book bằng luồng Keycloak OIDC. Khi user nhấn "Login", browser mở trang Keycloak; sau khi login xong, `server.js` nhận callback, đổi code lấy token, RustDesk polling lấy token về rồi fetch danh sách address book được lọc theo role trong JWT.

Không cần thay đổi Rust — `handler.open_url()` và `httpRequest()` đã đủ.

---

## Kiến trúc tổng quát

```
RustDesk UI (ab.tis)        server.js               Keycloak
───────────────────         ─────────               ────────
Click "Login"
  POST /api/auth/init  →    tạo auth URL
                       ←    {url, session_code}
  open_url(url)                                →    User đăng nhập
  UI hiện "Waiting..."                              redirect callback
                            GET /api/auth/callback ←
                            exchange code → token
                            lưu token vào session
Poll 2s (có thể Cancel):
  POST /api/auth/status →
                       ←    {pending:true}  (chờ)
                       ←    {access_token}  (xong)
  lưu token local
  POST /api/address-books → decode JWT → lọc theo role
                       ←    {books:[...]}
  hiển thị Address Book + nút Logout
```

---

## File 1: `server.js` ✅ Đã thực thi

### Dependencies (Node built-in)
```js
const http = require('http');
const url_module = require('url');
const crypto = require('crypto');
const querystring = require('querystring');
```

### Config section
```js
const KEYCLOAK_URL  = 'http://localhost:8080';
const REALM         = 'rustdesk';
const CLIENT_ID     = 'rustdesk-client';
const CLIENT_SECRET = 'wzZwDnLFW02kkOS3gyCdKWNErENBaEEN';
const REDIRECT_URI  = 'http://127.0.0.1:3000/api/auth/callback';

const ROLE_BOOKS = {
  admin:  ['Engineering', 'Marketing', 'DevOps'],
  viewer: ['Engineering'],
};
const DEFAULT_BOOKS = ['Engineering'];

const BOOKS_DATA = {
  Engineering: { peers: [{ id: 'eng-01', name: 'Build Server', status: 'online' }] },
  Marketing:   { peers: [{ id: 'mkt-01', name: 'Marketing PC', status: 'offline' }] },
  DevOps:      { peers: [{ id: 'ops-01', name: 'K8s Node', status: 'online' }] },
};

const sessions = new Map(); // session_code → { access_token, pending }
```

### Các endpoint

| Method | Path | Mô tả |
|--------|------|--------|
| `POST` | `/api/auth/init` | Tạo session_code, trả Keycloak auth URL |
| `GET`  | `/api/auth/callback` | Nhận code từ Keycloak, exchange lấy token |
| `POST` | `/api/auth/status` | Polling: trả `{pending:true}` hoặc `{access_token}` |
| `POST` | `/api/address-books` | Decode JWT → lọc role → trả danh sách book |

**Lưu ý:** JWT chỉ decode base64 (không verify sig) — phù hợp cho demo/internal.

---

## File 2: `src/ui/ab.tis` ✅ Đã thực thi

### Biến trạng thái mới

```tis
var abWaitingBrowser = false;  // true khi đang poll sau khi browser mở
```

### Cấu trúc `render()` — 4 trạng thái khi chưa login

```tis
function render() {
    if (!handler.get_local_option("access_token")) {
        if (abLoading)        → spinner
        else if (abError)     → thông báo lỗi + [Retry]
        else if (abWaitingBrowser) → "Waiting for browser authentication..." + [Cancel]
        else                  → nút [Login]
    }
    // Khi đã login:
    if (abLoading)   → spinner
    else if (abError) → thông báo lỗi + [Retry]
    else → address book UI với nút [Logout] ở header Tags
}
```

### Nút Logout trong address book view

```tis
<div style="padding: 0; padding-bottom: 1em" #tags-label>
    {translate('Tags')}{svg_menu}
    <span #logout-link .link style="float: right; font-size: 0.85em; color: #888;">{translate("Logout")}</span>
</div>
```

### Hàm `loginWithKeycloak()` (cập nhật)

```tis
function loginWithKeycloak() {
    abLoading = true; abError = ""; abWaitingBrowser = false;
    app.update();
    httpRequest(".../api/auth/init", #post, {}, function(data) {
        handler.open_url(data.url);     // mở browser → Keycloak
        abLoading = false;
        abWaitingBrowser = true;        // UI hiện "Waiting..."
        app.update();
        pollKeycloakAuth(data.session_code, 60);
    }, function(err, _) {
        abError = "Auth init error: " + err;
        abLoading = false; abWaitingBrowser = false; app.update();
    });
}
```

### Hàm `pollKeycloakAuth()` (cập nhật)

```tis
function pollKeycloakAuth(sessionCode, tries) {
    if (tries <= 0) {
        abWaitingBrowser = false; abError = "Login timeout"; app.update(); return;
    }
    self.timer(2s, function() {
        if (!abWaitingBrowser) return;  // dừng ngay nếu user đã Cancel
        httpRequest(".../api/auth/status", #post, { session_code: sessionCode },
            function(data) {
                if (data && data.access_token) {
                    abWaitingBrowser = false;
                    handler.set_local_option("access_token", data.access_token);
                    getAddressBooks();
                } else { pollKeycloakAuth(sessionCode, tries - 1); }
            },
            function(err, _) { pollKeycloakAuth(sessionCode, tries - 1); }
        );
    });
}
```

### Hàm `getAddressBooks()` (giữ nguyên)

```tis
function getAddressBooks() {
    var token = handler.get_local_option("access_token");
    httpRequest(".../api/address-books", #post, {},
        successCallback, errorCallback,
        "Authorization: Bearer " + token   // header thứ 5 của httpRequest()
    );
}
```

### Hàm `logoutFromKeycloak()` (mới)

```tis
function logoutFromKeycloak() {
    handler.set_local_option("access_token", "");
    handler.set_local_option("selected-tags", "");
    ab = { tags: [], peers: [] };
    app.update();
}
// Không gọi /api/logout của hbbserver — đây là Keycloak flow, chỉ xóa token local.
```

### Event handlers mới/cập nhật

```tis
event click $(#cancel-login) → abWaitingBrowser=false, reset error, this.update()
event click $(#logout-link)  → logoutFromKeycloak()
event click $(#retry)        → nếu chưa login: reset state về Login button
                               nếu đã login: refreshCurrentUser() (giữ nguyên)
```

---

## Cấu hình Keycloak cần thiết (user tự setup)

```
1. Tạo Realm: rustdesk
2. Tạo Client: rustdesk-client
   - Access Type: confidential
   - Valid Redirect URIs: http://127.0.0.1:3000/api/auth/callback
3. Tạo Roles: admin, viewer
4. Gán role cho user test
5. Điền CLIENT_SECRET vào server.js (lấy từ tab Credentials của client)
```

---

## Kiểm tra

```bash
# Terminal 1 — Keycloak (Docker)
docker run -p 8080:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev

# Terminal 2 — Gateway
node server.js

# Terminal 3 — RustDesk
cargo run
```

**Kịch bản test:**
1. Vào tab "Address Book" → thấy nút **Login**
2. Click Login → spinner → browser bật trang Keycloak → UI hiện *"Waiting for browser authentication... [Cancel]"*
3. Đăng nhập user role `admin` trên browser → RustDesk tự fetch → hiện 3 address book + nút **Logout**
4. Đăng nhập user role `viewer` → chỉ hiện Engineering
5. Click **Cancel** khi đang chờ → về lại nút Login
6. Click **Logout** → xóa token local → về lại nút Login

**Revert:** Xóa `abWaitingBrowser`, khôi phục `render()` về 1 trạng thái, xóa `logoutFromKeycloak()` và 3 event handler mới.
