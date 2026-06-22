# BÁO CÁO ĐỒ ÁN — ROCKY
### Remote Desktop nội bộ có SSO Keycloak và kiểm soát truy cập tập trung

> Tài liệu mô tả toàn bộ đồ án: bài toán, kiến trúc, các công việc đã thực hiện, công nghệ sử
> dụng, kết quả/thống kê, kiểm thử, triển khai và hạn chế còn tồn đọng.
> Đối chiếu trực tiếp với source code tại thời điểm **2026-06-23** (không suy diễn từ tài liệu
> nháp cũ). Nguồn: `CLAUDE.md`, `docs/admin-ui.md`, `docs/address-book.md`, `docs/keycloak.md`,
> `docs/classDiagram.md`, `docs/sequenceDiagram.md`, `docs/ci-windows-build.md`,
> `docs/ci-linux-macos-build.md`, lịch sử commit Git, và source code thật
> (`server.js`, `public/admin.html`, `src/ui.rs`, `src/ui/ab.tis`,
> `libs/hbb_common/src/config.rs`).

---

## 1. Giới thiệu đồ án

### 1.1. Bối cảnh & bài toán

[RustDesk](https://github.com/rustdesk/rustdesk) là phần mềm remote desktop mã nguồn mở, viết
bằng Rust, hỗ trợ 2 bộ giao diện: Flutter (mới) và Sciter (cũ, nhẹ hơn). Đồ án này **chỉ làm việc
với bản Sciter** (`src/ui/`) — không động tới Flutter.

RustDesk gốc cho phép kết nối tới *bất kỳ* máy nào biết đúng ID + password — không có khái niệm
"người dùng tổ chức", không phân biệt được nhân viên phòng A chỉ nên thấy/kết nối máy phòng A.
Đây là hạn chế lớn nếu triển khai remote desktop nội bộ cho một tổ chức có nhiều phòng/nhóm máy
cần tách biệt quyền truy cập.

**Bài toán đặt ra:** xây dựng một biến thể RustDesk (đặt tên **ROCKY**) cho phép:
- Người dùng đăng nhập bằng tài khoản tổ chức (SSO) thay vì chỉ dùng ID/password ngẫu nhiên.
- Address Book (danh sách máy) hiển thị **đúng theo nhóm/phòng** mà người dùng thuộc về.
- Có hệ thống quản trị web riêng để IT-admin quản lý người dùng, nhóm và máy trạm — không phải
  sửa tay từng máy hay merge code.
- Có quy trình build/đóng gói tự động cho cả 3 nền tảng desktop (Windows/Linux/macOS).

### 1.2. Mục tiêu

1. Tích hợp **SSO qua Keycloak** (OpenID Connect) cho cả desktop client và một trang quản trị
   web mới xây dựng.
2. Xây dựng cơ chế **kiểm soát truy cập theo nhóm** (Group-based access control): Address Book
   chỉ hiển thị/ cho kết nối tới máy mà người dùng có quyền.
3. Xây dựng **Web Admin UI** quản lý người dùng, nhóm (group) và máy trạm, có phân quyền nhiều
   cấp cho chính trang quản trị (không phải ai đăng nhập được cũng có toàn quyền).
4. **Rebrand** ứng dụng theo bộ nhận diện riêng (tên, màu sắc, icon) và Việt hóa giao diện.
5. Thiết lập **pipeline CI/CD** build & đóng gói tự động cho Windows, Linux, macOS — phần này
   upstream RustDesk vốn không có sẵn cho bản Sciter (chỉ có cho Flutter).

### 1.3. Phạm vi

- **Trong phạm vi:** toàn bộ `src/ui/` (Sciter UI), `src/ui.rs`/`ui_interface.rs` (cầu nối
  Rust↔Sciter), `libs/hbb_common/src/config.rs` (data model Address Book gốc), gateway tự viết
  (`server.js` + `public/admin.html`), cấu hình Keycloak, pipeline CI (`.github/workflows/build.yml`).
- **Ngoài phạm vi:** bản Flutter UI (`flutter/`, `src/flutter.rs`, `src/flutter_ffi.rs`,
  `src/bridge_generated.rs`) — không được chạm tới theo quy ước làm việc của đồ án; hbbs/hbbr
  (rendezvous/relay server) — dùng image chính thức, không có source trong repo này; việc
  container hóa toàn hệ thống — mới ở mức kế hoạch (mục 8).

---

## 2. Tổng quan kiến trúc hệ thống

ROCKY theo kiến trúc **client – gateway – identity provider**, gồm 3 tiến trình runtime độc lập:

```
┌───────────────────────────────┐
│   ROCKY Desktop Client          │   Rust + Sciter UI
│   (controller / controlled peer)│
└───────────────┬─────────────────┘
                │ HTTP
┌───────────────▼─────────────────┐
│   server.js — Gateway (Node.js) │   Backend-for-Frontend +
│   - /admin/*      Admin UI      │   Policy Decision Point
│   - /admin/api/*  Admin REST    │   (không npm dependency)
│   - /api/auth/*   Auth proxy    │
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

So với RustDesk gốc (chỉ Client ↔ Rendezvous/Relay server), điểm khác biệt cốt lõi là **lớp
gateway trung gian** đứng giữa client/Admin UI và Keycloak, đóng 3 vai trò: auth proxy, REST API
cho Admin UI, và policy decision point cho việc kết nối.

**Hai mô hình phân quyền hoàn toàn tách biệt, dùng chung 1 Keycloak nhưng không liên quan dữ
liệu:**

| | Desktop Client (Address Book) | Admin Web UI |
|---|---|---|
| Keycloak client | `rustdesk-client` | `rocky-admin` |
| Đơn vị phân quyền | **Keycloak Group** (realm-level) | **Client role**, 3 tier: `admin` / `manage_users` / `manage_machines` |
| Nguồn đọc quyền | claim `groups` trong JWT access token | Keycloak token introspection |
| 2FA | Không | **Có — TOTP, chỉ bắt buộc với tier `admin`** |
| Dữ liệu mapping | SQLite `machine_groups` (Group ↔ máy) | Không lưu thêm — quyền nằm hẳn trên Keycloak |

---

## 3. Các công việc đã thực hiện

### 3.1. Rebrand ứng dụng

- Đổi `APP_NAME` từ `"RustDesk"` thành `"ROCKY"` (`libs/hbb_common/src/config.rs`) — nguồn chân
  lý duy nhất, toàn bộ UI lấy tên qua `handler.get_app_name()`, không hardcode nơi khác.
- Đổi icon: crop logomark riêng (6 chấm lục giác + chấm xanh giữa) từ ảnh thương hiệu, sinh đủ
  bộ asset (`res/icon.ico`, `res/tray-icon.ico`, các size PNG, `res/scalable.svg`...), nhúng trực
  tiếp base64 vào `src/ui.rs::get_icon()` (2 nhánh macOS/non-macOS).
- Đổi bảng màu UI 2 lần: lần đầu sang xanh dương (`#1565C0`), sau đó đổi hẳn sang tông
  **navy/teal** (`accent #00D2D3`, `button #58D0F8`, nền navy `#111D43`) để khớp bộ nhận diện
  thương hiệu chính thức — khai báo qua cú pháp riêng của Sciter (`var(name): value;` trong
  `common.css`, đọc bằng `color(name)`, vì Sciter không hỗ trợ `:root{--x}` kiểu browser).
- Thêm tagline "Think Like Hustler." (`src/lang/en.rs`), bỏ khung cảnh báo Wayland cũ
  (`ModifyDefaultLogin`), thay bằng component `BrandLogo` hiển thị logomark không điều kiện.
- Web Admin UI (`public/admin.html`) ban đầu cũng đổi sang navy đậm để đồng bộ, nhưng sau 2 lần
  bị phản hồi "quá tối" đã quyết định chuyển hẳn sang **theme sáng riêng** (nền `#F7FAFF`, accent
  teal đậm `#00B8B8`) — ưu tiên dễ đọc hơn giữ đúng tông màu gốc.

### 3.2. Việt hóa giao diện

- Đặt ngôn ngữ mặc định của app là tiếng Việt (`src/lang.rs`).
- Rà soát và dịch đầy đủ các chuỗi UI còn thiếu trong **51 file** `src/lang/*.rs`, không sửa
  `template.rs` (master key list) và không đổi các bản dịch đã có sẵn.
- Việt hóa các thông báo lỗi/nút bấm tự viết thêm cho luồng Keycloak (`ab.tis`), file transfer,
  msgbox.

### 3.3. SSO Keycloak cho desktop client (Address Book)

Thay dialog đăng nhập username/password gốc của RustDesk bằng luồng **OAuth2 Authorization Code**
qua Keycloak, chạy trên tab browser hệ thống (không nhúng webview vào app Sciter):

1. `ab.tis` gọi `POST /api/auth/init` → gateway sinh `session_code`, trả URL Keycloak.
2. App mở browser hệ thống (`handler.open_url`) tới URL đó; UI hiện "Đang chờ xác thực...".
3. `ab.tis` poll `POST /api/auth/status` mỗi 2 giây (tối đa 60 lần = 120 giây) để lấy kết quả.
4. User đăng nhập trên Keycloak → Keycloak redirect về `GET /api/auth/callback` (gateway) →
   gateway đổi `code` lấy `access_token` qua `POST /token`.
5. `ab.tis` nhận `access_token` qua bước poll, lưu vào `LocalConfig` (qua Rust), rồi gọi
   `POST /api/address-books` (kèm Bearer token) để lấy danh sách máy.

Đã xử lý thêm: timeout đăng nhập, nút Hủy giữa lúc chờ, và tự dọn session treo trong gateway sau
10 phút nếu user bỏ ngang luồng (`sweepStaleSessions()`).

### 3.4. Address Book theo Keycloak Group (kiểm soát truy cập)

Đây là phần thay đổi lớn nhất so với thiết kế ban đầu của đồ án. Mô hình phân quyền đã trải qua
**2 vòng thiết kế:**

- **Vòng 1 (giai đoạn đầu):** phân quyền theo **Keycloak client-role** (`admin`/`viewer`/`guest`)
  gán trực tiếp trên client `rustdesk-client`.
- **Vòng 2 (redesign, hiện tại):** chuyển hẳn sang **Keycloak Group** (realm-level, không gắn với
  1 client cụ thể) — phù hợp hơn với ngữ nghĩa thực tế ("phòng kế toán", "phòng nhân sự" là một
  *nhóm người*, không phải một *quyền hạn*). Gateway đọc Group qua claim `groups` trong JWT
  (`getGroupsFromPayload()`), cần thêm protocol mapper "Group Membership" trên `rustdesk-client`.

**Luồng hoạt động:** `POST /api/address-books` (kèm Bearer token) → gateway verify token qua
Keycloak token introspection (cache 30 giây để giảm round-trip) → đọc claim `groups` → truy vấn
SQLite (`machines JOIN machine_groups WHERE group_name IN (...)`) → trả về danh sách máy kèm
field `groups` (UI vẫn hiển thị dưới label "Tags" theo quy ước có sẵn của RustDesk).

**Kiểm soát truy cập trước khi kết nối** (`check_access_blocking`, bổ sung mới vào
`src/ui.rs:497`): khi user bấm kết nối tới 1 ID bất kỳ (không chỉ qua Address Book), Rust tự gọi
đồng bộ (blocking, timeout 800ms) tới `POST /api/check-access` trước khi mở kết nối thật. Lý do
phải đưa logic này xuống Rust: hàm `httpRequest()` trong Sciter là bất đồng bộ, không thể dùng để
*ngăn* một hành động xảy ra ngay sau nó. Chính sách **fail-open**: nếu gateway lỗi/offline/timeout,
hoặc máy không có trong hệ thống quản lý, vẫn cho kết nối — đây là quyết định có chủ đích (ưu
tiên không chặn nhầm khi hạ tầng phụ trợ gặp sự cố), không phải lỗi thiết kế.

### 3.5. Web Admin UI — quản trị user/group/máy + phân quyền 3-tier + 2FA

Xây mới hoàn toàn 1 trang quản trị web (`public/admin.html`, SPA không framework/bundler) với
**3 tab**: *Người dùng*, *Danh sách group*, *Danh sách máy*. Mỗi tab là 1 bảng CRUD + modal.

Phân quyền cho chính trang quản trị cũng trải qua redesign: ban đầu chỉ có 1 role `admin` gate
toàn bộ; sau đó tách thành **3 client role trên client riêng `rocky-admin`**:

| Tier | Quyền |
|---|---|
| `admin` (admin tối cao) | Toàn quyền + duy nhất tạo/xoá Keycloak Group + duy nhất gán/gỡ 3 role admin-tier cho người khác |
| `manage_users` | CRUD người dùng Keycloak + gán user vào Group (machine-access) |
| `manage_machines` | CRUD máy trạm + gán máy ↔ Group |

`requireAdminAuth(req, res, allowedRoles)` gate theo tier ở **từng route** (không phải 1 check
toàn cục); `requireSuperAdmin()` riêng cho các route chỉ admin tối cao mới gọi được. Tab/nút trên
UI cũng tự ẩn/hiện theo tier của người đang đăng nhập.

**2FA (TOTP)** được thêm riêng cho role `admin`: dùng Browser Authentication Flow tùy biến của
Keycloak (`browser-admin-otp`, duplicate từ flow gốc), điều kiện kích hoạt OTP là "user có role
`admin`" — không ảnh hưởng tới `rustdesk-client` hay 2 tier còn lại của Admin UI.

Đăng nhập Admin UI dùng **token introspection** (Keycloak tự verify chữ ký + hạn token), khác với
luồng client (chỉ tự decode JWT, không verify signature) — vì đây là cổng vào cho hành động quản
trị nhạy cảm.

### 3.6. Persistence: chuyển từ `data.json` sang SQLite

Giai đoạn đầu dự án lưu dữ liệu máy/role vào 1 file JSON phẳng (`data.json`). Sau khi mô hình
phân quyền phức tạp hơn (Group↔máy N-N, cần truy vấn join), đã chuyển sang **SQLite** qua module
built-in `node:sqlite` của Node.js (không thêm dependency ORM nào):

```sql
CREATE TABLE machines (
  id TEXT PRIMARY KEY, alias TEXT, rustdesk_id TEXT, note TEXT
);
CREATE TABLE machine_groups (
  group_name TEXT, machine_id TEXT, PRIMARY KEY (group_name, machine_id)
);
```

`data.json` cũ chỉ còn được đọc **một lần** lúc khởi động (nếu bảng `machines` còn rỗng) để di
trú dữ liệu máy lịch sử; dữ liệu role cũ không di trú được (không có Group tương ứng trong model
mới).

### 3.7. Bảo mật & vá lỗi phát hiện trong quá trình rà soát

Trong lúc rà soát lại toàn bộ luồng auth (2026-06-22), phát hiện và vá 3 lỗ hổng:

1. **JWT không verify signature** ở luồng client (`check-access`/`address-books`) — chuyển từ tự
   decode sang `introspectTokenCached()` (verify thật qua Keycloak, cache 30s để không cộng thêm
   latency vào ngân sách 800ms của `check_access_blocking`).
2. **`sessions` Map leak** — session đăng nhập bị bỏ ngang sống mãi trong memory gateway; thêm
   TTL 10 phút + dọn lazy mỗi lần có request login mới.
3. **Logout silent-fail** — gateway luôn trả về "đăng xuất thành công" cho client dù lệnh revoke
   token tại Keycloak thực ra bị lỗi; sửa để đọc đúng status thật và trả về kèm cờ `revoked`.

Các rủi ro **chưa fix, đã ghi nhận có chủ đích**: `check_access_blocking` vẫn fail-open (UX gate,
không phải security boundary đáng tin cậy); 2FA chưa mở rộng cho 2 tier admin mới; 1 service
account Keycloak dùng chung cho mọi lệnh Admin API.

### 3.8. Pipeline CI/CD build đa nền tảng

Upstream RustDesk có sẵn CI cho bản Flutter, nhưng **không có** job build bản Sciter hoàn chỉnh
cho cả 3 nền tảng. Đồ án đã xây mới/sửa hoàn toàn workflow `.github/workflows/build.yml`:

- **Windows** (`build-windows`): pin Rust 1.75.0 (Rust 1.78+ đổi ABI i128, vỡ `sciter-rs` đã
  pin) → LLVM/Clang 15.0.6 → vcpkg manifest mode (triplet `x64-windows-static`) →
  `python build.py --portable` → đóng gói installer tự giải nén
  `rustdesk-{version}-win7-install.exe`. Đã vá 6 lỗi pipeline khác nhau (toolchain, triplet vcpkg
  sai, đường dẫn artifact sai, `resources/` không được tạo, thiếu `sciter.dll` runtime, lỗi
  encode UTF-8 khi đọc file tiếng Việt trên Windows runner).
- **Linux** (`build-linux`): thêm step setup `VCPKG_ROOT` (code Rust `panic!` nếu thiếu trên
  Linux), tải `libsciter-gtk.so`, sửa 2 bug đường dẫn trong `build.py` khi đóng `.deb`
  (`DEBIAN/`/`pam.d/` phải là `res/DEBIAN/`/`res/pam.d/`), thêm bước đóng `.AppImage`.
- **macOS** (`build-macos`): **job hoàn toàn mới** — upstream không có CI Sciter cho macOS, viết
  dựa trên nhánh `build.py` osx sẵn có nhưng chưa từng chạy qua CI; build `.dmg` qua
  `cargo-bundle` + `create-dmg`.

---

## 4. Công nghệ sử dụng

| Mục đích | Công nghệ |
|---|---|
| Ngôn ngữ lõi desktop client | Rust (pin 1.75.0 cho CI — giới hạn ABI Sciter) |
| UI Engine | Sciter SDK (`libsciter-gtk.so`/`sciter.dll`/`libsciter.dylib`) |
| Quản lý thư viện C/C++ | vcpkg (libvpx, libyuv, opus, aom) |
| Async runtime / HTTP client (Rust) | tokio, reqwest (blocking, dùng cho `check_access_blocking`) |
| Backend Gateway | Node.js — chỉ built-in `http`/`fs`/`crypto`/`node:sqlite`, **không có npm dependency** |
| Persistence Gateway | SQLite qua `node:sqlite` |
| Identity Provider | Keycloak (OIDC, Group, client role, 2FA TOTP built-in) |
| Đóng gói client | `cargo-bundle`, `rustdesk-portable-packer` (tự viết, Windows), `appimage-builder` (Linux) |
| CI/CD | GitHub Actions |
| Quản lý mã nguồn | Git |

---

## 5. Thống kê mã nguồn & sản phẩm

> Đo trực tiếp trên source (`wc -l`, `du -sh`, đếm regex `struct`/`enum`/`impl`/`fn`), không
> tính `flutter/`, `target/`, `.git`.

| Thành phần | Số liệu |
|---|---|
| Tổng dòng Rust (logic + 51 file bản dịch) | 147.011 dòng (108.628 logic + 38.383 bản dịch) |
| File Rust lớn nhất | `src/server/connection.rs` — 6.162 dòng |
| Sciter UI (`.tis` + `.css` + `.html`) | 8.460 dòng |
| `server.js` (gateway, toàn bộ mới) | 1.012 dòng, không npm dependency |
| `public/admin.html` (Admin UI, toàn bộ mới) | 992 dòng |
| Số `struct`/`enum`/`trait`/`impl` (Rust) | 151 / 23 / 1 / 543 |
| Số file `.rs` | 277 (226 logic + 51 bản dịch) |
| Số crate Cargo trong `libs/` | 8 |
| Số hàm Rust expose cho Sciter (`dispatch_script_call!`) | 100+ |
| Số endpoint REST API gateway | 27 (Admin: 21, Client API: 6) |
| Dung lượng toàn bộ mã nguồn | ~11,6 MB |
| Binary Linux build local (`cargo build --release`, đã strip) | 41 MB |
| `.deb`/`.AppImage`/`.exe`/`.dmg` (build qua CI) | chưa đo được tại máy phát triển — chỉ build trên GitHub Actions runner |

---

## 6. Kiểm thử

Kết hợp **kiểm thử hộp đen** (curl/Postman gọi trực tiếp endpoint gateway) và **kiểm thử thủ
công trên UI**, tổng cộng 22 trường hợp đã thực hiện, tất cả đạt:

- **SSO desktop client** (6 TC): login đúng/sai Group, hủy giữa chừng, timeout, logout, session
  leak tự dọn.
- **Kiểm soát truy cập trước khi connect** (6 TC): chưa login, login đúng/sai quyền, token
  giả/hỏng, gateway offline (fail-open).
- **Đăng nhập Admin UI theo tier + 2FA** (5 TC): admin tối cao bị bắt OTP, 2 tier khác không bị
  bắt OTP, sai quyền bị 403/bị chặn leo thang quyền.
- **Quản lý Group↔Machine qua Admin UI** (5 TC): CRUD máy, mapping Group↔máy, quyền tạo/xoá Group
  chỉ admin tối cao, session Admin UI hết hạn đúng 8h.

**Hạn chế đã ghi nhận trung thực:** 2FA chưa mở rộng cho 2 tier admin mới; kiểm soát truy cập chỉ
enforce ở client ROCKY (client RustDesk gốc bỏ qua được); 1 service account Keycloak dùng chung
cho mọi thao tác quản trị; chưa test với luồng Google Social Login đầy đủ.

---

## 7. Triển khai

Mô hình triển khai thử nghiệm hiện tại — **3 tiến trình chạy thủ công**, chưa container hóa:

```bash
# Keycloak
docker run -p 8080:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev

# Gateway (không cần npm install)
node server.js   # bind 0.0.0.0:3000 để chấp nhận kết nối từ máy khác trong mạng

# Desktop client
cargo run --release   # hoặc dùng bản build từ CI
```

Toàn bộ cấu hình (địa chỉ Keycloak, client secret, địa chỉ VM...) hiện **hardcode trực tiếp
trong source** (`server.js`, `src/ui.rs`, `src/ui/ab.tis`) — chưa có file `.env`, chưa có Docker
Compose hay systemd unit riêng cho gateway.

---

## 8. Hạn chế & hướng phát triển

1. **2FA chưa siết cho 2 tier admin mới** (`manage_users`/`manage_machines`) — chỉ tier `admin`
   bị bắt OTP.
2. **Kiểm soát truy cập chỉ ở phía client ROCKY** — cần đẩy xuống tầng rendezvous/relay server
   nếu muốn production nghiêm ngặt hơn (chặn cả client RustDesk gốc).
3. **Chưa container hóa hệ thống** — đã có kế hoạch chi tiết (`.claude/plans/optimize-and-package.md`)
   cho việc đóng gói Keycloak + hbbs/hbbr tự host + Gateway qua Docker Compose, chuyển cấu hình
   sang `.env`, và "bake" sẵn cấu hình server tự host vào client (qua binary `naming` +
   `src/custom_server.rs`, để cài xong tự kết nối, không cần người dùng tự nhập IP) — **chưa
   triển khai thật**.
4. **Đăng nhập Google qua Keycloak Identity Provider** — đã có hướng dẫn cấu hình
   (`.claude/plans/keycloak-google-login.md`), chưa thực hiện trên Keycloak Console thật.
5. Chưa có số liệu vận hành thật (tải, số người dùng đồng thời) do giới hạn thời gian và hạ tầng
   thử nghiệm — cần bổ sung nếu mở rộng thành sản phẩm vận hành thật.

---

## 9. Dòng thời gian thực hiện (các commit chính)

| Ngày | Công việc |
|---|---|
| 2026-06-09 | Hoàn thiện luồng login + hiển thị danh sách + quản lý danh sách (gateway ban đầu) |
| 2026-06-15 | Đồng bộ tài liệu (SUMMARY, CLAUDE.md, báo cáo) |
| 2026-06-18 | Thiết lập CI build Windows `.exe` — vá nhiều lỗi pipeline (toolchain, vcpkg, artifact path, `sciter.dll`); cập nhật địa chỉ VM cho client build từ CI kết nối được gateway |
| 2026-06-19 | Đổi tông màu + logo sang bộ nhận diện navy/teal (app + Admin UI) |
| 2026-06-20 | Đổi tên/logo, bổ sung CI build Linux + macOS, vá bug build trên 2 nền tảng này |
| 2026-06-21 | Redesign phân quyền: role đơn → Keycloak Group (machine-access) + 3-tier admin role (Admin UI) |
| 2026-06-22 | Vá 3 lỗ hổng auth gateway (JWT không verify, session leak, logout silent-fail); cập nhật tài liệu |
| 2026-06-23 | Rà soát, đối chiếu lại toàn bộ tài liệu kỹ thuật với source thật |
