# Tóm tắt công việc đã thực hiện trên dự án ROCKY (RustDesk Fork)

> Cập nhật lần cuối: 2026-06-06

---

## 1. Rebrand: Đổi tên app → ROCKY + Blue Theme

**Trạng thái:** Hoàn thành ✅

| File | Thay đổi |
|---|---|
| `libs/hbb_common/src/config.rs:72` | `APP_NAME = "RustDesk"` → `"ROCKY"` |
| `src/ui/common.css` | accent `#1565C0`, button `#42A5F5`, menu-hover `#E3F2FD`, dark-red `#0D47A1` |
| `src/ui/index.css:344` | Gradient banner `#1565C0,#42A5F5` |
| `src/ui/header.tis` | SVG fill `#42A5F5` |
| `src/ui/file_transfer.tis` | SVG fill `#42A5F5` |
| `src/ui/msgbox.tis` | Dialog colors → blue |
| `src/ui/ab.tis` | Progress bar color → blue |
| `src/ui/index.tis` | Copyright bg → blue |

**Plan file:** `.claude/plans/rebrand-rocky-blue-theme.md`

---

## 2. Ngôn ngữ mặc định → Tiếng Việt

**Trạng thái:** Hoàn thành ✅

- `src/lang.rs` — fallback về `"vi"` khi config `"lang"` chưa được đặt

**Plan file:** `.claude/plans/change-lang-color.md`

---

## 3. Keycloak Login + Address Book phân quyền theo role

**Trạng thái:** Server-side hoàn thành ✅ / Chưa verify browser ⚠️

- `server.js` — OIDC flow: `/api/auth/init`, `/api/auth/callback`, `/api/auth/status`
- `src/ui/ab.tis` — polling login flow, lấy address books theo JWT role
- Keycloak: realm `rustdesk`, client `rustdesk-client`, redirect `http://127.0.0.1:3000/api/auth/callback`

**Plan file:** `.claude/plans/keycloak-login-address-book.md`

---

## 4. Web Admin UI — 3 tab + Machine model

**Trạng thái:** Hoàn thiện + API test pass ✅

**Plan file:** `.claude/plans/l-p-plan-ho-n-thi-n-enchanted-token.md`

### Cách chạy
```bash
cd ~/rustdesk
node server.js
# http://127.0.0.1:3000/admin  |  admin / admin123
# Hard refresh: Ctrl+Shift+R
```

### Kiến trúc
- `server.js` — Node.js, không có npm dependencies
- `public/admin.html` — Single-page HTML, **3 tab**
- `data.json` — Persistence (tự migrate từ books→machines khi restart)

### Keycloak hiện tại (đã verify hoạt động)
- Realm: `rustdesk` | Client: `rustdesk-client` | URL: `http://localhost:8080`
- **Client roles** (không phải realm roles): `admin`, `viewer`, `guest`
- Client UUID được cache tự động bởi `getClientUuid()` trong server.js
- Users hiện tại: `anh`, `anhndp` (viewer), `grace` (guest), `testadmin` (admin), `testviewer` (viewer)

### Data model `data.json`
```json
{
  "machines": [
    { "id": "hex-id", "alias": "Build Server", "rustdesk_id": "123456789", "tag": "Engineering", "note": "" }
  ],
  "roles": { "admin": ["hex-id-1", "hex-id-2"], "viewer": ["hex-id-1"] }
}
```
- `machines[].rustdesk_id` — ID thật của RustDesk peer dùng để kết nối
- `roles[name]` — array of machine `id` (internal hex ID)

### API endpoints

| Nhóm | Endpoints |
|---|---|
| Admin auth | `POST /admin/login`, `POST /admin/logout` |
| Users | `GET/POST /admin/api/users`, `DELETE /admin/api/users/:id`, `PUT /admin/api/users/:id/enabled` |
| User roles (client) | `POST/DELETE /admin/api/users/:id/roles` |
| KC client roles | `GET/POST /admin/api/keycloak-roles`, `DELETE /admin/api/keycloak-roles/:name` |
| Roles enriched | `GET /admin/api/roles` → `{roles:[{name, machine_ids, machines, users}], kcError}` |
| Role mapping | `PUT /admin/api/roles` → `{ roleName: [machineIds] }` |
| Machines | `GET/POST /admin/api/machines`, `PUT/DELETE /admin/api/machines/:id` |
| Auth | `POST /api/auth/init` (`prompt=login`), `GET /api/auth/callback`, `POST /api/auth/status`, `POST /api/auth/logout` |
| Address books | `POST /api/address-books` → `{ machines: [...] }` (JWT client roles → lọc) |

### Tính năng UI (3 tab)

| Tab | Tính năng |
|---|---|
| Người dùng | Danh sách + cột Tên, tạo/xoá user, gán/thu hồi role (modal), enable/disable |
| Danh sách role | Role cards: users (thêm/gỡ trực tiếp) + machines (thêm/gỡ); tạo/xoá KC role |
| Danh sách máy | Bảng CRUD: Alias/RustDesk ID/Tag/Ghi chú/Roles; modal edit có chọn roles |

### Keycloak service account permissions
- **Đã có**: `view-users`, `manage-users`, `view-realm`
- **Cần thêm** để tạo/xoá KC client role: `manage-clients`
  (Keycloak console: Clients → rustdesk-client → Service Account Roles → realm-management → manage-clients)

### Fallback khi Keycloak offline
- `GET /admin/api/roles` tự fallback sang `appData.roles` keys (hiện role + machine, không có users)
- Hiển thị banner vàng cảnh báo trên UI

### Lưu ý quan trọng
- Tất cả role operations dùng **client roles** của `rustdesk-client`, KHÔNG dùng realm roles
- Khi restart server, `data.json` cũ (có `books`) tự migrate → `machines` (idempotent)
- `getClientUuid()` cache UUID của client sau lần gọi đầu tiên

---

## 5. Cải tiến Address Book UI + Keycloak logout + Việt hóa thông báo

**Trạng thái:** Hoàn thành ✅

### 5a. Logout Keycloak hiệu quả

| File | Thay đổi |
|---|---|
| `server.js` | Thêm endpoint `POST /api/auth/logout`: nhận Bearer token, gọi Keycloak `/revoke` để invalidate token server-side |
| `src/ui/ab.tis` | `logoutFromKeycloak()` xóa local state ngay (UI phản hồi tức thì), sau đó gọi `/api/auth/logout` async |
| `server.js` | `/api/auth/init` thêm `prompt: 'login'` → Keycloak luôn hiện form đăng nhập mới, không tự SSO theo session cũ |

Keycloak revoke endpoint: `POST /realms/{realm}/protocol/openid-connect/revoke` với `client_id`, `client_secret`, `token`, `token_type_hint=access_token`.

### 5b. Xóa nút Fetch Devices

- `src/ui/index.tis` — Xóa `<button #fetch-devices>` và event handler `event click $(button#fetch-devices)`

### 5c. Việt hóa toàn bộ thông báo UI

| File | Thay đổi |
|---|---|
| `src/ui/common.tis` | `"Connecting..."` → `"Đang kết nối..."` (×5), `"Logging in..."` → `"Đang đăng nhập..."` (×5), `"Connection in progress. Please wait."` → `"Đang kết nối, vui lòng chờ."` |
| `src/ui/ab.tis` | 4 Keycloak error strings → tiếng Việt; msgbox titles `"Rename"` / `"Edit Tag"` → dùng `translate()` |
| `src/ui/index.tis` | `"Error"`, `"You cannot connect..."`, `"Download Error"`, `"Failed to download"`, `"Downloading %"` → tiếng Việt |
| `src/ui/file_transfer.tis` | `"Create Folder"` → `translate()`, `"Invalid folder name"`, `"Delete File"`, `"Confirm Delete"` (×2), `"Confirm Write Strategy"` → tiếng Việt |
| `src/ui/msgbox.tis` | `"Save as"` → `"Lưu thành"`, `"Take screenshot"` (×2) → `translate()` |
| `src/ui/header.tis` | `"Note"` → `"Ghi chú"`, `"input note here"` → `"nhập ghi chú tại đây"`, `"Custom Image Quality"` → `"Chất lượng hình ảnh tùy chỉnh"`, `"More"` → `"Thêm"` |

Giữ nguyên tiếng Anh: `"Socks5/Http(s) Proxy"`, `"% Bitrate"`, `"OS Password"` (đã dùng `translate()`), `"TCP"`, `"RDP"`.

**Plan file:** `.claude/plans/th-c-hi-n-c-c-y-u-joyful-flurry.md`

---

## 6. Dịch tất cả ngôn ngữ

**Trạng thái:** Hoàn thành ✅ (commit `0c86d4616`)

- `src/lang/*.rs` — điền đầy đủ các entry trống

---

## Cấu trúc thư mục quan trọng

```
~/rustdesk/
├── src/
│   ├── lang.rs                    ← Fallback language = "vi"
│   └── ui/
│       ├── ab.tis                 ← Address Book + Keycloak login flow
│       ├── common.css             ← Blue theme CSS variables
│       ├── index.css              ← Gradient banner
│       ├── index.tis              ← Copyright bg
│       ├── header.tis / file_transfer.tis  ← SVG fills
│       └── msgbox.tis             ← Dialog colors
├── libs/hbb_common/src/config.rs  ← APP_NAME = "ROCKY"
├── server.js                      ← Node.js gateway + admin + Keycloak proxy
├── public/admin.html              ← Web admin UI (3 tab)
├── data.json                      ← Persistence (machines + role mappings)
└── .claude/
    ├── SUMMARY.md                 ← File này
    └── plans/
        ├── rebrand-rocky-blue-theme.md
        ├── change-lang-color.md
        ├── keycloak-login-address-book.md
        └── lap-plan-hoan-thien-tidy-starfish.md
```

---

## Việc còn lại / tiếp tục khi quay lại

### Trạng thái API (đã test pass)
- ✅ `GET /admin/api/keycloak-roles` → trả đúng client roles (admin, viewer, guest)
- ✅ `GET /admin/api/roles` → enriched với users + machines
- ✅ `GET /admin/api/machines` → kèm trường `roles`
- ✅ `GET /admin/api/users` → kèm client roles
- ✅ `POST/DELETE /admin/api/users/:id/roles` → thêm/gỡ user khỏi role

### Chưa verify trên browser
- [ ] Tab Roles: role cards hiện đúng users + machines
- [ ] Tab Roles: nút "+ Thêm user" → modal chọn user → thêm thành công
- [ ] Tab Roles: nút "×" gỡ user khỏi role
- [ ] Tab Roles: nút "+ Thêm máy" → modal chọn máy
- [ ] Tab Máy: cột Roles hiện badges đúng
- [ ] Tab Máy: modal Sửa có phần chọn Roles

### Việc chưa làm
- [ ] Test `POST /api/address-books` với JWT thật từ RustDesk client (ab.tis)
- [ ] Grant `manage-clients` cho service account nếu muốn tạo/xoá KC client role từ UI
- [ ] Verify ab.tis login flow hoàn chỉnh end-to-end
