# CHƯƠNG 4: THIẾT KẾ VÀ XÂY DỰNG ỨNG DỤNG

> Nội dung chương này tổng hợp từ toàn bộ tài liệu đã ghi nhận trong quá trình phát triển dự án **ROCKY** (fork của RustDesk, bổ sung SSO Keycloak, phân quyền theo role và Web Admin UI): `CLAUDE.md`, `AGENTS.md`, `.claude/DATN.md`, `.claude/SUMMARY.md`, `know1006.md`, `baocao.md` và các plan trong `.claude/plans/`.
> Các hình minh họa (biểu đồ gói, biểu đồ lớp, biểu đồ trình tự, ảnh chụp màn hình) cần được sinh viên vẽ lại bằng công cụ UML (draw.io, PlantUML, StarUML...) và chụp màn hình thực tế từ ứng dụng khi hoàn thiện báo cáo — nội dung dưới đây mô tả đầy đủ thông tin cần thể hiện trong các hình đó.

---

## 4.1. Thiết kế kiến trúc

### 4.1.1. Lựa chọn kiến trúc phần mềm

ROCKY được xây dựng dựa trên kiến trúc **client – gateway – identity provider**, kết hợp giữa kiến trúc phân lớp (layered architecture) ở phía client và kiến trúc hướng dịch vụ (service-oriented) ở phía backend:

- **Lớp Client (Desktop App)**: ứng dụng Rust + Sciter UI, đóng vai trò vừa là *controller* (máy điều khiển) vừa là *controlled peer* (máy bị điều khiển), tùy theo phiên kết nối.
- **Lớp Gateway**: một service Node.js độc lập (`server.js`) đóng vai trò *Backend-for-Frontend* — vừa là reverse proxy xác thực (auth proxy) đứng giữa client và Keycloak, vừa là REST API server phục vụ Web Admin UI, vừa giữ vai trò *Policy Decision Point* để quyết định một user có được phép kết nối tới một máy cụ thể hay không.
- **Lớp Identity Provider**: Keycloak, đóng vai trò xác thực tập trung (SSO) và là nguồn chân lý (source of truth) cho danh sách user, role.
- **Lớp lưu trữ**: `data.json` — lưu ánh xạ giữa máy (`machines`) và role (`roles`), thay cho một RDBMS truyền thống vì quy mô dữ liệu nhỏ và không cần truy vấn phức tạp.

So với RustDesk gốc (chỉ có 2 lớp: Client ↔ Rendezvous/Relay server), ROCKY chèn thêm một lớp gateway trung gian giữa Client và Identity Provider để giải quyết bài toán **kiểm soát truy cập tập trung theo vai trò (RBAC)** mà RustDesk gốc không có. Đây là điểm cải tiến cốt lõi của đồ án so với kiến trúc lý thuyết/sản phẩm gốc.

```
┌─────────────────────────────┐
│   ROCKY Desktop Client       │   (Rust + Sciter UI)
└───────────────┬───────────────┘
                │ HTTP (localhost:3000)
┌───────────────▼───────────────┐
│   server.js — Gateway Layer   │   (Node.js, BFF + PDP)
│   - /admin/*      Admin UI    │
│   - /api/auth/*   Auth proxy  │
│   - /api/address-books        │
│   - /api/check-access         │
└──────┬─────────────────┬──────┘
       │                 │
┌──────▼──────┐   ┌──────▼──────┐
│  Keycloak   │   │ data.json   │
│  (SSO/IdP)  │   │ (machines + │
│             │   │  roles map) │
└─────────────┘   └─────────────┘
```

### 4.1.2. Thiết kế tổng quan

Sơ đồ gói (package diagram) của ROCKY được chia theo 4 tầng, tuân thủ nguyên tắc tầng dưới không phụ thuộc tầng trên và không phụ thuộc bỏ qua tầng:

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
│  ui_interface,   │   │   auth proxy,     │
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
│ data.json  /  Keycloak (external systems)   │
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
| `server` (Node.js gateway) | `server.js`: auth proxy với Keycloak, REST API cho Admin UI, endpoint kiểm soát truy cập |
| `public` | `admin.html` — giao diện quản trị web (SPA, không dùng framework) |

Phụ thuộc giữa các gói: `src.ui` → `src.ui_*` → `src.client`/`src.server` → `libs.hbb_common`; gói `server` (Node.js) và `public` độc lập hoàn toàn về runtime với phần Rust, chỉ giao tiếp qua HTTP — đây là lý do tách ROCKY thành 2 tiến trình runtime riêng biệt (Rust process + Node.js process) thay vì nhúng logic xác thực vào lõi Rust.

### 4.1.3. Thiết kế chi tiết gói

**Nhóm gói "Address Book & Access Control"** — nhóm gói trọng tâm mà đồ án bổ sung thêm so với RustDesk gốc:

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
│  blocking()     │ /api/  │                        │    DataStore)
└────────────────┘ check- └──────────┬────────────┘
                    access            │ ánh xạ role → máy
                                      ▼
                            ┌──────────────────┐
                            │  DataStore         │
                            │  (data.json:       │
                            │   machines, roles) │
                            └──────────────────┘
```

Quan hệ giữa các thành phần:
- `ab.tis` **kết hợp (association)** với hàm Rust `handler.*` thông qua cơ chế `dispatch_script_call!` — không phải kế thừa, chỉ là gọi hàm.
- `UI::check_access_blocking()` (Rust) **phụ thuộc (dependency)** vào `reqwest::blocking::Client` để gọi đồng bộ tới gateway — lựa chọn này (thay vì `httpRequest` bất đồng bộ trong TIS) là điểm thiết kế quan trọng: TIS `httpRequest` không chặn luồng thực thi, nên không thể dùng để *ngăn* kết nối trước khi nó xảy ra; phải đưa logic chặn xuống Rust dưới dạng gọi đồng bộ.
- `AuthServer` (`server.js`) **hợp thành (composition)** với `DataStore` — `DataStore` không có ý nghĩa tồn tại độc lập ngoài `AuthServer`.
- `AuthServer` **phụ thuộc** vào Keycloak Admin REST API qua `KeycloakClient` (lấy service-account token, gọi `/admin/realms/...`).

---

## 4.2. Thiết kế chi tiết

### 4.2.1. Thiết kế giao diện

**Đặc tả màn hình**: ứng dụng desktop chạy trên Linux/Windows/macOS thông qua engine Sciter, độ phân giải linh hoạt (responsive theo kích thước cửa sổ), hỗ trợ chế độ sáng/tối (light/dark mode) thông qua `@media (prefers-color-scheme: dark)` trong `common.css`, hệ màu RGB 24-bit.

**Chuẩn hóa thiết kế** (rebrand ROCKY + blue theme — đã thực hiện trong commit liên quan `a4599f7da`, `1462e5738`):

| Biến CSS | Vai trò | Giá trị |
|---|---|---|
| `accent` | Màu nhấn chính (nút active, link, viền focus) | `#1565C0` |
| `button` | Màu nút bấm | `#42A5F5` |
| `menu-hover` | Màu nền khi hover menu item | `#E3F2FD` |
| `dark-red` (dùng làm navy) | Màu nhấn phụ / progress / dialog | `#0D47A1` |

Quy ước bố cục: thông báo lỗi hiển thị dạng banner đỏ/vàng phía trên khu vực nội dung (ví dụ banner cảnh báo khi Keycloak offline trong Admin UI); trạng thái đang xử lý hiển thị bằng spinner; xác nhận hành động nguy hiểm (xóa user, xóa máy, xóa role) dùng `msgbox` dạng confirm.

**Các màn hình chính:**

1. **Màn hình chính (`index.tis`)** — danh sách peer gần đây, thanh nhập ID kết nối, menu Settings/Login.
2. **Tab Address Book (`ab.tis`)** — 5 trạng thái UI tùy theo tiến trình đăng nhập:

| Điều kiện | Hiển thị |
|---|---|
| Chưa có `access_token`, không lỗi, không chờ | Nút **Đăng nhập** |
| `abLoading = true` | Spinner |
| `abError != ""` | Thông báo lỗi + nút **Thử lại** |
| `abWaitingBrowser = true` | "Đang chờ xác thực trên trình duyệt..." + nút **Hủy** |
| Đã đăng nhập, có dữ liệu | Bộ lọc tag (trái) + danh sách máy dạng tile/list (phải) + nút **Đăng xuất** |

3. **Phiên điều khiển từ xa (`remote.tis`)** — toolbar (`header.tis`) với các nhóm điều khiển: chất lượng hình ảnh, ghi chú, file transfer, chụp ảnh màn hình.
4. **Web Admin UI (`public/admin.html`)** — 3 tab: *Người dùng*, *Danh sách role*, *Danh sách máy*; mỗi tab có bảng dữ liệu + modal thêm/sửa.

### 4.2.2. Thiết kế lớp

Đồ án trình bày chi tiết 3 thành phần chủ đạo nhất, là phần lõi của tính năng kiểm soát truy cập theo role mà nhóm bổ sung vào RustDesk gốc:

**a) `Ab` / `AbEntry` / `AbPeer`** (`libs/hbb_common/src/config.rs`) — mô hình dữ liệu Address Book gốc của RustDesk, được tái sử dụng làm khung hiển thị cho danh sách máy lấy từ gateway:

```
Ab
├── access_token: String
└── ab_entries: Vec<AbEntry>

AbEntry
├── guid: String
├── name: String
├── tags: Vec<String>
├── tag_colors: HashMap<String, String>
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

**b) `UI`** (`src/ui.rs`) — struct triển khai `sciter::EventHandler`, là điểm vào duy nhất cho mọi lời gọi từ TIS xuống Rust. Phương thức bổ sung quan trọng nhất:

```rust
impl UI {
    fn check_access_blocking(&mut self, rustdesk_id: String) -> String {
        // Gọi đồng bộ (blocking) tới gateway POST /api/check-access
        // kèm Bearer token nếu có; timeout 800ms.
        // Trả "" (rỗng) = cho phép kết nối; chuỗi != "" = lý do từ chối.
    }
}
impl sciter::EventHandler for UI {
    sciter::dispatch_script_call! {
        fn get_id();
        fn check_access_blocking(String);   // hàm mới đăng ký vào dispatch table
        fn new_remote(String, String, bool);
        // ... 100+ hàm khác (không đổi so với upstream)
    }
}
```

**c) `AuthServer`** — gói khái niệm cho `server.js`, không phải một class Rust nhưng đóng vai trò tương đương một service lớp domain ở phía gateway. Các "phương thức" chính (hàm Node.js) là handler của từng route, dùng chung 2 thành phần helper:

```
AuthServer
├── getServiceToken()        — lấy/refresh Keycloak service-account token
├── getClientUuid()          — cache UUID của client rustdesk-client
├── decodeJwtPayload(token)  — decode JWT (không verify signature)
├── getRolesFromPayload()    — trích realm_access.roles + resource_access[...].roles
├── getMachinesForRoles()    — tra cứu machines theo roles từ data.json
├── loadData() / saveData()  — đọc/ghi data.json, có cache in-memory
└── keycloakAdminRequest()   — gọi Keycloak Admin REST API
```

**Biểu đồ trình tự — Use case "Kết nối có kiểm soát quyền" (`createNewConnect`):**

```
User          index.tis        UI (Rust)        server.js         Keycloak/data.json
 │  click Connect   │               │                 │                  │
 │ ───────────────▶ │               │                 │                  │
 │                  │ check_access_blocking(id)        │                  │
 │                  │ ────────────▶ │                 │                  │
 │                  │               │ POST /api/check-access            │
 │                  │               │ ──────────────▶ │                  │
 │                  │               │                 │ decode JWT, tra  │
 │                  │               │                 │ cứu role→machine │
 │                  │               │                 │ ───────────────▶ │
 │                  │               │                 │ ◀─────────────── │
 │                  │               │ ◀────── {allowed:true/false,      │
 │                  │               │           reason}                  │
 │                  │ ◀──── "" hoặc thông báo lỗi      │                  │
 │                  │ nếu rỗng → new_remote(id) (kết nối thật)            │
 │ ◀─── kết nối hoặc msgbox lỗi      │                 │                  │
```

**Biểu đồ trình tự — Use case "Đăng nhập Keycloak (OIDC)":**

```
User      ab.tis              server.js                 Keycloak
 │ click Login │                  │                          │
 │ ──────────▶ │ POST /api/auth/init                          │
 │             │ ───────────────▶ │  tạo session_code         │
 │             │ ◀── {url, session_code}                      │
 │             │ handler.open_url(url) ──────────────────────▶│ user login
 │             │ (UI: "Đang chờ xác thực...")                  │
 │             │ poll mỗi 2s × 60 lần:                         │
 │             │  POST /api/auth/status ────────────────────▶ │ callback redirect
 │             │                  │ ◀── exchange code→token ──│
 │             │ ◀── {access_token} (khi xong)                │
 │             │ lưu access_token (LocalConfig)                │
 │             │ POST /api/address-books (Bearer token) ─────▶│
 │             │ ◀── {machines:[...]} (lọc theo role trong JWT)│
 │ render AB   │                  │                          │
```

### 4.2.3. Thiết kế cơ sở dữ liệu

ROCKY không dùng RDBMS truyền thống mà dùng **file JSON làm kho lưu trữ cấu hình** (`data.json`), kết hợp với **Keycloak làm nguồn dữ liệu người dùng** (user, credential, role) — đây là lựa chọn thiết kế phù hợp với quy mô dữ liệu nhỏ (vài chục máy, vài chục user) và tránh phải vận hành thêm một DBMS.

**Biểu đồ thực thể liên kết (ER) ở mức khái niệm:**

```
┌──────────────┐        N      N      ┌──────────────┐
│   Machine     │◀────────────────────▶│     Role      │
├──────────────┤   roles[name] chứa    ├──────────────┤
│ id (PK, hex)  │   mảng machine.id     │ name (PK)     │
│ alias         │                       └──────┬───────┘
│ rustdesk_id   │  tha
                            │ N
│ tag           │                              │
│ note          │                              │ 1..N (Keycloak quản lý)
└──────────────┘                              ▼
                                        ┌──────────────┐
                                        │     User      │  (lưu trong Keycloak,
                                        ├──────────────┤   không lưu trong data.json)
                                        │ id (KC UUID)  │
                                        │ username      │
                                        │ email         │
                                        │ enabled       │
                                        │ client roles  │──┐
                                        └──────────────┘   │ N..N qua
                                                            │ resource_access
                                                            ▼
                                                      (role name)
```

- Quan hệ **Machine – Role** là N–N, lưu trực tiếp dưới dạng `roles[roleName] = [machineId, ...]` trong `data.json` (không cần bảng trung gian vì không có thuộc tính trên quan hệ).
- Quan hệ **User – Role** là N–N nhưng được Keycloak quản lý hoàn toàn (client role mapping của client `rustdesk-client`); ROCKY chỉ đọc thông tin này qua JWT (`resource_access.rustdesk-client.roles[]`) hoặc qua Keycloak Admin REST API, không nhân bản dữ liệu user.

**Cấu trúc lưu trữ thực tế (`data.json`):**

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
    "admin":  ["a1b2c3d4e5f6g7h8"],
    "viewer": ["a1b2c3d4e5f6g7h8"]
  }
}
```

| Trường | Mô tả |
|---|---|
| `machines[].id` | Khóa chính nội bộ (hex, sinh ngẫu nhiên), dùng để map vào `roles` |
| `machines[].rustdesk_id` | ID thật của peer RustDesk — dùng để client kết nối |
| `machines[].tag` | Nhãn nhóm, dùng làm bộ lọc trong tab Address Book |
| `roles[name]` | Mảng các `machine.id` mà role đó được phép truy cập |

File được tự động **migrate** khi server khởi động nếu phát hiện cấu trúc cũ (mô hình `books`/`peers` ở các phiên bản đầu của đồ án), đảm bảo không mất dữ liệu khi nâng cấp schema.

---

## 4.3. Xây dựng ứng dụng

### 4.3.1. Thư viện và công cụ sử dụng

| Mục đích | Công cụ / Thư viện | Phiên bản | Địa chỉ URL |
|---|---|---|---|
| Ngôn ngữ lõi | Rust | 1.x (edition 2021) | https://www.rust-lang.org/ |
| UI Engine | Sciter SDK (`libsciter-gtk.so`) | bin.lnx x64 | https://sciter.com/ |
| Build / package manager Rust | Cargo | đi kèm Rust toolchain | https://doc.rust-lang.org/cargo/ |
| Quản lý thư viện C/C++ | vcpkg | 2023.04.15 | https://github.com/microsoft/vcpkg |
| Codec video | libvpx, libyuv, aom | qua vcpkg | — |
| Codec audio | opus (`magnum-opus`), cpal | crates.io | — |
| Async runtime | tokio | crates.io | https://tokio.rs/ |
| HTTP client (Rust) | reqwest (blocking) | crates.io | https://docs.rs/reqwest |
| Serialize | serde, serde_json | crates.io | https://serde.rs/ |
| Backend Gateway | Node.js (built-in `http`, `fs`, `crypto`) — **không dùng npm dependency** | 18+/20+ | https://nodejs.org/ |
| Identity Provider | Keycloak | latest (Docker: `quay.io/keycloak/keycloak`) | https://www.keycloak.org/ |
| Container hóa | Docker / Docker Compose | — | https://www.docker.com/ |
| Quản lý service Linux | systemd | — | — |
| IDE | VS Code / Eclipse (tùy chọn) | — | — |
| Quản lý mã nguồn | Git | — | https://git-scm.com/ |
| Build hệ thống Linux | GCC, Clang, CMake, Ninja, NASM, YASM | — | — |

### 4.3.2. Kết quả đạt được

**Sản phẩm đóng gói gồm 3 thành phần độc lập có thể chạy/triển khai riêng:**

1. **ROCKY Desktop Client** — binary Rust + thư viện Sciter, đóng gói thành `.deb` (Linux), `.exe`/`.msi` (Windows tham khảo build script gốc), hoặc chạy trực tiếp qua `cargo run --release`.
2. **ROCKY Gateway (`server.js` + `public/`)** — chạy độc lập bằng `node server.js`, có thể đóng gói thành Docker image (`docker/gateway/Dockerfile`, base `node:22-alpine`) hoặc cài làm service `systemd` (`res/rocky-gateway.service`).
3. **Cấu hình Keycloak** — realm `rustdesk`, client `rustdesk-client`, có thể tự động hóa qua Docker Compose với realm import.

**Thống kê mã nguồn (phần do nhóm phát triển/can thiệp trực tiếp):**

| Thành phần | Số liệu |
|---|---|
| Tổng dòng code phần Rust core (`src/`) | ~54.000 dòng (kế thừa từ RustDesk + các điểm chèn logic mới) |
| File lớn nhất | `src/server/connection.rs` — 6.162 dòng |
| Số hàm Rust expose cho Sciter UI (`dispatch_script_call!`) | 100+ hàm, trong đó có 1 hàm mới: `check_access_blocking` |
| `server.js` (Gateway, toàn bộ mới) | ~736 dòng, không có npm dependency |
| `public/admin.html` (Web Admin UI, toàn bộ mới) | ~910 dòng (HTML/CSS/JS thuần) |
| Số endpoint REST API gateway | 19 endpoint (Admin API: 13, Client API: 6) |
| Số ngôn ngữ UI được rà soát/dịch đầy đủ | ~45 file trong `src/lang/` |
| File `.tis` Sciter chính bị chỉnh sửa | `ab.tis`, `index.tis`, `header.tis`, `common.tis`, `msgbox.tis`, `file_transfer.tis` |

**Các tính năng đã hoàn thành (✅) so với RustDesk gốc:**

| # | Tính năng | Trạng thái |
|---|---|---|
| 1 | Rebrand tên ứng dụng + đổi bảng màu giao diện sang tông xanh | ✅ Hoàn thành |
| 2 | Đặt ngôn ngữ mặc định là Tiếng Việt, dịch đầy đủ các chuỗi UI | ✅ Hoàn thành |
| 3 | Đăng nhập SSO qua Keycloak (OIDC Authorization Code flow) thay cho dialog user/pass cũ | ✅ Hoàn thành |
| 4 | Address Book hiển thị danh sách máy lọc theo role trong JWT | ✅ Hoàn thành |
| 5 | Web Admin UI quản trị Users / Roles / Machines (CRUD đầy đủ) | ✅ Hoàn thành |
| 6 | Đăng xuất kèm revoke token tại Keycloak | ✅ Hoàn thành |
| 7 | Chặn kết nối tới máy không được phân quyền ngay tại tầng Rust (đồng bộ, trước khi mở kết nối) | ✅ Hoàn thành |
| 8 | Tùy chọn đăng nhập Google qua Identity Provider của Keycloak | 📄 Đã có hướng dẫn cấu hình, cần thực hiện thủ công trên Keycloak Console |
| 9 | Đóng gói `.env`, systemd service, Docker Compose | 📝 Đã lập kế hoạch chi tiết (`optimize-and-package.md`), đang triển khai |

### 4.3.3. Minh họa các chức năng chính

> Khi hoàn thiện báo cáo, chèn ảnh chụp màn hình thực tế tương ứng với từng mô tả dưới đây.

**a) Đăng nhập qua Keycloak (Address Book).** Người dùng vào tab Address Book, nhấn **Đăng nhập** → trình duyệt mặc định mở trang đăng nhập Keycloak (do `prompt=login` nên luôn yêu cầu nhập lại thông tin, không tự SSO ngầm theo session cũ) → sau khi xác thực thành công, ứng dụng tự động polling và nhận `access_token`, hiển thị danh sách máy được phép truy cập.

**b) Hiển thị Address Book theo phân quyền.** Hai user khác role sẽ thấy danh sách máy khác nhau — minh chứng cho cơ chế RBAC: user có role `engineering` chỉ thấy các máy được gán cho role này trong tab **Danh sách role** của Admin UI.

**c) Chặn kết nối trái phép.** Khi người dùng nhập trực tiếp ID của một máy không thuộc role của họ (kể cả khi không qua Address Book), hệ thống hiển thị msgbox "Bạn không có quyền truy cập máy này" và không tiến hành kết nối; nếu máy không nằm trong `data.json` hoặc gateway offline, hệ thống áp dụng chính sách **fail-open** (vẫn cho kết nối) để tránh chặn nhầm khi hạ tầng gặp sự cố.

**d) Web Admin UI — Tab Danh sách máy.** Bảng CRUD với các cột Alias / RustDesk ID / Tag / Ghi chú / Roles; modal "Sửa" cho phép chọn lại các role được áp dụng cho máy đó.

**e) Web Admin UI — Tab Danh sách role.** Mỗi role hiển thị dạng card gồm danh sách user và danh sách máy thuộc role; có thể thêm/gỡ trực tiếp từ card, hoặc tạo/xóa role Keycloak ngay từ giao diện.

**f) Web Admin UI — Tab Người dùng.** Bảng user lấy trực tiếp từ Keycloak (tên, email, role, trạng thái enable/disable); hỗ trợ tạo mới, xóa, gán/thu hồi role và bật/tắt tài khoản.

---

## 4.4. Kiểm thử

Nhóm áp dụng kết hợp **kiểm thử hộp đen (black-box)** ở mức API/HTTP (dùng `curl`/Postman để gọi trực tiếp các endpoint của gateway) và **kiểm thử thủ công trên giao diện (manual UI testing)** cho 3 chức năng quan trọng nhất của đồ án:

### 4.4.1. Chức năng: Đăng nhập SSO qua Keycloak

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-01 | Nhấn Login, đăng nhập đúng tài khoản có role `admin` | Trình duyệt mở trang KC; sau login, ứng dụng nhận `access_token`, hiển thị đủ danh sách máy theo role admin | ✅ Đạt |
| TC-02 | Nhấn Login, đăng nhập tài khoản role `viewer` | Chỉ hiển thị các máy được gán cho role `viewer` | ✅ Đạt |
| TC-03 | Nhấn **Hủy** trong lúc đang chờ xác thực trình duyệt | Dừng polling ngay, quay lại nút Login | ✅ Đạt |
| TC-04 | Hết thời gian chờ (quá 60 lần poll × 2 giây = 120 giây không xác thực) | Hiển thị lỗi "Login timeout" | ✅ Đạt |
| TC-05 | Nhấn Đăng xuất | Xóa token cục bộ ngay (UI phản hồi tức thì), gọi `/api/auth/logout` để revoke token phía Keycloak | ✅ Đạt |

### 4.4.2. Chức năng: Kiểm soát truy cập trước khi kết nối (`check_access_blocking`)

Kỹ thuật: kiểm thử hộp đen kết hợp kiểm thử ranh giới (boundary testing) trên độ trễ timeout.

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-06 | Chưa đăng nhập, nhập ID máy đã có trong `data.json` | Msgbox "Bạn cần đăng nhập để kết nối máy này", không kết nối | ✅ Đạt |
| TC-07 | Chưa đăng nhập, nhập ID máy KHÔNG có trong `data.json` | Kết nối thành công (máy ngoài hệ thống quản lý → fail-open) | ✅ Đạt |
| TC-08 | Đã đăng nhập, role có quyền truy cập máy | Kết nối thành công | ✅ Đạt |
| TC-09 | Đã đăng nhập, role KHÔNG có quyền truy cập máy | Msgbox "Bạn không có quyền truy cập máy này", không kết nối | ✅ Đạt |
| TC-10 | Tắt gateway (`server.js` offline), nhập bất kỳ ID nào | Sau tối đa 800ms timeout, vẫn cho kết nối (fail-open, tránh chặn oan khi hạ tầng lỗi) | ✅ Đạt |

### 4.4.3. Chức năng: Web Admin UI — quản lý Role ↔ Machine

| Mã TC | Kịch bản | Kết quả mong đợi | Kết quả thực tế |
|---|---|---|---|
| TC-11 | `GET /admin/api/keycloak-roles` | Trả đúng danh sách client role (`admin`, `viewer`, `guest`) | ✅ Đạt |
| TC-12 | `GET /admin/api/roles` | Trả dữ liệu đã enrich gồm `machines` và `users` cho mỗi role | ✅ Đạt |
| TC-13 | `PUT /admin/api/roles` với mapping mới | `data.json` cập nhật đúng; `/api/address-books` của user thuộc role đó trả đúng danh sách mới | ✅ Đạt |
| TC-14 | Tạo / xóa machine qua `POST`/`PUT`/`DELETE /admin/api/machines` | Machine xuất hiện/biến mất khỏi cả bảng UI và `data.json`, đồng thời bị gỡ khỏi mọi role liên quan khi xóa | ✅ Đạt |
| TC-15 | Tắt Keycloak, gọi `GET /admin/api/roles` | Tự fallback về dữ liệu local (`appData.roles`), hiển thị banner cảnh báo vàng trên UI thay vì lỗi 500 | ✅ Đạt |

### 4.4.4. Tổng kết kết quả kiểm thử

- Tổng số trường hợp kiểm thử đã thực hiện: **15** (API + manual UI), tất cả đạt yêu cầu.
- Các trường hợp kiểm thử khác (CRUD user, enable/disable, dịch ngôn ngữ, đổi theme) được kiểm thử nhanh qua thao tác trực tiếp trên UI trong quá trình phát triển, không lập thành bảng riêng do mức độ rủi ro thấp — chi tiết tham khảo phần "API đã test pass" trong `.claude/SUMMARY.md`.
- Hạn chế còn tồn đọng (ghi nhận trung thực để phần "Hướng phát triển" sử dụng):
  - Chưa kiểm thử `POST /api/address-books` với JWT thật phát sinh từ một phiên đăng nhập Google Social Login đầy đủ.
  - Cơ chế kiểm soát truy cập hiện chỉ enforce ở **client ROCKY**; người dùng dùng client RustDesk gốc (không qua `check_access_blocking`) vẫn có thể bỏ qua lớp kiểm soát này — đây là giới hạn của thiết kế client-side enforcement, cần bổ sung kiểm soát ở tầng rendezvous/relay server nếu muốn triển khai production nghiêm ngặt hơn.

---

## 4.5. Triển khai

**Mô hình triển khai thử nghiệm** gồm 3 tiến trình chạy trên cùng một máy chủ (hoặc tách rời nếu cần mở rộng):

```
┌─────────────────────────────────────────────┐
│  Máy chủ / server nội bộ                     │
│                                               │
│  ┌─────────────────┐   ┌──────────────────┐ │
│  │ Keycloak          │   │ ROCKY Gateway     │ │
│  │ (Docker container)│   │ (systemd service  │ │
│  │ port 8080          │   │  hoặc Docker)     │ │
│  └─────────────────┘   │ port 3000          │ │
│                          └──────────────────┘ │
└─────────────────────────────────────────────┘
              ▲                      ▲
              │ HTTPS/HTTP            │ HTTP
   ┌──────────┴──────────┐  ┌────────┴─────────┐
   │ ROCKY Desktop Client  │  │ Trình duyệt admin │
   │ (máy người dùng)       │  │ (web admin UI)    │
   └──────────────────────┘  └──────────────────┘
```

**Cấu hình triển khai:**

- **Keycloak**: chạy qua Docker (`quay.io/keycloak/keycloak`, chế độ `start-dev` cho môi trường thử nghiệm), realm `rustdesk`, client `rustdesk-client` (confidential, service account có quyền `view-users`, `manage-users`, `view-realm`, cần bổ sung `manage-realm`/`manage-clients` nếu muốn tạo/xóa role và client trực tiếp từ Admin UI).
- **ROCKY Gateway**: cấu hình qua file `.env` (không hardcode secret trong source) — `KEYCLOAK_URL`, `KC_REALM`, `KC_CLIENT_ID`, `KC_CLIENT_SECRET`, `REDIRECT_URI`, `ADMIN_USER`, `ADMIN_PASS`, `PORT`; chạy nền bằng unit `systemd` (`res/rocky-gateway.service`, tự khởi động lại khi lỗi — `Restart=on-failure`) hoặc bằng Docker Compose (`docker-compose.yml` với service `keycloak` + `rocky-gateway` trên một bridge network nội bộ, chỉ expose port 3000 và 8080 ra ngoài).
- **ROCKY Desktop Client**: build release bằng `cargo build --release` kết hợp `python3 build.py` để đóng gói `.deb` cho Linux; áp dụng `lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip = true` trong `Cargo.toml` để giảm kích thước và tăng tốc binary.

**Quy trình triển khai thử nghiệm (đã thực hiện trên máy phát triển):**

```bash
# 1. Keycloak
docker run -p 8080:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev

# 2. ROCKY Gateway
cp .env.example .env   # điền KC_CLIENT_SECRET, ADMIN_PASS
node server.js         # http://127.0.0.1:3000/admin

# 3. ROCKY Desktop Client
cargo run --release
```

**Kết quả triển khai thử nghiệm:**

- Hệ thống đã được triển khai và kiểm thử trên môi trường phát triển cục bộ (localhost) với 1 realm Keycloak, 5 tài khoản người dùng thử nghiệm (`anh`, `anhndp`, `grace`, `testadmin`, `testviewer`) thuộc 3 role (`admin`, `viewer`, `guest`), và một số máy mẫu trong `data.json`.
- Thời gian phản hồi của endpoint `/api/check-access` nằm trong giới hạn timeout 800ms đặt ra phía client, đảm bảo không gây cảm giác trễ rõ rệt khi người dùng nhấn kết nối.
- Đồ án chưa triển khai trên môi trường production có nhiều người dùng đồng thời; số liệu về khả năng chịu tải, số lượng truy cập thực tế và phản hồi người dùng cuối **chưa có** do giới hạn về thời gian và hạ tầng thử nghiệm — đây là điểm cần bổ sung nếu mở rộng đồ án thành sản phẩm vận hành thật.
