# Báo cáo tổng hợp dự án ROCKY

> Tổng hợp từ tất cả file `.md` trong project root + `.claude/`
> Ngày tổng hợp: 2026-06-15

---

# MỤC LỤC

1. [Tổng quan dự án (README)](#1-tổng-quan-dự-án)
2. [Tài liệu hướng dẫn (CLAUDE.md / AGENTS.md)](#2-tài-liệu-hướng-dẫn)
3. [Tài liệu kỹ thuật dự án DATN](#3-tài-liệu-kỹ-thuật-dự-án-datn)
4. [Nhật ký công việc (SUMMARY)](#4-nhật-ký-công-việc)
5. [Plan: Rebrand ROCKY + Blue Theme](#5-plan-rebrand-rocky--blue-theme)
6. [Plan: Đổi ngôn ngữ tiếng Việt](#6-plan-đổi-ngôn-ngữ-tiếng-việt)
7. [Plan: Keycloak Login + Address Book phân quyền](#7-plan-keycloak-login--address-book-phân-quyền)
8. [Plan: Hoàn thiện Admin UI](#8-plan-hoàn-thiện-admin-ui)

---

# 1. Tổng quan dự án

> Nguồn: `README.md`

RustDesk là ứng dụng remote desktop viết bằng Rust. Dự án ROCKY là bản fork với các mở rộng thêm về SSO, Admin UI và phân quyền Address Book.

## Build trên Linux

### Ubuntu 18 (Debian 10)

```sh
sudo apt install -y zip g++ gcc git curl wget nasm yasm libgtk-3-dev clang libxcb-randr0-dev libxdo-dev \
        libxfixes-dev libxcb-shape0-dev libxcb-xfixes0-dev libasound2-dev libpulse-dev cmake make \
        libclang-dev ninja-build libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libpam0g-dev
```

### Install vcpkg

```sh
git clone https://github.com/microsoft/vcpkg
cd vcpkg
git checkout 2023.04.15
cd ..
vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=$HOME/vcpkg
vcpkg/vcpkg install libvpx libyuv opus aom
```

### Build

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
git clone --recurse-submodules https://github.com/rustdesk/rustdesk
cd rustdesk
mkdir -p target/debug
wget https://raw.githubusercontent.com/c-smile/sciter-sdk/master/bin.lnx/x64/libsciter-gtk.so
mv libsciter-gtk.so target/debug
VCPKG_ROOT=$HOME/vcpkg cargo run
```

## Build với Docker

```sh
git clone https://github.com/rustdesk/rustdesk
cd rustdesk
git submodule update --init --recursive
docker build -t "rustdesk-builder" .
docker run --rm -it -v $PWD:/home/user/rustdesk -v rustdesk-git-cache:/home/user/.cargo/git \
  -v rustdesk-registry-cache:/home/user/.cargo/registry \
  -e PUID="$(id -u)" -e PGID="$(id -g)" rustdesk-builder
```

## Cấu trúc thư mục

- `libs/hbb_common` — video codec, config, tcp/udp wrapper, protobuf, fs functions
- `libs/scrap` — screen capture
- `libs/enigo` — platform specific keyboard/mouse control
- `libs/clipboard` — file copy and paste (Windows, Linux, macOS)
- `src/ui` — Sciter UI (Sciter-based, đang dùng)
- `src/server` — audio/clipboard/input/video services, network connections
- `src/client.rs` — khởi tạo peer connection
- `src/rendezvous_mediator.rs` — giao tiếp với rustdesk-server
- `src/platform` — platform specific code

---

# 2. Tài liệu hướng dẫn

> Nguồn: `CLAUDE.md` + `AGENTS.md`

## Phạm vi làm việc

**Chỉ làm việc với Sciter UI (`src/ui/`). Không động vào bất kỳ thứ gì liên quan Flutter.**

## Build Commands

```sh
# Debug build
cargo build

# Release build
cargo run --release

# Run tests
cargo test

# Lint
cargo clippy
```

## Kiến trúc

### Session / Client Flow (`src/client.rs`)
Mỗi kết nối tạo một `Session` object chạy async Tokio task: negotiate protocol, decode video frames (qua `libs/scrap/`), play audio (qua `magnum-opus` + `cpal`).

### Server Services (`src/server/`)
Khi RustDesk đóng vai controlled peer:
- `video_service.rs` — screen capture loop
- `audio_service.rs` — microphone/speaker capture
- `input_service.rs` — nhận và replay keyboard/mouse
- `clipboard_service.rs` — clipboard sync
- `connection.rs` — per-connection handler
- `display_service.rs` — monitor display configuration changes

### Rendezvous & Relay (`src/rendezvous_mediator.rs`)
Đăng ký với rendezvous server (hbbs), xử lý hole-punching/relay qua RustDesk protocol (protobuf, định nghĩa trong `libs/hbb_common/`).

### IPC (`src/ipc.rs`)
Desktop builds dùng Unix domain sockets / named pipes để giao tiếp giữa UI process và background service process.

### Sciter UI (`src/ui/`)

| File | Role |
|---|---|
| `index.html` / `index.tis` | Main window — peer list, settings |
| `remote.html` / `remote.tis` | Remote session window |
| `remote.rs` | Rust handler cho remote session |
| `cm.html` / `cm.tis` / `cm.rs` | Connection manager (controlled side) |
| `ab.tis` | Address book component |
| `file_transfer.tis` | File transfer UI |
| `common.tis` | Shared TIS utilities |

#### Rust ↔ Sciter Communication

**Direction 1 — TIS/JS gọi Rust** qua `dispatch_script_call!` macro:

```rust
impl sciter::EventHandler for UI {
    sciter::dispatch_script_call! {
        fn get_id();
        fn set_option(String, String);
        fn get_recent_sessions();
        // 100+ functions
    }
}
```

**Direction 2 — Rust gọi TIS/JS** qua `Element::call_method()`:

```rust
fn attached(&mut self, root: HELEMENT) {
    *self.element.lock().unwrap() = Some(Element::from(root));
}

fn call(&self, func: &str, args: &[Value]) {
    allow_err!(e.call_method(func, args));
}
```

**Direction 3 — Video frames** bypass JS. Sciter `<video>` element fires `VIDEO_BIND_RQ` với native `video_destination*` pointer. Rust push raw BGRA pixels trực tiếp sau khi decode mỗi frame.

### Address Book (`src/ui/ab.tis`)

**Data model** (`libs/hbb_common/src/config.rs`):
- `Ab` — top-level: `access_token` + `ab_entries: Vec<AbEntry>`
- `AbEntry` — một address book: `guid`, `name`, `tags`, `tag_colors`, `peers: Vec<AbPeer>`
- `AbPeer` — một remote peer: `id`, `hash`, `username`, `hostname`, `platform`, `alias`, `tags`
- Local cache lưu encrypted+compressed tại `{APP_NAME}_ab`

**Server sync**:
- Fetch: `GET /api/ab/get` → parse JSON → populate `ab`
- Push: `POST /api/ab` với full `ab` JSON mỗi khi có thay đổi

### Libraries (`libs/`)

| Library | Purpose |
|---|---|
| `hbb_common` | Config, protobuf, shared utilities |
| `scrap` | Cross-platform screen capture |
| `enigo` | Cross-platform input simulation |
| `clipboard` | Clipboard access |

## Rust Coding Rules

- Tránh `unwrap()` / `expect()` trong production; dùng `Result` + `?`
- Tránh `.clone()` không cần thiết; prefer borrowing
- Không thêm dependencies trừ khi cần thiết
- Không tạo nested runtimes hay gọi `Runtime::block_on()` trong async code
- Không giữ locks qua `.await`
- Dùng `spawn_blocking` cho CPU-bound work trong async context
- Không dùng `std::thread::sleep()` trong async code

## Rebrand: ROCKY + Blue Theme

| CSS Variable | Giá trị |
|---|---|
| `accent` | `#1565C0` |
| `button` | `#42A5F5` |
| `menu-hover` | `#E3F2FD` |
| `dark-red` (nay dùng làm navy) | `#0D47A1` |

Files đã thay đổi:
- `libs/hbb_common/src/config.rs:72` — `APP_NAME = "ROCKY"`
- `src/ui/common.css` — CSS variables tông xanh
- `src/ui/index.css:344` — gradient hardcode đổi sang xanh

## Web Admin UI (`server.js` + `public/admin.html`)

```bash
node server.js
# Admin UI: http://127.0.0.1:3000/admin
# Credentials: admin / admin123
```

### Kiến trúc
- **`server.js`** — Node.js gateway, dùng built-ins (`http`, `fs`, `crypto`), không có npm dependencies
- **`public/admin.html`** — Single-page HTML, **3 tab**: Người dùng / Danh sách role / Danh sách máy
- **`data.json`** — Persistence; tự migrate từ model cũ sang model mới

### Data model `data.json`

```json
{
  "machines": [{ "id": "<hex>", "alias": "...", "rustdesk_id": "...", "tag": "...", "note": "..." }],
  "roles":    { "admin": ["<machine-id>", ...], "viewer": ["<machine-id>"] }
}
```

### Admin API endpoints

| Nhóm | Endpoints |
|---|---|
| Auth | `POST /admin/login`, `POST /admin/logout` |
| Users | `GET/POST /admin/api/users`, `DELETE /admin/api/users/:id`, `PUT /admin/api/users/:id/enabled` |
| User roles | `POST/DELETE /admin/api/users/:id/roles` |
| KC roles | `GET/POST /admin/api/keycloak-roles`, `DELETE /admin/api/keycloak-roles/:name` |
| Roles (enriched) | `GET /admin/api/roles` → `[{name, machine_ids, machines, users}]` |
| Role mapping | `PUT /admin/api/roles` → `{ roleName: [machineIds] }` |
| Machines | `GET/POST /admin/api/machines`, `PUT/DELETE /admin/api/machines/:id` |
| Client auth | `POST /api/auth/init`, `GET /api/auth/callback`, `POST /api/auth/status` |
| Address books | `POST /api/address-books` → `{ machines: [...] }` |

## Localization (`src/lang/*.rs`)

- `template.rs` — master key list, **không bao giờ edit**
- `en.rs` — chỉ chứa keys có display text khác với key string
- Các file ngôn ngữ khác: full key set; entry chưa dịch để giá trị rỗng `("key", "")`
- Chỉ điền các giá trị rỗng; không đổi key, không sửa translation hiện có
- Giữ nguyên placeholders (`{}`), escape sequences (`\n`, `\"`), tokens kỹ thuật

---

# 3. Tài liệu kỹ thuật dự án DATN

> Nguồn: `.claude/DATN.md` — Cập nhật: 2026-06-06

## Tổng quan hệ thống

ROCKY là bản fork của RustDesk — ứng dụng remote desktop mã nguồn mở. Dự án mở rộng thêm:
- **Keycloak SSO** để xác thực người dùng
- **Web Admin UI** để quản trị users, roles, machines
- **Address Book phân quyền** theo Keycloak client role
- **Rebrand** tên app + blue theme

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

## Address Book (`src/ui/ab.tis`)

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

## Web Admin UI

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
│   ├── adminSessions  Set<token>    — admin cookie sessions
│   ├── sessions       Map<code,{}>  — OIDC pending sessions
│   ├── serviceToken   string        — KC service account token (cached)
│   └── cachedClientUuid string      — UUID của rustdesk-client (cached)
│
├── Helper functions
│   ├── loadData() / saveData()
│   ├── getServiceToken()
│   ├── getClientUuid()
│   ├── decodeJwtPayload(token)
│   ├── getRolesFromPayload(payload)
│   ├── getMachinesForRoles(roles)
│   ├── keycloakAdminGet(path)
│   └── keycloakAdminRequest(method, path, body)
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

### UI Admin — 3 tab

| Tab | Tính năng |
|---|---|
| **Người dùng** | Bảng users: tên, email, roles, trạng thái. Tạo/xóa user, gán/thu hồi role, enable/disable |
| **Danh sách role** | Role cards: tên role + danh sách users + danh sách machines. Thêm/gỡ user/machine, tạo/xóa KC role |
| **Danh sách máy** | Bảng CRUD: Alias / RustDesk ID / Tag / Ghi chú / Roles. Modal edit có chọn roles |

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
    ├── SUMMARY.md
    ├── DATN.md
    └── plans/
```

---

# 4. Nhật ký công việc

> Nguồn: `.claude/SUMMARY.md` — Cập nhật: 2026-06-06

## Task 1: Rebrand — Đổi tên app → ROCKY + Blue Theme ✅

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

## Task 2: Ngôn ngữ mặc định → Tiếng Việt ✅

- `src/lang.rs` — fallback về `"vi"` khi config `"lang"` chưa được đặt

## Task 3: Keycloak Login + Address Book phân quyền theo role ✅ (server-side)

- `server.js` — OIDC flow: `/api/auth/init`, `/api/auth/callback`, `/api/auth/status`
- `src/ui/ab.tis` — polling login flow, lấy address books theo JWT role

## Task 4: Web Admin UI — 3 tab + Machine model ✅

```bash
node server.js
# http://127.0.0.1:3000/admin  |  admin / admin123
```

**API đã test pass:**
- ✅ `GET /admin/api/keycloak-roles` → trả đúng client roles (admin, viewer, guest)
- ✅ `GET /admin/api/roles` → enriched với users + machines
- ✅ `GET /admin/api/machines` → kèm trường `roles`
- ✅ `GET /admin/api/users` → kèm client roles
- ✅ `POST/DELETE /admin/api/users/:id/roles` → thêm/gỡ user khỏi role

## Task 5: Cải tiến Address Book UI + Keycloak logout + Việt hóa ✅

### 5a. Logout Keycloak hiệu quả

| File | Thay đổi |
|---|---|
| `server.js` | Thêm `POST /api/auth/logout`: nhận Bearer token, gọi Keycloak `/revoke` |
| `src/ui/ab.tis` | `logoutFromKeycloak()` xóa local state ngay, sau đó gọi API async |
| `server.js` | `/api/auth/init` thêm `prompt: 'login'` → Keycloak luôn hiện form mới |

### 5b. Xóa nút Fetch Devices

- `src/ui/index.tis` — Xóa `<button #fetch-devices>` và event handler

### 5c. Việt hóa toàn bộ thông báo UI

| File | Thay đổi |
|---|---|
| `src/ui/common.tis` | `"Connecting..."` → `"Đang kết nối..."`, `"Logging in..."` → `"Đang đăng nhập..."` |
| `src/ui/ab.tis` | 4 Keycloak error strings → tiếng Việt |
| `src/ui/index.tis` | `"Error"`, `"Download Error"` → tiếng Việt |
| `src/ui/file_transfer.tis` | `"Create Folder"`, `"Delete File"`, `"Confirm Delete"` → tiếng Việt |
| `src/ui/msgbox.tis` | `"Save as"` → `"Lưu thành"` |
| `src/ui/header.tis` | `"Note"` → `"Ghi chú"`, `"More"` → `"Thêm"` |

## Task 6: Dịch tất cả ngôn ngữ ✅ (commit `0c86d4616`)

- `src/lang/*.rs` — điền đầy đủ các entry trống

## Việc còn lại

### API đã test pass
- ✅ `GET /admin/api/keycloak-roles` → trả đúng client roles (admin, viewer, guest)
- ✅ `GET /admin/api/roles` → enriched với users + machines
- ✅ `GET /admin/api/machines` → kèm trường `roles`
- ✅ `GET /admin/api/users` → kèm client roles
- ✅ `POST/DELETE /admin/api/users/:id/roles` → thêm/gỡ user khỏi role

### Chưa verify trên browser
- [ ] Tab Roles: role cards hiện đúng users + machines
- [ ] Tab Roles: thêm/gỡ user và machine từ role card
- [ ] Tab Máy: cột Roles hiện badges đúng, modal Sửa có chọn Roles

### Việc chưa làm
- [ ] Test `POST /api/address-books` với JWT thật từ RustDesk client (ab.tis)
- [ ] Grant `manage-clients` cho service account nếu muốn tạo/xoá KC client role từ UI
- [ ] Verify ab.tis login flow hoàn chỉnh end-to-end
- [ ] (Optional) Cấu hình Google Social Login — xem `.claude/plans/keycloak-google-login.md`

---

# 5. Plan: Rebrand ROCKY + Blue Theme

> Nguồn: `.claude/plans/rebrand-rocky-blue-theme.md`

## Mục tiêu

1. Đổi tên app từ "RustDesk" → "ROCKY"
2. Thay toàn bộ bảng màu UI sang tông xanh (blue)

## Phần 1 — Đổi tên app

| File | Dòng | Nội dung cần sửa |
|---|---|---|
| `libs/hbb_common/src/config.rs` | 72 | `"RustDesk"` → `"ROCKY"` |

`APP_NAME` là single source of truth. Toàn bộ UI lấy tên qua `handler.get_app_name()`.

## Phần 2 — Đổi màu sang tông xanh

| Variable | Màu cũ | Màu mới |
|---|---|---|
| `var(accent)` | `#e91e63` | `#1565C0` |
| `var(button)` | `#f06292` | `#42A5F5` |
| `var(menu-hover)` | `#fce4ec` | `#E3F2FD` |
| `var(dark-red)` | `#A72145` | `#0D47A1` |

`src/ui/index.css:344`: `linear-gradient(left,#e91e63,#f48fb1)` → `linear-gradient(left,#1565C0,#42A5F5)`

## Thứ tự thực hiện

1. Sửa `libs/hbb_common/src/config.rs:72`
2. Sửa `src/ui/common.css` — CSS variables
3. Sửa `src/ui/index.css:344` — gradient
4. Build & kiểm tra UI

---

# 6. Plan: Đổi ngôn ngữ tiếng Việt

> Nguồn: `.claude/plans/change-lang-color.md`

## Phần 1 — Đổi ngôn ngữ mặc định sang tiếng Việt

**File cần sửa:** `src/lang.rs`

**Cơ chế hiện tại:** Khi config `"lang"` chưa được đặt, detect từ system locale.

**Thay đổi:** Set thẳng về `"vi"`:

```rust
if lang.is_empty() {
    lang = "vi".to_owned();   // mặc định tiếng Việt
}
```

User vẫn có thể đổi lại qua dropdown Language trong Settings.

## Phần 2 — UI tông màu (lịch sử)

Plan này ban đầu đề xuất màu hồng (`#e91e63`), sau đó đã được override bởi plan rebrand-rocky-blue-theme để dùng màu xanh. Xem Plan 5 để biết palette màu hiện tại.

## Tóm tắt file cần sửa (đã thực hiện)

| File | Thay đổi | Số chỗ |
|------|----------|--------|
| `src/lang.rs` | Fallback language = "vi" | 1 |
| `src/ui/common.css` | CSS variables accent/button/hover | 3 |
| `src/ui/index.css` | Gradient + inline blue | ~3 |
| `src/ui/header.tis` | SVG fill | 1 |
| `src/ui/file_transfer.tis` | SVG fill | 1 |
| `src/ui/msgbox.tis` | Dialog title colors | 2 |
| `src/ui/ab.tis` | Inline progress color | 2 |
| `src/ui/index.tis` | Copyright bg color | 1 |

---

# 7. Plan: Keycloak Login + Address Book phân quyền

> Nguồn: `.claude/plans/keycloak-login-address-book.md`

## Context

Thay thế login dialog username/password bằng luồng Keycloak OIDC. Khi user nhấn "Login", browser mở trang Keycloak; sau khi login xong, `server.js` nhận callback, đổi code lấy token, RustDesk polling lấy token về rồi fetch danh sách address book lọc theo role trong JWT.

Không cần thay đổi Rust — `handler.open_url()` và `httpRequest()` đã đủ.

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
                       ←    {machines:[...]}
  hiển thị Address Book + nút Logout
```

## Endpoints server.js

| Method | Path | Mô tả |
|--------|------|--------|
| `POST` | `/api/auth/init` | Tạo session_code, trả Keycloak auth URL |
| `GET`  | `/api/auth/callback` | Nhận code từ Keycloak, exchange lấy token |
| `POST` | `/api/auth/status` | Polling: trả `{pending:true}` hoặc `{access_token}` |
| `POST` | `/api/address-books` | Decode JWT → lọc role → trả danh sách machines |

## Hàm `loginWithKeycloak()` trong ab.tis

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

## Hàm `pollKeycloakAuth()` trong ab.tis

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

## Cấu hình Keycloak cần thiết

```
1. Tạo Realm: rustdesk
2. Tạo Client: rustdesk-client
   - Access Type: confidential
   - Valid Redirect URIs: http://127.0.0.1:3000/api/auth/callback
3. Tạo Roles: admin, viewer
4. Gán role cho user test
5. Điền CLIENT_SECRET vào server.js
```

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
2. Click Login → browser bật Keycloak → UI hiện *"Waiting... [Cancel]"*
3. Đăng nhập user role `admin` → RustDesk tự fetch → hiện danh sách máy + nút **Logout**
4. Đăng nhập user role `viewer` → chỉ hiện machines được phép
5. Click **Cancel** → về lại nút Login
6. Click **Logout** → xóa token local → về lại nút Login

---

# 8. Plan: Hoàn thiện Admin UI

> Nguồn: `.claude/plans/lap-plan-hoan-thien-tidy-starfish.md`

## Context

Hoàn thiện đầy đủ Admin UI end-to-end: CRUD users, roles, machines; data persistence; fix các bug model không nhất quán.

## Files sẽ sửa

- `server.js` — thêm endpoints, fix migration, fix httpRequest headers
- `public/admin.html` — thêm form tạo user, delete user, create/delete role, edit machine modal
- `data.json` — tự migrate khi server restart

## Thứ tự thực hiện (tóm tắt)

1. **server.js**: Fix `httpRequest` → trả `headers` (cần lấy `Location` khi tạo user KC)
2. **server.js**: Cập nhật `DEFAULT_DATA` + hàm `loadData()` với migration từ model cũ
3. **server.js**: Fix `GET /admin/api/keycloak-roles` trả `[{id, name}]` thay vì `string[]`
4. **server.js**: Fix `POST /admin/api/machines` sanitize fields
5. **server.js**: Thêm `PUT /admin/api/machines/:id` (Edit machine)
6. **server.js**: Thêm `POST + DELETE /admin/api/users`
7. **server.js**: Thêm `POST + DELETE /admin/api/keycloak-roles`
8. **admin.html**: CSS modal classes
9. **admin.html**: Fix `kcRoles` type + `loadAll()` pre-load
10. **admin.html**: Tab Users — tạo/xóa user
11. **admin.html**: Tab Roles — tạo/xóa role + renderRoleDeleteChips
12. **admin.html**: Tab Machines — update columns, addMachine form, openEditMachine/saveEditMachine
13. **Keycloak console** (manual): thêm `manage-clients` cho service account `rustdesk-client`
14. Restart `node server.js`, verify tất cả các flow

## Keycloak — lưu ý quyền

> Cần thêm quyền `manage-clients` cho service account `rustdesk-client` trong Keycloak console:
> Clients → rustdesk-client → Service Account Roles → realm-management → manage-clients

## Data model mới (machines)

```json
{
  "machines": [
    {
      "id": "hex-id",
      "alias": "Build Server",
      "rustdesk_id": "123456789",
      "tag": "Engineering",
      "note": ""
    }
  ],
  "roles": {
    "admin":  ["hex-id-1"],
    "viewer": ["hex-id-1"]
  }
}
```

## Checklist verify

- [ ] Tab Users: tạo user mới → xuất hiện trong Keycloak; xóa user → mất
- [ ] Tab Users: gán role → user login ab.tis thấy đúng machines
- [ ] Tab Roles: tạo role mới → hiện trong Keycloak console; xóa role → mất
- [ ] Tab Roles: mapping role → machines → `/api/address-books` trả đúng
- [ ] Tab Máy: thêm/sửa/xóa machine đầy đủ
- [ ] `data.json`: sau restart, migrate thành công, roles không rỗng
- [ ] `/api/address-books` với JWT hợp lệ → trả machines đúng theo role

---

*Tổng hợp từ: `README.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/DATN.md`, `.claude/SUMMARY.md`, `know1006.md`, `.claude/plans/rebrand-rocky-blue-theme.md`, `.claude/plans/change-lang-color.md`, `.claude/plans/keycloak-login-address-book.md`, `.claude/plans/lap-plan-hoan-thien-tidy-starfish.md`, `.claude/plans/keycloak-google-login.md`*
