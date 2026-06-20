# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

RustDesk is a remote desktop application written in Rust with a Sciter-based UI (`src/ui/`). It handles screen capture, audio/video streaming, input forwarding, file transfer, and rendezvous/relay networking.

## Scope Rule

**Only work with the Sciter UI (`src/ui/`). Do not touch, suggest, or reference anything Flutter-related (`flutter/`, `src/flutter.rs`, `src/flutter_ffi.rs`, `src/bridge_generated.rs`, `flutter_rust_bridge`).**

## Build Commands

### Rust (library + native binary)
```sh
# Debug build
cargo build

# Release build
cargo run --release

# Run tests
cargo test

# Run a single test
cargo test <test_name>

# Lint
cargo clippy
```

### Linux system dependencies (Ubuntu/Debian)
```sh
sudo apt install -y zip g++ gcc git curl wget nasm yasm libgtk-3-dev clang \
  libxcb-randr0-dev libxdo-dev libxfixes-dev libxcb-shape0-dev \
  libxcb-xfixes0-dev libasound2-dev libpulse-dev cmake make \
  libclang-dev ninja-build libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev libpam0g-dev
```

`vcpkg` must be installed and `VCPKG_ROOT` set:
```sh
vcpkg install libvpx libyuv opus aom
```

### Windows .exe via GitHub Actions (`.github/workflows/build.yml`)

The `build-windows` job builds the Sciter (non-Flutter) client and uploads a self-extracting
installer `.exe` as a workflow artifact. Triggers: push/PR to `main`/`master`, or manual
`workflow_dispatch`.

Pipeline: `dtolnay/rust-toolchain` pinned to **Rust 1.75.0** → LLVM/Clang 15.0.6 (`bindgen` needs
`libclang`) → `lukka/run-vcpkg` pinned to the commit in root `vcpkg.json`
(`120deac3...844ba10b`) → `vcpkg install --triplet x64-windows-static --x-install-root=...`
(manifest mode, reads `vcpkg.json`) → `python build.py --portable`.

Caveats discovered while fixing this job — full change log with root causes in
[`docs/ci-windows-build.md`](docs/ci-windows-build.md):
- **Rust must stay pinned ≤1.77.** Rust 1.78+ changed i128 ABI layout, which breaks the pinned
  `sciter-rs` crate. Do not bump this toolchain to `stable`/`latest`.
- **vcpkg triplet must be `x64-windows-static`** (no `-md` suffix) — `libs/scrap/build.rs:50`
  hardcodes this triplet when probing for vcpkg libraries on Windows.
- `build.py --portable` renames the binary to `target/release/RustDesk.exe` (capitalized) and
  always packs a self-extracting installer to the **repo root** as
  `rustdesk-{version}-win7-install.exe` — that root-level file is the actual deliverable `.exe`,
  not anything under `target/release/`.
- `actions/upload-artifact` must be `@v4` or newer; `v1`-`v3` are sunset by GitHub and fail
  outright.
- `res/inline-sciter.py` must open all `src/ui/*` files with explicit `encoding='utf-8'` — on
  Windows runners the default codepage (`cp1252`) cannot decode UTF-8 (e.g. Vietnamese text),
  causing a `UnicodeDecodeError`.
- `build.py:external_resources()` must always create the `resources/` directory, even when no
  `--feature` (external resource download) flag is passed — otherwise the next `cp` step turns
  `resources` into a plain file instead of a directory.
- `libs/portable` is a **Cargo workspace member**, so its packer crate
  (`rustdesk-portable-packer`) always builds into the **workspace-root** `target/release/`, never
  into `resources/`. The final installer rename/move must read from there, and `generate.py`'s
  `-e` flag must point at the real `RustDesk.exe` inside `resources/`, not the desired output
  filename.

### Linux `.deb`/`.AppImage` and macOS `.dmg` via GitHub Actions (`.github/workflows/build.yml`)

`build-linux` and `build-macos` jobs in the same file build the Sciter client for those platforms.
Full root-cause change log in [`docs/ci-linux-macos-build.md`](docs/ci-linux-macos-build.md):
- `build-linux` must also pin Rust to **1.75.0** (same Sciter ABI constraint as Windows) and must
  set up `VCPKG_ROOT` via `vcpkg install --triplet x64-linux` — `libs/scrap/build.rs` panics on
  Linux if `VCPKG_ROOT` is unset (it only falls back to system `pkg-config` when the cargo feature
  `linux-pkg-config` is explicitly enabled, which `build.py` never passes).
- The Sciter runtime for Linux (`libsciter-gtk.so`) and macOS (`libsciter.dylib`) is not vendored
  anywhere in this repo (same story as `sciter.dll` on Windows, above) — each job must `curl` it
  from `c-smile/sciter-sdk` into the repo root before building.
- `build.py`'s plain-Linux `.deb` packaging branch had two path bugs (referenced `DEBIAN/` and
  `pam.d/` at the repo root instead of `res/DEBIAN/` and `res/pam.d/`) that made deb packaging fail
  outright — fixed.
- `build-macos` is a **new** job; upstream RustDesk has no CI job that builds the native Sciter
  client for macOS (only Flutter macOS), so this path is based on `build.py`'s existing
  (previously CI-unexercised) osx/non-flutter branch.

## Architecture

### Session / Client Flow (`src/client.rs`, `src/client/`)
A `Session` object is created per remote connection. It runs an async Tokio task that negotiates the protocol, decodes video frames (via `libs/scrap/`), and plays audio (via `magnum-opus` + `cpal`).

### Server Services (`src/server/`)
When RustDesk acts as the controlled peer it runs a set of services:
- `video_service.rs` — screen capture loop
- `audio_service.rs` — microphone/speaker capture
- `input_service.rs` — receives and replays keyboard/mouse from the controller
- `clipboard_service.rs` — clipboard sync
- `connection.rs` — per-connection handler
- `display_service.rs` — monitors display configuration changes

### Rendezvous & Relay (`src/rendezvous_mediator.rs`)
Handles registration with the rendezvous server (hbbs) and hole-punching/relay negotiation via the custom RustDesk protocol (protobuf, defined in `libs/hbb_common/`).

### IPC (`src/ipc.rs`, `src/ipc/`)
Desktop builds use Unix domain sockets / named pipes to communicate between the UI process and the background service process.

### Platform Layer (`src/platform/`)
`linux.rs`, `windows.rs`, `macos.rs` contain OS-specific implementations for privilege elevation, input injection, display enumeration, and session detection.

### Sciter UI (`src/ui/`)
The Sciter-based desktop UI. HTML/CSS/JS (TIS) pages are embedded via Sciter. Rust-side UI bindings are in `src/ui.rs` and `src/ui_interface.rs`.

Key files in `src/ui/`:
| File | Role |
|---|---|
| `index.html` / `index.tis` | Main window — peer list, settings |
| `remote.html` / `remote.tis` | Remote session window |
| `remote.rs` | Rust handler for remote session (`SciterSession`, `SciterHandler`) |
| `cm.html` / `cm.tis` / `cm.rs` | Connection manager (controlled side) |
| `ab.tis` | Address book component |
| `file_transfer.tis` | File transfer UI |
| `common.tis` | Shared TIS utilities |

#### Rust ↔ Sciter Communication

**Direction 1 — TIS/JS calls Rust** via `dispatch_script_call!` macro.

Rust structs (`UI`, `SciterSession`) implement `sciter::EventHandler`. The macro registers a dispatch table of callable functions:

```rust
// src/ui.rs:722
impl sciter::EventHandler for UI {
    sciter::dispatch_script_call! {
        fn get_id();
        fn set_option(String, String);
        fn get_recent_sessions();
        // 100+ functions
    }
}
```

Handlers are registered with the frame in two ways:
- **Global handler** (main window): `frame.event_handler(UI {})` — TIS calls via `handler.methodName()`
- **Behavior handler** (per-element): `frame.register_behavior("native-remote", || Box::new(SciterSession::new(...)))` — used for the remote session element

**Direction 2 — Rust calls TIS/JS** via `Element::call_method()`.

When Sciter attaches a behavior element, `attached()` fires and Rust stores the DOM element handle:

```rust
// src/ui/remote.rs:439
fn attached(&mut self, root: HELEMENT) {
    *self.element.lock().unwrap() = Some(Element::from(root));
}
```

`SciterHandler::call()` then invokes JS functions on that element:

```rust
// src/ui/remote.rs:43
fn call(&self, func: &str, args: &[Value]) {
    allow_err!(e.call_method(func, args));
}
```

All session-driven UI events are abstracted behind the `InvokeUiSession` trait (`src/ui_session_interface.rs`). `SciterHandler` implements this trait — each method calls `self.call(js_func_name, args)`. The TIS side must define matching JS functions (e.g. `function setDisplay(x,y,w,h,...)`).

**Direction 3 — Video frames** bypass JS entirely. Sciter's `<video>` element fires `VIDEO_BIND_RQ` with a native `video_destination*` pointer. Rust stores it and pushes raw BGRA pixels directly into the pointer after decoding each frame (`src/ui/remote.rs:464`).

#### Address Book (`src/ui/ab.tis`)
Cloud-synced contact list tied to a user account. Requires login (`access_token`). Appears as the 4th tab in `MultipleSessions`; hidden when `disable_account` or `disable_ab` is set.

> In this fork, the actual login + AB listing source has been replaced with a Keycloak/gateway flow
> (`loginWithKeycloak`, `getAddressBooks` in `ab.tis` → `server.js`). Full sequence diagrams for
> login, check-access-before-connect, and logout, plus known risks (unverified JWT signature,
> fail-open access check, silent revoke failure, shared `ASYNC_JOB_STATUS` race) are in
> [`docs/address-book.md`](docs/address-book.md).

**Data model** (`libs/hbb_common/src/config.rs`):
- `Ab` — top-level container: `access_token` + `ab_entries: Vec<AbEntry>`
- `AbEntry` — one address book (personal or shared): `guid`, `name`, `tags`, `tag_colors`, `peers: Vec<AbPeer>`
- `AbPeer` — one remote peer: `id`, `hash`, `username`, `hostname`, `platform`, `alias`, `tags`
- `AbEntry::personal()` returns true when `name` is `"My address book"` or `"Legacy address book"`
- Local cache stored encrypted+compressed at `{APP_NAME}_ab` via `Ab::store()` / `Ab::load()`

**Server sync**:
- Fetch: `GET /api/ab/get` → parse JSON → populate `ab`
- Push: `POST /api/ab` with full `ab` JSON on every change (`updateAb()` in `ab.tis`)
- Preset auto-join: on sysinfo upload (`src/hbbs_http/sync.rs`), the client sends `OPTION_PRESET_ADDRESS_BOOK_NAME/TAG/ALIAS/PASSWORD/NOTE` so the server can auto-add the device to the right address book

**UI behaviour** (`src/ui/ab.tis`):
- Left pane: tag list — click to filter peers; right-click to delete a tag
- Right pane: `SessionList` with type `"ab"`, supports tile/list toggle and search
- Context menu extras vs other session types: `Edit Tag` (opens `SelectTags` dialog), no `Add to Favorites`
- After every connection `updateAbPeer()` auto-updates username/hostname/platform/alias in the matching `AbPeer` entry

### Libraries (`libs/`)
| Library | Purpose |
|---|---|
| `hbb_common` | Config, protobuf, shared utilities, all options in `src/config.rs` |
| `scrap` | Cross-platform screen capture (X11, Wayland, WinAPI, CoreGraphics) |
| `enigo` | Cross-platform input simulation |
| `clipboard` | Clipboard access |

## Rust Coding Rules

- Avoid `unwrap()` / `expect()` in production code; use `Result` + `?` or explicit handling. Exceptions: tests, and mutex lock acquisition where poisoning is not a normal control flow.
- Avoid unnecessary `.clone()`; prefer borrowing.
- Do not add dependencies unless necessary.
- Assume a Tokio runtime already exists — never create nested runtimes or call `Runtime::block_on()` inside async code.
- Do not hold locks across `.await`.
- Use `spawn_blocking` for CPU-bound or blocking work inside async contexts.
- Do not use `std::thread::sleep()` in async code.

## Editing Hygiene

- Change only what is required; prefer the smallest valid diff.
- Do not refactor or reformat unrelated code.
- Keep naming and style consistent with surrounding code.

## Planning

- Mỗi lần lập plan (kế hoạch triển khai), phải lưu plan đó vào folder `.claude/plans/` dưới dạng file markdown (ví dụ: `.claude/plans/<tên-task>.md`).

## Documentation After Every Task

- Sau khi hoàn thành bất kỳ task nào (thêm tính năng, sửa bug, thay đổi luồng), cập nhật phần liên quan trong `CLAUDE.md`.
- Nếu task liên quan đến nghiệp vụ đặc thù của một module cụ thể (ví dụ: Address Book, File Transfer, Remote Session...), tạo file `docs/<module>.md` riêng mô tả: mục đích, luồng xử lý, các hàm/file chính, và những thay đổi đã thực hiện.
- Mỗi file `docs/<module>.md` nên có cấu trúc: **Overview** → **Key Files** → **Flow** → **Change Log** (ghi ngắn gọn từng thay đổi theo thứ tự thời gian).

## Rebrand: ROCKY + Navy/Teal Theme

App đã được đổi tên và đổi màu theo bộ nhận diện thương hiệu mới (logomark lục giác
6 chấm + nền navy đậm). Khi làm việc với UI, dùng palette sau:

| CSS Variable | Giá trị | Nguồn |
|---|---|---|
| `accent` | `#00D2D3` | teal — logomark + chữ ROCKY |
| `button` | `#58D0F8` | xanh nhạt — chấm giữa logomark |
| `menu-hover` | `#DDF7F6` | tint nhạt của teal |
| `dark-red` (nay dùng làm navy) | `#111D43` | nền navy đậm |
| `text` | `#16234F` | chữ chính (trước là `#222`) |
| `light-text` | `#5C6F94` | chữ phụ/label (trước là `#666`) |
| `lighter-text` | `#8B9BC2` | chữ mờ nhất (trước là `#888`) |
| `border` | `#D7E3F3` | viền input/divider (trước là `#ccc`) |

Bộ màu chữ/viền này được đồng bộ theo đúng `--text`/`--text-muted`/`--border` đang dùng ở
`public/admin.html` (sau khi đổi sang theme sáng) để 2 mặt UI (app desktop + admin web)
cùng tông navy/teal thay vì xám trung tính mặc định. **Lưu ý cú pháp:** Sciter KHÔNG hỗ
trợ `:root{--x}`/`var(--x)` kiểu browser — phải khai báo qua `var(name): value;` trong
block `html { ... }` của `common.css` và đọc bằng `color(name)`.

**Files đã thay đổi:**
- `libs/hbb_common/src/config.rs:72` — `APP_NAME = "ROCKY"`
- `src/ui/common.css:2-13` — CSS variables tông navy/teal
- `src/ui/index.css:344` — gradient hardcode đổi sang navy → teal
- `src/ui/inline.rs` — bundle inline (sinh lại bằng `python3 res/inline-sciter.py` mỗi khi
  sửa CSS/TIS trong `src/ui/`, dùng cho build Windows có feature `inline`)
- `src/lang/en.rs:9` — `Slogan_tip` = "Think Like Hustler." (tagline mới, hiển thị ở
  About dialog `src/ui/index.tis:613`)
- Icon app: **không** còn dùng logo mũi tên RustDesk gốc. Icon cửa sổ trong app là PNG
  base64 nhúng trực tiếp ở `src/ui.rs` (hàm `get_icon()`, 2 nhánh macOS/non-macOS) —
  build-time icon ở `res/icon.ico`, `res/tray-icon.ico`, `res/32x32.png` …
  `res/128x128@2x.png`, `res/mac-icon.png`, `res/mac-tray-*-x2.png`, `res/scalable.svg`.
  Tất cả được crop từ logomark gốc (loại bỏ chữ "ROCKY"/tagline), nền trong suốt.
- `input[type=text/password/number]` (`common.css`) — `border-radius: 0` → `0.4em` để
  khớp bo góc `button.button` (0.5em); `button.button`/`button.outline` thêm
  `font-weight: 600` để chữ nút đậm như `.btn` của admin.html.
- `.card-connect` (qua `@mixin CARD`, `src/ui/index.css:171-181`) — thêm
  `box-shadow: 0 1px 6px rgba(22,35,79,.12)` cho có độ nổi nhẹ giống card admin.html.
- **Khung cảnh báo Wayland đã bị bỏ.** `ModifyDefaultLogin` (cảnh báo
  "wayland_experiment_tip", chỉ hiện khi `handler.current_is_wayland()`) đã bị xoá khỏi
  `src/ui/index.tis`, thay bằng component `BrandLogo` render **không điều kiện** —
  luôn hiện logomark (`<img src={handler.get_icon()}/>`, CSS `.brand-logo-pane` ở
  `src/ui/index.css`) tại đúng vị trí cũ trong `.left-pane`. Cảnh báo Wayland không còn
  hiển thị cho user nữa (đánh đổi đã được user xác nhận). `FixWayland` (cảnh báo Wayland
  khác, dòng `index.tis:742`) vẫn giữ nguyên, không liên quan thay đổi này.

> **Admin UI dùng theme riêng, KHÁC với bảng trên.** `public/admin.html` không theme
> nền navy đậm — sau phản hồi "quá tối" đã đổi thành theme sáng (nền trắng `#F7FAFF`,
> accent teal đậm `#00B8B8`, chi tiết ở `docs/admin-ui.md` Change Log). Khi sửa
> `public/admin.html`, dùng bộ biến CSS riêng khai báo trong `:root` của file đó
> (`--bg`, `--surface`, `--surface-2`, `--accent`, `--accent-2`, `--text`,
> `--text-muted`, `--border`, `--danger`, `--danger-strong`, `--success`), không phải
> palette navy/teal của Sciter UI ở trên.

> Tên app lấy từ `APP_NAME` duy nhất — toàn bộ UI gọi qua `get_app_name()`, không hardcode ở nơi khác.

---

## Web Admin UI (`server.js` + `public/admin.html`)

Giao diện web quản trị chạy song song trên cùng port với gateway Keycloak (`http://127.0.0.1:3000`).

### Chạy
```bash
node server.js
# Admin UI: http://192.168.1.16:3000/admin
# Credentials: admin / admin123
```

> Gateway bind `0.0.0.0:3000` (không phải `127.0.0.1`) để client build từ CI/CD trên máy khác kết nối được
> tới VM. Mọi URL gọi gateway/Keycloak ở phía client (`src/ui.rs`, `src/ui/ab.tis`) và `REDIRECT_URI`/
> `KEYCLOAK_URL` trong `server.js` đang hardcode địa chỉ VM `192.168.1.16` — đổi địa chỉ VM thì phải sửa
> đồng bộ ở cả 2 phía (xem `docs/admin-ui.md` Change Log).

### Kiến trúc
- **`server.js`** — Node.js gateway, dùng built-ins (`http`, `fs`, `crypto`, `node:sqlite`), không có npm dependencies
- **`public/admin.html`** — Single-page HTML thuần, **3 tab**: Người dùng / Danh sách role / Danh sách máy
- **`data/rocky.db`** (tự sinh, SQLite qua `node:sqlite`) — Persistence chính. `data.json` (file cũ) chỉ được đọc **một lần** để migrate dữ liệu lịch sử sang DB nếu bảng `machines` còn rỗng; sau đó không còn được dùng.

### Data model (SQLite — `data/rocky.db`)
```sql
CREATE TABLE machines (
  id TEXT PRIMARY KEY, alias TEXT, rustdesk_id TEXT, note TEXT
);
CREATE TABLE machine_roles (
  role_name TEXT, machine_id TEXT, PRIMARY KEY (role_name, machine_id)
);
```
- Không còn trường `tag` (đã bỏ khỏi quản lý máy trạm — xem `docs/admin-ui.md`).
- `machines.rustdesk_id` — ID thật dùng để kết nối từ RustDesk client (`ab.tis`)
- `machine_roles` — quan hệ N–N giữa role (Keycloak client role) và machine; thay cho `roles[name]: [machineId,...]` của `data.json` cũ
- Chi tiết các hàm truy cập DB (`getAllMachines`, `setMachineRoles`, `getMachinesForRoles`, ...) xem `docs/admin-ui.md`

### Keycloak Service Account (đã config)
Client `rustdesk-client` đã bật **Service accounts roles** với quyền từ `realm-management`:
- `view-users`, `manage-users`, `view-realm`
- **Cần thêm** `manage-realm` để tạo/xoá KC role

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
| Client auth | `POST /api/auth/init`, `GET /api/auth/callback`, `POST /api/auth/status`, `POST /api/auth/logout` |
| Address books | `POST /api/address-books` → `{ machines: [...] }` |

---

## Localization (`src/lang/*.rs`)

Each file is a `HashMap<key, translation>`.

- `template.rs` is the master key list — **never edit it** as part of translation work.
- `en.rs` holds only keys whose display text differs from the key string itself.
- All other language files carry the full key set; untranslated entries have an empty value `("key", "")`.
- To find the English source of a key: look it up in `en.rs`; if absent or empty there, the key string itself is the English text.
- Only fill empty values. Never change keys or touch existing non-empty translations.
- Preserve placeholders (`{}`), escape sequences (`\n`, `\"`), and technical tokens (`RustDesk`, `Socks5`, `TLS`, `UAC`, `Wayland`, `X11`, `TCP`, `UDP`, `2FA`, `RDP`, `D3D`) exactly.
- Copy URL values (e.g. `doc_*` keys) verbatim from `en.rs`.
