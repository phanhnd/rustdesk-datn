# Tài liệu dự án ROCKY — DATN

> Cập nhật: 2026-06-06

---

## Tổng quan hệ thống

ROCKY là bản fork của RustDesk — ứng dụng remote desktop mã nguồn mở. Dự án mở rộng thêm:
- **Keycloak SSO** để xác thực người dùng
- **Web Admin UI** để quản trị users, roles, machines
- **Address Book phân quyền** theo Keycloak client role
- **Rebrand** tên app + blue theme

---

## Kiến trúc tổng thể

```
┌─────────────────────────────────────────────────────┐
│  RustDesk Desktop App (Sciter UI)                   │
│  src/ui/ab.tis  ←→  server.js:3000                 │
└───────────────────────┬─────────────────────────────┘
                        │ HTTP (127.0.0.1)
┌───────────────────────▼─────────────────────────────┐
│  server.js — Node.js Gateway (port 3000)            │
│  - Admin UI  /admin                                 │
│  - Admin API /admin/api/*                           │
│  - Auth flow /api/auth/*                            │
│  - AB data   /api/address-books                     │
└───────────┬─────────────────────┬───────────────────┘
            │                     │
┌───────────▼──────┐   ┌──────────▼──────────────────┐
│  Keycloak :8080  │   │  data.json (local)           │
│  realm: rustdesk │   │  machines + role mappings    │
│  client: rustdesk│   └─────────────────────────────┘
│  -client         │
└──────────────────┘
```

---

## Address Book (`src/ui/ab.tis`)

### Mục đích
Tab thứ 4 trong màn hình chính RustDesk, hiển thị danh sách máy tính mà user được phép kết nối — lấy từ server dựa trên **Keycloak client role** của user.

### Biến trạng thái toàn cục

| Biến | Kiểu | Mô tả |
|---|---|---|
| `ab` | Object | `{ tags: [], peers: [] }` — dữ liệu address book hiện tại |
| `abLoading` | Boolean | Đang gọi API |
| `abError` | String | Thông báo lỗi hiển thị cho user |
| `abWaitingBrowser` | Boolean | Đang chờ user đăng nhập trên browser |

### Luồng đăng nhập

```
User nhấn [Login]
    │
    ▼
loginWithKeycloak()
    POST /api/auth/init
    → { url, session_code }
    │
    ▼
handler.open_url(url)  ← mở browser Keycloak
    │
    ▼
pollKeycloakAuth(session_code, 60 tries × 2s = 120s timeout)
    POST /api/auth/status  mỗi 2 giây
    │
    ├── pending → tiếp tục poll
    └── { access_token } → lưu vào local option "access_token"
                         → gọi getAddressBooks()
```

### Luồng lấy dữ liệu

```
getAddressBooks()
    POST /api/address-books
    Header: Authorization: Bearer <token>
    │
    ▼
Nhận { machines: [{ rustdesk_id, alias, tag, ... }] }
    │
    ▼
Build ab.tags (unique tags) + ab.peers (danh sách peers)
    │
    ▼
Render SessionList — hỗ trợ tile/list view, filter tag, search
```

### Luồng đăng xuất

```
logoutFromKeycloak()
    1. Xóa local: access_token, selected-tags
    2. Reset ab = { tags:[], peers:[] }
    3. app.update() → UI về màn hình Login ngay
    4. Async: POST /api/auth/logout (Bearer token)
             → server revoke token trên Keycloak
```

### Trạng thái UI

| Điều kiện | Hiển thị |
|---|---|
| `!access_token`, không lỗi, không chờ | Nút **Đăng nhập** |
| `abLoading = true` | Spinner |
| `abError != ""` | Text lỗi + nút **Retry** |
| `abWaitingBrowser = true` | "Đang chờ xác thực..." + nút **Hủy** |
| Đã login, có data | Tag filter (trái) + SessionList (phải) + nút **Đăng xuất** |

### Các hàm chính

| Hàm | Mô tả |
|---|---|
| `loginWithKeycloak()` | Khởi tạo OIDC flow |
| `pollKeycloakAuth(code, tries)` | Poll kết quả login mỗi 2s |
| `getAddressBooks()` | Gọi API lấy danh sách máy |
| `logoutFromKeycloak()` | Xóa token local + revoke server |
| `updateAbPeer()` | Cập nhật thông tin peer sau mỗi kết nối |

---

## Web Admin UI (`server.js` + `public/admin.html`)

### Cách chạy

```bash
cd ~/rustdesk
node server.js
# Admin UI: http://127.0.0.1:3000/admin
# Credentials: admin / admin123
```

### Kiến trúc server.js

```
server.js (không có npm dependencies, dùng built-ins)
├── Constants
│   ├── KEYCLOAK_URL = 'http://localhost:8080'
│   ├── REALM        = 'rustdesk'
│   ├── CLIENT_ID    = 'rustdesk-client'
│   └── REDIRECT_URI = 'http://127.0.0.1:3000/api/auth/callback'
│
├── State
│   ├── adminSessions  Set<token>   — admin cookie sessions
│   ├── sessions       Map<code,{}>  — OIDC pending sessions
│   ├── serviceToken   string        — KC service account token (cached)
│   └── cachedClientUuid string      — UUID của rustdesk-client (cached)
│
├── Helper functions
│   ├── loadData() / saveData()      — đọc/ghi data.json
│   ├── getServiceToken()            — lấy KC service account token (auto renew)
│   ├── getClientUuid()              — lấy UUID của KC client (cache 1 lần)
│   ├── decodeJwtPayload(token)      — decode JWT không verify signature
│   ├── getRolesFromPayload(payload) — lấy realm + client roles từ JWT
│   ├── getMachinesForRoles(roles)   — tra cứu machines từ data.json theo roles
│   ├── keycloakAdminGet(path)       — GET Keycloak Admin API
│   └── keycloakAdminRequest(method, path, body) — POST/PUT/DELETE KC Admin API
│
└── HTTP handler (single createServer callback)
    ├── GET  /admin              → serve admin.html
    ├── POST /admin/login        → tạo admin session cookie
    ├── POST /admin/logout       → xóa admin session cookie
    ├── /admin/api/*             → Admin REST API (requireAdminAuth)
    ├── POST /api/auth/logout    → revoke KC token
    ├── POST /api/auth/init      → khởi tạo OIDC (prompt=login)
    ├── GET  /api/auth/callback  → exchange code → lưu token
    ├── POST /api/auth/status    → poll kết quả login
    └── POST /api/address-books  → trả machines theo JWT role
```

### Data model (`data.json`)

```json
{
  "machines": [
    {
      "id": "a1b2c3d4e5f6g7h8",
      "alias": "Build Server",
      "rustdesk_id": "123456789",
      "tag": "Engineering",
      "note": "Server chính"
    }
  ],
  "roles": {
    "admin":  ["a1b2c3d4e5f6g7h8", "..."],
    "viewer": ["a1b2c3d4e5f6g7h8"]
  }
}
```

| Trường | Mô tả |
|---|---|
| `machines[].id` | Internal hex ID (dùng để map vào roles) |
| `machines[].rustdesk_id` | ID thật của RustDesk peer (dùng để kết nối) |
| `machines[].tag` | Nhãn nhóm (hiển thị trong Address Book tab filter) |
| `roles[name]` | Array of internal machine `id` |

### API endpoints đầy đủ

#### Admin API (yêu cầu cookie `admin_token`)

| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/admin/login` | Đăng nhập admin |
| POST | `/admin/logout` | Đăng xuất admin |
| GET | `/admin/api/users` | Danh sách KC users + client roles |
| POST | `/admin/api/users` | Tạo KC user mới |
| DELETE | `/admin/api/users/:id` | Xóa KC user |
| PUT | `/admin/api/users/:id/enabled` | Enable/disable user |
| POST | `/admin/api/users/:id/roles` | Gán client role cho user |
| DELETE | `/admin/api/users/:id/roles` | Thu hồi client role khỏi user |
| GET | `/admin/api/keycloak-roles` | Danh sách KC client roles |
| POST | `/admin/api/keycloak-roles` | Tạo KC client role |
| DELETE | `/admin/api/keycloak-roles/:name` | Xóa KC client role |
| GET | `/admin/api/roles` | Enriched: `[{name, machine_ids, machines, users}]` |
| PUT | `/admin/api/roles` | Cập nhật mapping `{ roleName: [machineIds] }` |
| GET | `/admin/api/machines` | Danh sách machines + trường roles |
| POST | `/admin/api/machines` | Thêm machine mới |
| PUT | `/admin/api/machines/:id` | Sửa machine |
| DELETE | `/admin/api/machines/:id` | Xóa machine |

#### Client API (dùng bởi `ab.tis`)

| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/auth/init` | Tạo session_code, trả KC login URL (`prompt=login`) |
| GET | `/api/auth/callback` | KC redirect về, exchange code → lưu token vào sessions Map |
| POST | `/api/auth/status` | Poll `{ session_code }` → trả `{ access_token }` khi xong |
| POST | `/api/auth/logout` | Revoke access token trên KC |
| POST | `/api/address-books` | Decode JWT → roles → trả machines |

### UI Admin (`public/admin.html`) — 3 tab

| Tab | Tính năng |
|---|---|
| **Người dùng** | Bảng users: tên, email, roles, trạng thái. Tạo/xóa user, gán/thu hồi role (modal), enable/disable |
| **Danh sách role** | Role cards: tên role + danh sách users + danh sách machines. Thêm/gỡ user khỏi role, thêm/gỡ machine khỏi role, tạo/xóa KC role |
| **Danh sách máy** | Bảng CRUD: Alias / RustDesk ID / Tag / Ghi chú / Roles. Modal edit có chọn roles |

---

## Luồng phân quyền Address Book (end-to-end)

```
[Keycloak Admin UI]
  Gán user "anh" vào client role "engineering"
        │
        ▼
[Web Admin UI]
  Tab Roles: mapping "engineering" → [machine-id-1, machine-id-2]
  Lưu vào data.json
        │
        ▼
[RustDesk client — ab.tis]
  User "anh" đăng nhập Keycloak
  JWT payload: resource_access.rustdesk-client.roles = ["engineering"]
        │
        ▼
[server.js — POST /api/address-books]
  getRolesFromPayload → ["engineering"]
  getMachinesForRoles → [machine-id-1, machine-id-2]
  → trả machines tương ứng với rustdesk_id, alias, tag
        │
        ▼
[RustDesk client — Address Book tab]
  Hiển thị đúng 2 máy thuộc role "engineering"
  User có thể kết nối bằng double-click
```

---

## Keycloak — cấu hình hiện tại

| Thông số | Giá trị |
|---|---|
| URL | `http://localhost:8080` |
| Realm | `rustdesk` |
| Client ID | `rustdesk-client` |
| Client Secret | `wzZwDnLFW02kkOS3gyCdKWNErENBaEEN` |
| Redirect URI | `http://127.0.0.1:3000/api/auth/callback` |
| Grant type (service account) | `client_credentials` |

**Service account permissions** (realm-management):
- `view-users`, `manage-users`, `view-realm` — đã có
- `manage-clients` — cần thêm để tạo/xóa KC client role từ UI

**Client roles hiện có:** `admin`, `viewer`, `guest`

**Fallback khi KC offline:** `GET /admin/api/roles` tự fallback về `appData.roles` keys, hiển thị banner cảnh báo vàng trên UI.

---

## Cấu trúc file quan trọng

```
~/rustdesk/
├── src/
│   ├── lang.rs                    ← Fallback language = "vi"
│   └── ui/
│       ├── ab.tis                 ← Address Book + Keycloak login/logout
│       ├── common.tis             ← Shared utils, msgbox, connect flow
│       ├── index.tis              ← Main window, peer list
│       ├── header.tis             ← Remote session toolbar
│       ├── file_transfer.tis      ← File transfer UI
│       ├── msgbox.tis             ← Dialog/msgbox component
│       ├── common.css             ← Blue theme CSS variables
│       └── index.css              ← Gradient banner
├── libs/hbb_common/src/config.rs  ← APP_NAME = "ROCKY"
├── server.js                      ← Node.js gateway (không npm deps)
├── public/admin.html              ← Web admin UI (3 tab, single-page)
├── data.json                      ← Persistence: machines + role mappings
└── .claude/
    ├── SUMMARY.md                 ← Nhật ký thay đổi theo task
    ├── DATN.md                    ← File này — tài liệu dự án
    └── plans/                     ← Implementation plans theo từng task
```
