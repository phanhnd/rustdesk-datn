# CHƯƠNG 4: THIẾT KẾ VÀ XÂY DỰNG ỨNG DỤNG

> Nội dung chương này được đối chiếu lại **toàn bộ với source code thực tế** tại thời điểm
> 2026-06-23 (đọc trực tiếp `server.js`, `public/admin.html`, `src/ui.rs`, `src/ui/ab.tis`,
> `libs/hbb_common/src/config.rs`, `.github/workflows/build.yml`, `build.py`), không suy
> diễn từ bản nháp cũ. Nguồn tổng hợp: `CLAUDE.md`, `docs/admin-ui.md`,
> `docs/address-book.md`, `docs/keycloak.md`, `docs/classDiagram.md`,
> `docs/sequenceDiagram.md`, `docs/ci-windows-build.md`, `docs/ci-linux-macos-build.md`,
> `docs/user-profile-auth-notes.md`, `docs/session-2026-06-19-rocky-theme-sync.md`, và các
> plan đã thực hiện trong `.claude/plans/`.
> Các hình minh họa (biểu đồ gói, biểu đồ lớp, biểu đồ trình tự, ảnh chụp màn hình) cần được
> sinh viên vẽ lại bằng công cụ UML (draw.io, PlantUML, StarUML...) và chụp màn hình thực tế
> từ ứng dụng khi hoàn thiện báo cáo — nội dung dưới đây mô tả đầy đủ thông tin cần thể hiện
> trong các hình đó.
>
> **So với bản trước của file này:** model lưu trữ đã đổi từ `data.json` sang **SQLite**
> (`data/rocky.db`), mô hình phân quyền đổi từ **role đơn** (`admin`/`viewer`/`guest` trên
> `rustdesk-client`) sang **2 hệ tách biệt**: machine-access theo **Keycloak Group**, và
> Admin UI theo **3-tier client role** (`admin`/`manage_users`/`manage_machines`) trên client
> riêng `rocky-admin`, có thêm **2FA (TOTP)** cho admin tối cao. Theme đổi từ xanh dương
> (`#1565C0`) sang navy/teal. Toàn bộ mục 4.1–4.5 đã viết lại theo đúng hiện trạng này.

---

## 4.1. Thiết kế kiến trúc

### 4.1.1. Lựa chọn kiến trúc phần mềm

ROCKY được xây dựng dựa trên kiến trúc **client – gateway – identity provider**, kết hợp giữa
kiến trúc phân lớp (layered architecture) ở phía client và kiến trúc hướng dịch vụ
(service-oriented) ở phía backend:

- **Lớp Client (Desktop App)**: ứng dụng Rust + Sciter UI (`src/ui/`), đóng vai trò vừa là
  *controller* (máy điều khiển) vừa là *controlled peer* (máy bị điều khiển), tùy theo phiên
  kết nối.
- **Lớp Gateway**: một service Node.js độc lập (`server.js`, chỉ dùng built-in
  `http`/`fs`/`crypto`/`node:sqlite`, không có npm dependency) đóng vai trò *Backend-for-Frontend*
  — vừa là auth proxy đứng giữa client và Keycloak, vừa là REST API server phục vụ Web Admin UI,
  vừa giữ vai trò *Policy Decision Point* quyết định một user có được phép kết nối tới một máy
  cụ thể hay không.
- **Lớp Identity Provider**: **1 Keycloak realm duy nhất (`rustdesk`)**, nhưng phục vụ **2 client
  OAuth2 tách biệt** với 2 mô hình phân quyền khác nhau — `rustdesk-client` (desktop client,
  machine-access theo Keycloak Group) và `rocky-admin` (Admin UI, theo 3 client role, có 2FA
  riêng cho admin tối cao).
- **Lớp lưu trữ**: **SQLite** (`data/rocky.db`, qua module built-in `node:sqlite`) lưu 2 bảng
  `machines` và `machine_groups` (ánh xạ máy ↔ Keycloak Group) — đã thay cho `data.json` (file
  JSON phẳng dùng ở giai đoạn đầu); `data.json` cũ chỉ còn được đọc **một lần** để di trú dữ
  liệu lịch sử nếu bảng `machines` còn rỗng khi khởi động.

So với RustDesk gốc (chỉ có 2 lớp: Client ↔ Rendezvous/Relay server), ROCKY chèn thêm một lớp
gateway trung gian giữa Client và Identity Provider để giải quyết bài toán **kiểm soát truy cập
tập trung theo nhóm (Group-based access control)** mà RustDesk gốc không có. Đây là điểm cải
tiến cốt lõi của đồ án so với kiến trúc lý thuyết/sản phẩm gốc.

```
┌───────────────────────────────┐
│   ROCKY Desktop Client          │   (Rust + Sciter UI)
└───────────────┬─────────────────┘
                │ HTTP (VM_HOST:3000)
┌───────────────▼─────────────────┐
│   server.js — Gateway Layer     │   (Node.js, BFF + PDP, không npm dependency)
│   - /admin/*        Admin UI    │
│   - /admin/api/*    Admin REST  │
│   - /api/auth/*     Auth proxy (desktop client)
│   - /api/address-books          │
│   - /api/check-access           │
└──────┬──────────────────┬───────┘
       │                  │
┌──────▼──────┐   ┌───────▼────────────┐
│  Keycloak   │   │  data/rocky.db      │
│  realm      │   │  (SQLite)           │
│  "rustdesk" │   │  machines +         │
│  2 client:  │   │  machine_groups     │
│  rustdesk-  │   └────────────────────┘
│  client,    │
│  rocky-admin│
└─────────────┘
```

### 4.1.2. Thiết kế tổng quan

Sơ đồ gói (package diagram) của ROCKY được chia theo 4 tầng, tuân thủ nguyên tắc tầng dưới
không phụ thuộc tầng trên và không phụ thuộc bỏ qua tầng:

```
Tầng trình diễn (Presentation)
┌────────────────┐   ┌──────────────────┐
│  src.ui (Sciter)│   │ public (admin.html)│
└────────┬────────┘   └─────────┬─────────┘
         │                       │
Tầng giao tiếp/điều phối (Mediator)
┌────────▼────────┐   ┌─────────▼─────────┐
│  src.ui_*        │   │  server (Node.js  │
│  (ui.rs,         │   │   gateway:        │
│  ui_interface,   │   │   auth proxy ×2,  │
│  ui_session_*)   │   │   admin REST API, │
└────────┬────────┘   │   access control)  │
         │             └─────────┬─────────┘
Tầng nghiệp vụ (Domain)          │
┌────────▼────────┐              │
│ src.client       │              │
│ src.server       │              │
│ (video/audio/    │              │
│  input/clipboard │              │
│  services)       │              │
└────────┬────────┘              │
         │                       │
Tầng dùng chung / hạ tầng (Shared & Infrastructure)
┌────────▼─────────────────────────▼────────┐
│ libs.hbb_common (config, Ab/AbEntry/AbPeer,│
│   protobuf, network)                       │
│ libs.scrap (screen capture)                │
│ libs.enigo (input simulation)               │
│ libs.clipboard                              │
│ data/rocky.db (SQLite) / Keycloak (external)│
└─────────────────────────────────────────────┘
```

**Vai trò từng gói:**

| Gói | Nhiệm vụ |
|---|---|
| `src.ui` | Giao diện Sciter (HTML/TIS/CSS): `index.tis` (màn hình chính), `ab.tis` (Address Book), `remote.tis/.rs` (phiên điều khiển từ xa), `cm.tis/.rs` (Connection Manager), `file_transfer.tis`, `header.tis`, `msgbox.tis` |
| `src.ui_*` (ui.rs, ui_interface.rs, ui_session_interface.rs) | Lớp cầu nối Rust ↔ Sciter: expose hàm Rust cho TIS gọi (`dispatch_script_call!`) và gọi ngược JS từ Rust (`Element::call_method`) |
| `src.client` | Logic phía máy điều khiển: `client.rs` (Session, giải mã video), `io_loop.rs` (vòng lặp I/O bất đồng bộ) |
| `src.server` | Logic phía máy bị điều khiển: `video_service.rs`, `audio_service.rs`, `input_service.rs`, `clipboard_service.rs`, `connection.rs`, `display_service.rs` |
| `libs.hbb_common` | Thư viện dùng chung: cấu hình (`config.rs` — `APP_NAME`, `Ab`/`AbEntry`/`AbPeer`), protobuf, TCP/UDP wrapper |
| `libs.scrap`, `libs.enigo`, `libs.clipboard` | Capture màn hình, giả lập input, đồng bộ clipboard — đặc thù theo từng OS |
| `server` (Node.js gateway) | `server.js`: 2 auth proxy (desktop client + Admin UI) với Keycloak, REST API CRUD máy/Group/user, endpoint kiểm soát truy cập, lớp truy cập SQLite |
| `public` | `public/admin.html` — SPA quản trị 3 tab (Người dùng / Danh sách group / Danh sách máy), không dùng framework/bundler |

Phụ thuộc giữa các gói: `src.ui` → `src.ui_*` → `src.client`/`src.server` → `libs.hbb_common`;
gói `server` (Node.js) và `public` độc lập hoàn toàn về runtime với phần Rust, chỉ giao tiếp qua
HTTP — đây là lý do tách ROCKY thành 2 tiến trình runtime riêng biệt (Rust process + Node.js
process) thay vì nhúng logic xác thực vào lõi Rust.

### 4.1.3. Thiết kế chi tiết gói

**Nhóm gói "Address Book & Access Control"** — nhóm gói trọng tâm mà đồ án bổ sung thêm so với
RustDesk gốc:

```
┌────────────────┐        ┌──────────────────────┐
│  ab.tis         │──────▶│  GatewayClient        │   (khái niệm logic trong
│  (Sciter/TIS)   │  gọi   │  (httpRequest đến     │    ab.tis: loginWithKeycloak,
│                 │        │   server.js)          │    pollKeycloakAuth,
└────────┬────────┘        └──────────┬────────────┘    getAddressBooks,
         │ dùng                       │ gọi               logoutFromKeycloak)
         ▼                            ▼
┌────────────────┐        ┌──────────────────────┐
│  UI (ui.rs)     │──────▶│  AuthServer            │   (server.js: AuthRoutes,
│  check_access_  │ POST   │  (Node.js HTTP server)│    AdminRoutes, KeycloakClient,
│  blocking()     │ /api/  │                        │    SqliteStore)
└────────────────┘ check- └──────────┬────────────┘
                    access            │ claim "groups" → SQLite
                                      ▼
                            ┌──────────────────┐
                            │  SqliteStore       │
                            │  (data/rocky.db:   │
                            │   machines,        │
                            │   machine_groups)  │
                            └──────────────────┘
```

Quan hệ giữa các thành phần:
- `ab.tis` **kết hợp (association)** với hàm Rust `handler.*` thông qua cơ chế
  `dispatch_script_call!` — không phải kế thừa, chỉ là gọi hàm.
- `UI::check_access_blocking()` (`src/ui.rs:497`) **phụ thuộc (dependency)** vào
  `reqwest::blocking::Client` để gọi đồng bộ tới gateway — lựa chọn này (thay vì `httpRequest`
  bất đồng bộ trong TIS) là điểm thiết kế quan trọng: TIS `httpRequest` không chặn luồng thực
  thi, nên không thể dùng để *ngăn* kết nối trước khi nó xảy ra; phải đưa logic chặn xuống Rust
  dưới dạng gọi đồng bộ, timeout 800ms.
- `AuthServer` (`server.js`) **hợp thành (composition)** với `SqliteStore` — `SqliteStore` không
  có ý nghĩa tồn tại độc lập ngoài `AuthServer`.
- `AuthServer` **phụ thuộc** vào Keycloak Admin REST API qua các hàm `keycloakAdminGet`/
  `keycloakAdminRequest` (`server.js:388-397`), dùng service-account token của `rustdesk-client`
  (`getServiceToken()`, `server.js:241`) cho **mọi** lệnh quản trị Keycloak — kể cả lệnh phát
  sinh từ phía Admin UI.

---

## 4.2. Thiết kế chi tiết

### 4.2.1. Thiết kế giao diện

**Đặc tả màn hình**: ứng dụng desktop chạy trên Linux/Windows/macOS thông qua engine Sciter, độ
phân giải linh hoạt (responsive theo kích thước cửa sổ), hỗ trợ chế độ sáng/tối (light/dark mode)
qua `@media (prefers-color-scheme: dark)` trong `common.css`, hệ màu RGB 24-bit.

**Chuẩn hóa thiết kế (rebrand ROCKY + theme navy/teal):**

| Biến CSS | Vai trò | Giá trị |
|---|---|---|
| `accent` | Màu nhấn chính (nút active, link, viền focus) | `#00D2D3` |
| `button` | Màu nút bấm | `#58D0F8` |
| `menu-hover` | Màu nền khi hover menu item | `#DDF7F6` |
| `dark-red` (dùng làm navy) | Nền navy đậm | `#111D43` |
| `text` | Chữ chính | `#16234F` |
| `light-text` | Chữ phụ/label | `#5C6F94` |
| `lighter-text` | Chữ mờ nhất | `#8B9BC2` |
| `border` | Viền input/divider | `#D7E3F3` |

Lưu ý kỹ thuật quan trọng: **Sciter không hỗ trợ CSS custom property kiểu browser**
(`:root{--x}`/`var(--x)`) — phải khai báo qua cú pháp riêng `var(name): value;` trong block
`html { ... }` của `common.css`, đọc bằng `color(name)`. Vì vậy palette của app desktop
(`common.css`) và của Admin UI web (`admin.html`, dùng `:root{--x}` chuẩn browser) được khai báo
ở **2 nơi hoàn toàn riêng biệt**, không share trực tiếp được.

**Khác biệt quan trọng:** Admin UI (`public/admin.html`) dùng theme **sáng** riêng (nền trắng/
xanh rất nhạt `#F7FAFF`, accent teal đậm `#00B8B8`), **không** dùng tông navy đậm của app desktop
— sau 2 lần tăng sáng tông navy vẫn bị phản hồi "quá tối", quyết định cuối là chuyển hẳn Admin UI
sang theme sáng để dễ đọc hơn, ưu tiên hơn việc giữ đúng tông màu ảnh thương hiệu gốc.

Quy ước bố cục: thông báo lỗi hiển thị dạng banner đỏ/vàng phía trên khu vực nội dung (ví dụ
banner cảnh báo khi Keycloak offline); trạng thái đang xử lý hiển thị bằng spinner; xác nhận
hành động nguy hiểm (xóa user, xóa máy, xóa Group) dùng `msgbox` dạng confirm.

**Các màn hình chính:**

1. **Màn hình chính (`index.tis`)** — danh sách peer gần đây, thanh nhập ID kết nối, menu
   Settings/Login. Logomark (`BrandLogo`) hiển thị **không điều kiện** ở `.left-pane` (thay cho
   khung cảnh báo Wayland cũ đã bị bỏ).
2. **Tab Address Book (`ab.tis`)** — 5 trạng thái UI tùy theo tiến trình đăng nhập:

| Điều kiện | Hiển thị |
|---|---|
| Chưa có `access_token`, không lỗi, không chờ | Nút **Đăng nhập** |
| `abLoading = true` | Spinner |
| `abError != ""` | Thông báo lỗi + nút **Thử lại** |
| `abWaitingBrowser = true` | "Đang chờ xác thực trên trình duyệt..." + nút **Hủy** |
| Đã đăng nhập, có dữ liệu | Bộ lọc "Tags" (trái, dựng từ Keycloak Group user thuộc) + danh sách máy dạng tile/list (phải) + nút **Đăng xuất** |

3. **Phiên điều khiển từ xa (`remote.tis`)** — toolbar (`header.tis`) với các nhóm điều khiển:
   chất lượng hình ảnh, ghi chú, file transfer, chụp ảnh màn hình.
4. **Web Admin UI (`public/admin.html`)** — 3 tab: *Người dùng*, *Danh sách group*, *Danh sách
   máy*; mỗi tab có bảng dữ liệu + modal thêm/sửa; tab/nút hiển thị **tùy theo tier** của người
   đang đăng nhập (`applyTierVisibility()`).

### 4.2.2. Thiết kế lớp

Đồ án trình bày chi tiết 3 thành phần chủ đạo nhất, là phần lõi của tính năng kiểm soát truy cập
mà nhóm bổ sung vào RustDesk gốc:

**a) `Ab` / `AbEntry` / `AbPeer`** (`libs/hbb_common/src/config.rs:2452-2578`) — mô hình dữ liệu
Address Book gốc của RustDesk, vẫn dùng làm cơ chế **ghi** (`POST /api/ab`, `updateAb()`); nguồn
dữ liệu **đọc** hiển thị panel Address Book lấy trực tiếp từ `/api/address-books`, không qua
struct này:

```
Ab
├── access_token: String
└── ab_entries: Vec<AbEntry>

AbEntry
├── guid: String
├── name: String
├── tags: Vec<String>
├── tag_colors: String
└── peers: Vec<AbPeer>

AbPeer
├── id: String          // = machines[].rustdesk_id phía gateway
├── hash: String
├── username: String
├── hostname: String
├── platform: String
├── alias: String
└── tags: Vec<String>
```

**b) `UI`** (`src/ui.rs`) — struct triển khai `sciter::EventHandler`, là điểm vào duy nhất cho
mọi lời gọi từ TIS xuống Rust. Phương thức bổ sung quan trọng nhất:

```rust
impl UI {
    fn check_access_blocking(&mut self, rustdesk_id: String) -> String {
        // src/ui.rs:497 — gọi đồng bộ (blocking) tới gateway POST /api/check-access
        // kèm Bearer token nếu có; timeout 800ms.
        // Trả "" (rỗng) = cho phép kết nối; chuỗi != "" = lý do từ chối
        // ("Bạn cần đăng nhập..." / "Bạn không có quyền truy cập máy này").
    }
}
impl sciter::EventHandler for UI {
    sciter::dispatch_script_call! {
        fn get_id();
        fn check_access_blocking(String);   // hàm bổ sung, đăng ký vào dispatch table (dòng 779)
        fn new_remote(String, String, bool);
        // ... 100+ hàm khác (không đổi so với upstream)
    }
}
```

**c) `AuthServer`** — gói khái niệm cho `server.js`, không phải một class Rust nhưng đóng vai trò
tương đương một service lớp domain ở phía gateway. 26 hàm top-level (không dùng `class`, thiết kế
thuần functional), nhóm theo trách nhiệm:

```
AuthServer
├── Data-access (SQLite, data/rocky.db)
│   ├── getAllMachines() / attachGroups()         — gắn groups vào từng machine
│   ├── getMachineById() / getMachineByRustdeskId() / machineExists()
│   ├── insertMachine() / updateMachine() / deleteMachine()
│   ├── setMachineGroups(machineId, groupNames)   — replace toàn bộ group của 1 máy
│   ├── getGroupsMap() / setGroupMachineIds() / deleteGroupMapping()
│   └── getMachinesForGroups(groupNames)          — dùng cho check-access & address-books
├── Keycloak service-account & token
│   ├── getServiceToken()           — client_credentials grant của rustdesk-client
│   ├── getClientUuid(clientId)     — cache theo Map, dùng cho cả 2 client
│   ├── getRolesFromPayload() / getGroupsFromPayload()  — đọc claim JWT (không verify)
│   └── introspectToken() / introspectTokenCached()     — verify thật qua Keycloak, cache 30s
├── Keycloak Admin REST API (realm "rustdesk")
│   ├── keycloakAdminGet() / keycloakAdminRequest()
│   └── listGroups() / createGroup() / deleteGroupById() / getGroupMembers()
│       / addUserToGroup() / removeUserFromGroup()
├── Auth gate
│   ├── requireAdminAuth(req, res, allowedRoles)  — gate theo tier, từng route
│   └── requireSuperAdmin(req, res)               — chỉ admin tối cao
└── Session / housekeeping
    ├── sweepStaleSessions()        — dọn session login desktop-client treo > 10 phút
    ├── buildKeycloakLogoutUrl() / renderAdminAuthError()
    └── httpRequest() / httpPost() / readBody() / parseCookies() / jsonResponse()
```

**Biểu đồ trình tự — Use case "Kết nối có kiểm soát quyền" (`check_access_blocking`):**

```
User      index.tis        UI (Rust)        server.js              rocky.db (SQLite)
 │ click Connect  │               │                 │                       │
 │ ──────────────▶│               │                 │                       │
 │                │ check_access_blocking(id)        │                       │
 │                │ ────────────▶ │                 │                       │
 │                │               │ POST /api/check-access (Bearer token?)  │
 │                │               │ ──────────────▶ │                       │
 │                │               │                 │ máy không có trong DB?│
 │                │               │                 │ ────────────────────▶│
 │                │               │                 │◀──── allowed:true ────│ (fail-open: máy lạ)
 │                │               │                 │ token active? (introspect, cache 30s)
 │                │               │                 │ groups = claim "groups"
 │                │               │                 │ SELECT machine_groups WHERE group IN groups
 │                │               │                 │ ────────────────────▶│
 │                │               │                 │◀──────allowedIds──────│
 │                │               │◀──{allowed, reason?}                    │
 │                │ ◀──── "" hoặc thông báo lỗi      │                       │
 │                │ nếu rỗng → new_remote(id) (kết nối thật)                 │
 │ ◀─── kết nối hoặc msgbox lỗi    │                 │                       │
```

**Biểu đồ trình tự — Use case "Đăng nhập Keycloak (OIDC, desktop client)":**

```
User      ab.tis              server.js                 Keycloak (rustdesk-client)
 │ click Login │                  │                          │
 │ ──────────▶ │ POST /api/auth/init (prompt=login)           │
 │             │ ───────────────▶ │  sinh session_code        │
 │             │ ◀── {url, session_code}                      │
 │             │ handler.open_url(url) ──────────────────────▶│ user login (không 2FA)
 │             │ (UI: "Đang chờ xác thực...")                  │
 │             │ poll mỗi 2s × 60 lần:                         │
 │             │  POST /api/auth/status ────────────────────▶ │ callback redirect
 │             │                  │ ◀── exchange code→token ──│
 │             │ ◀── {access_token} (khi xong)                │
 │             │ lưu access_token (LocalConfig)                │
 │             │ POST /api/address-books (Bearer token) ─────▶│
 │             │   introspectTokenCached() → claim "groups"   │
 │             │ ◀── {machines:[...]} (lọc theo Group trong JWT)│
 │ render AB   │                  │                          │
```

### 4.2.3. Thiết kế cơ sở dữ liệu

ROCKY dùng **SQLite** (qua module built-in `node:sqlite`, không thêm dependency ORM) làm kho lưu
trữ máy trạm + ánh xạ Group↔máy (`data/rocky.db`), kết hợp với **Keycloak làm nguồn dữ liệu
người dùng/Group/role** — lựa chọn phù hợp quy mô dữ liệu nhỏ (vài chục máy, vài chục user),
tránh vận hành thêm một RDBMS server riêng nhưng vẫn có transaction/SQL thật (khác hẳn so với
`data.json` ở giai đoạn đầu dự án).

**Schema thật (`server.js:43-56`):**

```sql
CREATE TABLE machines (
  id          TEXT PRIMARY KEY,
  alias       TEXT NOT NULL DEFAULT '',
  rustdesk_id TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT ''
);
CREATE TABLE machine_groups (
  group_name TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  PRIMARY KEY (group_name, machine_id)
);
CREATE INDEX idx_machine_groups_machine ON machine_groups(machine_id);
```

**Biểu đồ thực thể liên kết (ER) ở mức khái niệm:**

```
┌──────────────┐   N        N   ┌──────────────────┐
│   Machine     │◀──────────────▶│  KeycloakGroup    │  (realm-level, KHÔNG có
├──────────────┤  machine_groups ├──────────────────┤   bảng riêng trong SQLite —
│ id (PK, hex)  │  (SQLite,       │ id (Keycloak UUID)│   chỉ là TEXT so khớp tên,
│ alias         │   so khớp tên,  │ name (PK logic)   │   không FK thật)
│ rustdesk_id   │   không FK)     └─────────┬────────┘
│ note          │                           │
└──────────────┘                            │ N..N (Keycloak quản lý,
                                             │ qua group membership)
                                             ▼
                                      ┌──────────────┐
                                      │ KeycloakUser  │  (lưu trong Keycloak,
                                      ├──────────────┤   không lưu trong SQLite)
                                      │ id (KC UUID)  │
                                      │ username      │
                                      │ email         │
                                      │ enabled       │
                                      └──────┬───────┘
                                             │ N..N (role-mapping,
                                             │ TÁCH BIỆT khỏi Group ở trên)
                                             ▼
                                      ┌──────────────────┐
                                      │ AdminTierRole     │  (client role trên
                                      ├──────────────────┤   rocky-admin)
                                      │ admin             │
                                      │ manage_users      │
                                      │ manage_machines   │
                                      └──────────────────┘
```

- Quan hệ **Machine – KeycloakGroup** là N–N, lưu trực tiếp trong bảng join `machine_groups`
  (PK composite `group_name + machine_id`, không có cột `id` riêng) — không có FK thật từ
  `group_name` sang Keycloak, chỉ so khớp theo chuỗi tên.
- Quan hệ **User – KeycloakGroup** (machine-access) và **User – AdminTierRole** (quyền Admin UI)
  là **2 quan hệ N–N hoàn toàn độc lập**, cùng do Keycloak quản lý nhưng không liên quan dữ liệu
  nhau — 1 user có thể vừa thuộc Group "phong-ke-toan" vừa có `AdminTierRole = manage_machines`,
  2 việc không ảnh hưởng nhau. ROCKY chỉ đọc Group qua claim JWT `groups`
  (`getGroupsFromPayload()`), đọc AdminTierRole qua introspection (`getRolesFromPayload()`),
  không nhân bản dữ liệu user/group/role vào SQLite.

**Đặc điểm vận hành đã ghi nhận (rủi ro thiết kế, không phải lỗi code):**
- `setMachineGroups()`/`setGroupMachineIds()` thực hiện 2 câu SQL `DELETE` rồi `INSERT` **không
  trong 1 transaction** — nếu crash giữa 2 lệnh, mapping tạm thời mất hết cho tới khi admin
  submit lại.
- File `data.json` cũ chỉ được đọc **một lần** lúc khởi động (`migrateFromJsonIfNeeded()`,
  `server.js:58`) nếu bảng `machines` còn rỗng; **không di trú** dữ liệu `roles` cũ (mô hình role
  đơn `admin`/`viewer`/`guest` không có Group tương ứng trong model mới).

---

## 4.3. Xây dựng ứng dụng

### 4.3.1. Thư viện và công cụ sử dụng

| Mục đích | Công cụ / Thư viện | Phiên bản | Địa chỉ URL |
|---|---|---|---|
| Ngôn ngữ lõi | Rust | pin **1.75.0** cho CI (giới hạn ABI Sciter, không dùng `stable`) | https://www.rust-lang.org/ |
| UI Engine | Sciter SDK (`libsciter-gtk.so` Linux / `sciter.dll` Windows / `libsciter.dylib` macOS) | bin tải từ `c-smile/sciter-sdk` | https://sciter.com/ |
| Build / package manager Rust | Cargo | đi kèm Rust toolchain | https://doc.rust-lang.org/cargo/ |
| Quản lý thư viện C/C++ | vcpkg | pin theo `vcpkg.json` (baseline `120deac3...`) | https://github.com/microsoft/vcpkg |
| Codec video | libvpx, libyuv, aom | qua vcpkg | — |
| Codec audio | opus (`magnum-opus`), cpal | crates.io | — |
| Async runtime | tokio | crates.io | https://tokio.rs/ |
| HTTP client (Rust) | reqwest (blocking, dùng trong `check_access_blocking`) | crates.io | https://docs.rs/reqwest |
| Serialize | serde, serde_json | crates.io | https://serde.rs/ |
| Backend Gateway | Node.js — chỉ built-in `http`/`fs`/`crypto`/`querystring`/**`node:sqlite`**, không có npm dependency | 22+ (cần `node:sqlite` built-in) | https://nodejs.org/ |
| Persistence Gateway | SQLite (qua `node:sqlite`, không ORM) | built-in Node.js | — |
| Identity Provider | Keycloak (2FA TOTP built-in, không cần SMTP/SMS) | image `quay.io/keycloak/keycloak` | https://www.keycloak.org/ |
| Đóng gói client | `cargo-bundle` (Linux/macOS), `rustdesk-portable-packer` tự viết (Windows installer) | — | — |
| Đóng gói AppImage | `appimage-builder` (fork `rustdesk-org`) | — | — |
| CI/CD | GitHub Actions (`.github/workflows/build.yml`, 3 job: windows/linux/macos) | — | https://github.com/features/actions |
| Container hóa (build môi trường, không phải deploy gateway) | Docker (`Dockerfile` ở repo root — build container cho Rust client) | — | https://www.docker.com/ |
| Quản lý service Linux (cho client, không phải gateway) | systemd (`res/rustdesk.service` — chạy `rustdesk --service`) | — | — |
| Quản lý mã nguồn | Git | — | https://git-scm.com/ |
| Build hệ thống Linux | GCC, Clang, CMake, Ninja, NASM, YASM | — | — |

### 4.3.2. Kết quả đạt được

> Số liệu đo trực tiếp trên source hiện tại (`wc -l`, `du -sh`, đếm theo regex
> `struct`/`enum`/`impl`/`fn`) tại thời điểm 2026-06-23.

**Sản phẩm đóng gói gồm 3 thành phần độc lập, có thể chạy/triển khai riêng:**

1. **ROCKY Desktop Client** — ứng dụng desktop Rust + Sciter UI (`src/ui/`), đóng vai trò vừa
   *controller* vừa *controlled peer*. Build/đóng gói tự động qua pipeline CI riêng cho 3 nền
   tảng (`.github/workflows/build.yml`, xem `docs/ci-windows-build.md` /
   `docs/ci-linux-macos-build.md`):
   - Windows → installer tự giải nén `rustdesk-{version}-win7-install.exe`
   - Linux → `.deb` và `.AppImage`
   - macOS → `.dmg`
   Ngoài ra có thể chạy trực tiếp ở máy phát triển bằng `cargo run --release`.
2. **ROCKY Gateway (`server.js` + `public/admin.html`)** — service Node.js độc lập (chỉ dùng
   built-in `http`/`fs`/`crypto`/`node:sqlite`, không có npm dependency), vừa là auth proxy đứng
   giữa client và Keycloak, vừa là REST API cho Web Admin UI, vừa là *Policy Decision Point*
   quyết định một user có được kết nối tới một máy cụ thể hay không. Persistence: **SQLite**
   (`data/rocky.db`, 2 bảng `machines`/`machine_groups`), `data.json` cũ chỉ còn được đọc một
   lần để migrate dữ liệu lịch sử.
3. **Cấu hình Keycloak** — 1 realm (`rustdesk`) với 2 client: `rustdesk-client` (SSO cho desktop
   client, phân quyền Address Book theo **Keycloak Group** qua claim JWT `groups`) và
   `rocky-admin` (phân quyền Admin UI theo 3 client role, có **2FA TOTP** bắt buộc riêng cho
   role `admin`).

**Thống kê mã nguồn (đo trực tiếp, không tính `flutter/`, `target/`, `.git`):**

| Thành phần | Số liệu |
|---|---|
| Rust — logic nghiệp vụ (`src/` + `libs/`, loại `flutter*.rs`, `bridge_generated.rs`, `src/lang/`) | 108.628 dòng |
| Rust — bản dịch đa ngôn ngữ (`src/lang/*.rs`, 51 file) | 38.383 dòng |
| **Tổng Rust** (logic + bản dịch) | **147.011 dòng** |
| File Rust lớn nhất | `src/server/connection.rs` — 6.162 dòng |
| Sciter UI — `.tis` (script, 8 file chính) | 6.655 dòng |
| Sciter UI — `.css` | 1.665 dòng |
| Sciter UI — `.html` | 140 dòng |
| `server.js` (Gateway, toàn bộ mới, không npm dependency) | 1.012 dòng |
| `public/admin.html` (Web Admin UI, toàn bộ mới, thuần HTML/CSS/JS) | 992 dòng |
| Tài liệu kỹ thuật project (`docs/*.md` cốt lõi, không tính README/CONTRIBUTING/SECURITY đa ngôn ngữ) | 2.016 dòng |
| Dung lượng toàn bộ mã nguồn (`src` + `libs` + `server.js` + `public` + `docs` + `res`, không tính `target/`, `flutter/`) | ~11,6 MB |

**Thống kê cấu trúc/đơn vị tổ chức code:**

| Thành phần | Số liệu |
|---|---|
| Số `struct` (Rust, tương đương "lớp dữ liệu") | 151 |
| Số `enum` | 23 |
| Số `trait` | 1 |
| Số `impl` block (cài đặt hành vi cho struct/trait) | 543 |
| Số hàm Rust (`fn`, kể cả method) | ~3.023 |
| Số file `.rs` (module) | 277 (226 logic + 51 bản dịch `src/lang/`) |
| Số crate Cargo (gói) trong `libs/` | 8 (`hbb_common`, `scrap`, `enigo`, `clipboard`, `virtual_display`, `remote_printer`, `portable`, `libxdo-sys`) |
| Số crate/binary ở crate gốc | 1 lib (`librustdesk`) + 2 bin phụ (`naming`, `service`) |
| Số hàm Rust expose cho Sciter UI (`dispatch_script_call!`) | 100+ hàm, trong đó có `check_access_blocking` (bổ sung) |
| Số endpoint REST API gateway (`server.js`) | 27 endpoint (Admin: 21 — auth 5, users 8, groups 4, machines 4; Client API: 6) |
| Số hàm top-level trong `server.js` | 26 hàm (không dùng `class`, thiết kế thuần functional) |
| Số file `.tis` Sciter bị chỉnh sửa trực tiếp | `ab.tis`, `index.tis`, `header.tis`, `common.tis`, `msgbox.tis`, `file_transfer.tis` |
| Số ngôn ngữ UI rà soát/dịch | 51 file trong `src/lang/` |

**Dung lượng sản phẩm đóng gói:**

| Sản phẩm | Dung lượng | Ghi chú |
|---|---|---|
| Binary Rust thô đo tại máy phát triển (`target/release/rustdesk`, Linux, đã `strip`) | 41 MB | Build local bằng `cargo build --release`; **chưa** gồm runtime `libsciter-gtk.so` (tải riêng) và **chưa** đóng gói thành `.deb`/`AppImage` |
| `.deb` / `.AppImage` (Linux), `.exe` installer (Windows), `.dmg` (macOS) | *Chưa đo được* | 3 định dạng này chỉ được build trên GitHub Actions runner riêng theo `build.yml`; môi trường phát triển hiện tại chỉ build được binary thô Linux nêu trên |
| `data/rocky.db` (SQLite, persistence Gateway) | 24 KB | Dữ liệu mẫu hiện tại (vài máy + group demo) |
| `public/` (toàn bộ asset Web Admin UI) | 80 KB | Single-page, không build step, không bundler |

**Các tính năng đã hoàn thành (✅) so với RustDesk gốc:**

| # | Tính năng | Trạng thái |
|---|---|---|
| 1 | Rebrand tên ứng dụng (`APP_NAME = "ROCKY"`) + đổi bảng màu sang tông navy/teal, icon riêng | ✅ Hoàn thành |
| 2 | Đặt ngôn ngữ mặc định là Tiếng Việt, dịch đầy đủ các chuỗi UI | ✅ Hoàn thành |
| 3 | Đăng nhập SSO qua Keycloak (OIDC Authorization Code flow) thay cho dialog user/pass cũ | ✅ Hoàn thành |
| 4 | Address Book hiển thị danh sách máy lọc theo **Keycloak Group** (claim JWT `groups`), không còn theo role đơn | ✅ Hoàn thành |
| 5 | Web Admin UI 3 tab (Người dùng / Group / Máy), CRUD đầy đủ, persistence SQLite | ✅ Hoàn thành |
| 6 | Phân quyền Admin UI theo 3 tier (`admin`/`manage_users`/`manage_machines`) trên client `rocky-admin` | ✅ Hoàn thành |
| 7 | **2FA (TOTP)** bắt buộc cho admin tối cao khi đăng nhập Admin UI (Keycloak Conditional OTP) | ✅ Hoàn thành (chỉ tier `admin`, chưa mở rộng cho 2 tier mới — xem mục Hạn chế) |
| 8 | Verify token bằng **introspection** qua Keycloak cho cả luồng client (`check-access`/`address-books`) và Admin UI, thay decode JWT không kiểm chữ ký | ✅ Hoàn thành |
| 9 | Đăng xuất kèm revoke token tại Keycloak (desktop client) / global SSO logout (Admin UI) | ✅ Hoàn thành |
| 10 | Chặn kết nối tới máy không được phân quyền ngay tại tầng Rust (đồng bộ, trước khi mở kết nối) | ✅ Hoàn thành |
| 11 | CI build tự động đóng gói cho cả 3 nền tảng Windows/Linux/macOS (`build.yml`) | ✅ Hoàn thành |
| 12 | Tùy chọn đăng nhập Google qua Identity Provider của Keycloak | 📄 Đã có hướng dẫn cấu hình (`.claude/plans/keycloak-google-login.md`), cần thực hiện thủ công trên Keycloak Console |
| 13 | Đóng gói toàn hệ thống (Docker Compose cho Keycloak + hbbs/hbbr + gateway, baked-in server config cho client) | 📝 Đã lập kế hoạch chi tiết (`.claude/plans/optimize-and-package.md`), **chưa triển khai** — hiện tại gateway chạy trực tiếp bằng `node server.js`, cấu hình hardcode trong source, chưa có `.env`/Docker Compose/systemd unit riêng cho gateway |

### 4.3.3. Minh họa các chức năng chính

> Khi hoàn thiện báo cáo, chèn ảnh chụp màn hình thực tế tương ứng với từng mô tả dưới đây.

**a) Đăng nhập qua Keycloak (Address Book).** Người dùng vào tab Address Book, nhấn **Đăng
nhập** → trình duyệt mặc định mở trang đăng nhập Keycloak (do `prompt=login` nên luôn yêu cầu
nhập lại thông tin, không tự SSO ngầm theo session cũ) → sau khi xác thực thành công, ứng dụng
tự động polling và nhận `access_token`, hiển thị danh sách máy được phép truy cập.

**b) Hiển thị Address Book theo phân quyền Group.** Hai user thuộc Keycloak Group khác nhau sẽ
thấy danh sách máy khác nhau — user thuộc Group "phong-ke-toan" chỉ thấy các máy được gán cho
Group này trong tab **Danh sách group** của Admin UI; panel filter bên trái Address Book (label
vẫn giữ "Tags" theo quy ước UI gốc của RustDesk) dựng từ danh sách Group user đang thuộc.

**c) Chặn kết nối trái phép.** Khi người dùng nhập trực tiếp ID của một máy không thuộc Group của
họ (kể cả khi không qua Address Book), hệ thống hiển thị msgbox "Bạn không có quyền truy cập máy
này" và không tiến hành kết nối; nếu chưa đăng nhập, hiển thị "Bạn cần đăng nhập để kết nối máy
này"; nếu máy không nằm trong SQLite hoặc gateway offline/timeout (800ms), hệ thống áp dụng chính
sách **fail-open** (vẫn cho kết nối) để tránh chặn nhầm khi hạ tầng gặp sự cố.

**d) Đăng nhập Admin UI có 2FA (admin tối cao).** Khi user có role `admin` đăng nhập, sau bước
nhập đúng username/password, Keycloak yêu cầu thêm mã OTP 6 số từ app authenticator (lần đầu hiện
QR code đăng ký); user chỉ có `manage_users`/`manage_machines` đăng nhập thẳng, không bị bắt OTP.

**e) Web Admin UI — Tab Danh sách máy.** Bảng CRUD với các cột Alias / RustDesk ID / Ghi chú /
Group; modal "Sửa" cho phép chọn lại các Group được áp dụng cho máy đó. CRUD máy thuộc tier
`manage_machines`.

**f) Web Admin UI — Tab Danh sách group.** Mỗi Group hiển thị 1 dòng trong bảng chung, gồm danh
sách user và danh sách máy thuộc Group; có thể thêm/gỡ trực tiếp từ dòng. Tạo/xoá Group là độc
quyền admin tối cao; map Group↔máy thuộc tier `manage_machines`.

**g) Web Admin UI — Tab Người dùng.** Bảng user lấy trực tiếp từ Keycloak (tên, email, Group,
**Role admin-tier**, trạng thái enable/disable); hỗ trợ tạo mới (kèm gán Group/Role ngay lúc tạo,
tuỳ quyền người tạo), xóa, gán/thu hồi Group, bật/tắt tài khoản. Gán role admin-tier cho người
khác là độc quyền admin tối cao.

---

## 4.4. Kiểm thử

Nhóm áp dụng kết hợp **kiểm thử hộp đen (black-box)** ở mức API/HTTP (dùng `curl`/Postman để gọi
trực tiếp các endpoint của gateway) và **kiểm thử thủ công trên giao diện (manual UI testing)**
cho 5 chức năng quan trọng nhất của đồ án.

### 4.4.1. Chức năng: Đăng nhập SSO qua Keycloak (desktop client)

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-01 | Nhấn Login, đăng nhập đúng tài khoản thuộc 1 Keycloak Group có máy | Trình duyệt mở trang KC; sau login, ứng dụng nhận `access_token`, hiển thị đúng danh sách máy theo Group | ✅ Đạt |
| TC-02 | Đăng nhập tài khoản thuộc Group khác | Chỉ hiển thị các máy được gán cho Group đó, không hiển thị máy của Group đầu tiên | ✅ Đạt |
| TC-03 | Nhấn **Hủy** trong lúc đang chờ xác thực trình duyệt | Dừng polling ngay, quay lại nút Login | ✅ Đạt |
| TC-04 | Hết thời gian chờ (quá 60 lần poll × 2 giây = 120 giây không xác thực) | Hiển thị lỗi "Login timeout" | ✅ Đạt |
| TC-05 | Nhấn Đăng xuất | Xóa token cục bộ ngay (UI phản hồi tức thì), gọi `/api/auth/logout` revoke token phía Keycloak | ✅ Đạt |
| TC-06 | Bỏ ngang luồng login (đóng app giữa lúc redirect Keycloak) | Entry `sessions` Map tự dọn sau 10 phút (`sweepStaleSessions()`), không leak memory vô hạn | ✅ Đạt (đã fix 2026-06-22) |

### 4.4.2. Chức năng: Address Book — hiển thị danh sách máy theo phân quyền Group

Kỹ thuật: kiểm thử hộp đen kết hợp kiểm thử phân vùng tương đương (equivalence partitioning)
trên số lượng Group user thuộc.

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-07 | User thuộc 1 Group, Group có ≥ 1 máy | Address Book hiển thị đúng danh sách máy của Group đó, không hiển thị máy của Group khác | ✅ Đạt |
| TC-08 | User thuộc 2 Group khác nhau | Address Book hiển thị tổng hợp máy của cả 2 Group (union), không bị trùng lặp bản ghi | ✅ Đạt |
| TC-09 | User đã đăng nhập nhưng không thuộc Group nào | Danh sách máy rỗng, không hiển thị lỗi crash; panel "Tags" bên trái không có mục nào | ✅ Đạt |
| TC-10 | Click vào tên Group trong panel lọc "Tags" bên trái | Chỉ hiển thị máy thuộc Group đó; click "Tất cả" trả về toàn bộ danh sách | ✅ Đạt |
| TC-11 | Admin gán thêm máy mới vào Group; user đăng xuất rồi đăng nhập lại | Máy mới xuất hiện đúng trong danh sách, không cần khởi động lại ứng dụng | ✅ Đạt |

### 4.4.3. Chức năng: Đăng nhập Admin UI theo tier + 2FA

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-12 | Đăng nhập với role `admin`, chưa từng cấu hình OTP | Hiện QR code đăng ký OTP, sau khi xác nhận mã 6 số mới vào được Admin UI | ✅ Đạt |
| TC-13 | Đăng nhập với role `admin`, đã có OTP | Hiện form nhập mã OTP hiện tại, đúng mã mới qua | ✅ Đạt |
| TC-14 | Đăng nhập với role `manage_users` hoặc `manage_machines` | Vào được Admin UI **không** bị bắt OTP, tab/nút hiển thị đúng theo tier (`applyTierVisibility()`) | ✅ Đạt (ghi nhận là điểm chưa siết — xem Hạn chế) |
| TC-15 | Đăng nhập với user không có role admin-tier nào | 403 "Tài khoản không có quyền quản trị" | ✅ Đạt |
| TC-16 | `manage_users` thử gọi `POST /admin/api/users/:id/admin-roles` | Bị chặn (`requireSuperAdmin`), chỉ admin tối cao mới gán được role admin-tier | ✅ Đạt |

### 4.4.4. Chức năng: Web Admin UI — quản lý Group ↔ Machine

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-17 | `GET /admin/api/groups` | Trả đúng danh sách Group kèm `machines`/`users` đã enrich | ✅ Đạt |
| TC-18 | `PUT /admin/api/groups` với mapping mới (tier `manage_machines` thực hiện) | SQLite `machine_groups` cập nhật đúng (replace toàn bộ); `/api/address-books` của user thuộc Group đó trả đúng danh sách mới | ✅ Đạt |
| TC-19 | Tạo / sửa / xóa machine qua `POST`/`PUT`/`DELETE /admin/api/machines` | Machine xuất hiện/cập nhật/biến mất khỏi cả bảng UI và SQLite; khi xóa, máy bị gỡ khỏi mọi Group liên quan | ✅ Đạt |
| TC-20 | Admin tối cao tạo/xóa Group; tier `manage_machines` thử tạo/xóa Group | Tạo/xóa Group chỉ admin tối cao thực hiện được (`requireSuperAdmin`); tier khác bị 403 | ✅ Đạt |
| TC-21 | Logout Admin UI, mở lại `/admin` | `admin_session` cookie hết hiệu lực sau 8h hoặc sau logout, phải đăng nhập lại | ✅ Đạt |

### 4.4.5. Chức năng: Web Admin UI — quản lý Người dùng

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-22 | Tier `manage_users` tạo user mới với username/email hợp lệ | User xuất hiện trong bảng, Keycloak tạo thành công; mật khẩu tạm được đặt đúng | ✅ Đạt |
| TC-23 | Tier `manage_users` gán user vào Group | Group hiển thị đúng trong cột Group của user; lần đăng nhập kế tiếp của user đó, Address Book hiển thị máy thuộc Group | ✅ Đạt |
| TC-24 | Tier `manage_users` gỡ user khỏi Group | User mất quyền truy cập máy của Group đó ngay lần đăng nhập kế tiếp; danh sách Group trong bảng cập nhật ngay | ✅ Đạt |
| TC-25 | Tier `manage_users` tắt tài khoản (toggle Enabled → disabled) | Keycloak từ chối đăng nhập cho user bị tắt; nút toggle đổi màu/trạng thái trong bảng | ✅ Đạt |
| TC-26 | Tier `manage_users` bật lại tài khoản đã bị tắt | User đăng nhập lại được; trạng thái bảng phản ánh đúng | ✅ Đạt |
| TC-27 | Tier `manage_users` xóa user | User biến mất khỏi bảng và Keycloak; các Group mapping cũng được dọn phía Keycloak | ✅ Đạt |
| TC-28 | Admin tối cao gán role `manage_users` cho user bình thường | User đó đăng nhập được Admin UI; chỉ thấy tab/nút theo tier `manage_users`; không thấy tab quản lý máy | ✅ Đạt |

### 4.4.6. Tổng kết kết quả kiểm thử

- Tổng số trường hợp kiểm thử đã thực hiện: **28** (API + manual UI), phân bổ qua 5 chức năng,
  tất cả đạt yêu cầu.
- Các trường hợp kiểm thử phụ (dịch ngôn ngữ, đổi theme, tìm kiếm trong bảng) được kiểm thử
  nhanh qua thao tác trực tiếp trên UI trong quá trình phát triển, không lập thành bảng riêng
  do mức độ rủi ro thấp.
- **Hạn chế còn tồn đọng** (ghi nhận trung thực để phần "Hướng phát triển" sử dụng):
  - **2FA chỉ bind với role `admin`**, chưa mở rộng cho `manage_users`/`manage_machines` sau khi
    model chuyển từ 1-role sang 3-tier — 2 tier mới có quyền quản trị thật (CRUD user/máy) nhưng
    đăng nhập không bị bắt OTP. Đây là gap đã được ghi nhận, chưa có quyết định có cố ý giữ vậy
    hay cần siết lại.
  - 1 service account duy nhất (`rustdesk-client`) được dùng cho **mọi** lệnh gọi Keycloak Admin
    REST API (cả của Admin UI và của machine-access) — lộ `CLIENT_SECRET` ảnh hưởng cả 2 hệ.
  - Chưa kiểm thử `POST /api/address-books` với JWT thật phát sinh từ một phiên đăng nhập Google
    Social Login đầy đủ (tính năng #12 ở mục 4.3.2 mới có hướng dẫn, chưa cấu hình thật).

---

## 4.5. Triển khai

**Mô hình triển khai thử nghiệm hiện tại** — 3 tiến trình chạy thủ công, **chưa container hóa**
(khác với mô tả "Docker Compose/.env/systemd" ở bản trước của chương này — các file đó **không
tồn tại** trong repo hiện tại; đây là kế hoạch tương lai, xem cuối mục):

```
┌──────────────────────────────────────────────┐
│  Máy chủ / VM nội bộ (ví dụ 192.168.1.16)      │
│                                                │
│  ┌──────────────────┐   ┌───────────────────┐ │
│  │ Keycloak           │   │ server.js          │ │
│  │ (docker run thủ công)│  │ (chạy trực tiếp    │ │
│  │ port 8080           │  │  `node server.js`,  │ │
│  └──────────────────┘   │  cấu hình hardcode  │ │
│                          │  trong source)      │ │
│                          │ port 3000, bind     │ │
│                          │ 0.0.0.0              │ │
│                          └───────────────────┘ │
└──────────────────────────────────────────────┘
              ▲                      ▲
              │ HTTP                  │ HTTP
   ┌──────────┴──────────┐  ┌────────┴─────────┐
   │ ROCKY Desktop Client  │  │ Trình duyệt admin │
   │ (build CI hoặc        │  │ (web admin UI)    │
   │  cargo run --release) │  │                   │
   └──────────────────────┘  └──────────────────┘
```

**Cấu hình triển khai thực tế:**

- **Keycloak**: chạy qua Docker (`quay.io/keycloak/keycloak`, chế độ `start-dev` cho môi trường
  thử nghiệm), 1 realm `rustdesk`, 2 client:
  - `rustdesk-client` (confidential, service account có quyền `view-users`, `manage-users`,
    `view-realm`, `query-groups`; protocol mapper "Group Membership" → Token Claim Name `groups`).
  - `rocky-admin` (confidential, 3 client role `admin`/`manage_users`/`manage_machines`, Browser
    Flow override `browser-admin-otp` bắt 2FA cho riêng role `admin`).
- **ROCKY Gateway**: chạy trực tiếp bằng `node server.js` — **không có `.env`**, mọi cấu hình
  (`VM_HOST`, `KEYCLOAK_HOST`, `CLIENT_SECRET`, `ADMIN_CLIENT_SECRET`...) hardcode trực tiếp
  trong source (`server.js:9-26`); `.listen(3000, '0.0.0.0', ...)` để chấp nhận kết nối từ máy
  khác trong mạng (đã sửa từ `127.0.0.1` ban đầu để client build CI từ máy khác kết nối được).
  Không có Docker image, không có systemd unit riêng cho gateway trong repo hiện tại.
- **ROCKY Desktop Client**: build release bằng `cargo build --release` (local) hoặc qua pipeline
  CI (`.github/workflows/build.yml`) cho cả 3 nền tảng; mọi URL gọi gateway/Keycloak hardcode
  theo địa chỉ VM thật trong `server.js`, `src/ui.rs`, `src/ui/ab.tis` — đổi địa chỉ VM phải sửa
  đồng bộ ở cả các vị trí này.

**Quy trình triển khai thử nghiệm (đã thực hiện trên máy phát triển):**

```bash
# 1. Keycloak
docker run -p 8080:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev

# 2. ROCKY Gateway (không cần npm install — chỉ dùng built-in Node.js)
node server.js
# http://<VM_HOST>:3000/admin

# 3. ROCKY Desktop Client
cargo run --release
```

**Kết quả triển khai thử nghiệm:**

- Hệ thống đã được triển khai và kiểm thử trên môi trường phát triển + 1 VM nội bộ riêng (tách
  client build CI khỏi máy chạy Keycloak/gateway), với 1 realm Keycloak, nhiều Keycloak Group
  (machine-access) và 3 admin-tier role test.
- Thời gian phản hồi của endpoint `/api/check-access` nằm trong giới hạn timeout 800ms đặt ra
  phía client, đảm bảo không gây cảm giác trễ rõ rệt khi người dùng nhấn kết nối; kết quả
  introspection được cache 30s để không cộng thêm latency Keycloak vào mỗi lần kiểm tra.
- **Chưa container hóa / chưa production-ready**: kế hoạch `.claude/plans/optimize-and-package.md`
  (v3) đã thiết kế chi tiết việc đóng gói toàn hệ thống (Keycloak + **hbbs/hbbr tự host** + ROCKY
  Gateway) qua Docker Compose, chuyển cấu hình hardcode sang `.env`, và cơ chế "bake" sẵn cấu hình
  server tự host vào client qua binary `naming`/`src/custom_server.rs` (để cài xong tự kết nối,
  không cần người dùng tự nhập IP) — **đây là kế hoạch, chưa được triển khai thật** trong repo
  hiện tại.
- Đồ án chưa triển khai trên môi trường production có nhiều người dùng đồng thời; số liệu về khả
  năng chịu tải, số lượng truy cập thực tế và phản hồi người dùng cuối **chưa có** do giới hạn về
  thời gian và hạ tầng thử nghiệm — đây là điểm cần bổ sung nếu mở rộng đồ án thành sản phẩm vận
  hành thật.
