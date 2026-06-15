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

## Rebrand: ROCKY + Blue Theme

App đã được đổi tên và màu sắc. Khi làm việc với UI, dùng palette xanh sau:

| CSS Variable | Giá trị |
|---|---|
| `accent` | `#1565C0` |
| `button` | `#42A5F5` |
| `menu-hover` | `#E3F2FD` |
| `dark-red` (nay dùng làm navy) | `#0D47A1` |

**Files đã thay đổi:**
- `libs/hbb_common/src/config.rs:72` — `APP_NAME = "ROCKY"`
- `src/ui/common.css` — CSS variables tông xanh
- `src/ui/index.css:344` — gradient hardcode đổi sang xanh

> Tên app lấy từ `APP_NAME` duy nhất — toàn bộ UI gọi qua `get_app_name()`, không hardcode ở nơi khác.

---

## Web Admin UI (`server.js` + `public/admin.html`)

Giao diện web quản trị chạy song song trên cùng port với gateway Keycloak (`http://127.0.0.1:3000`).

### Chạy
```bash
node server.js
# Admin UI: http://127.0.0.1:3000/admin
# Credentials: admin / admin123
```

### Kiến trúc
- **`server.js`** — Node.js gateway, dùng built-ins (`http`, `fs`, `crypto`), không có npm dependencies
- **`public/admin.html`** — Single-page HTML thuần, **3 tab**: Người dùng / Danh sách role / Danh sách máy
- **`data.json`** (tự sinh) — Persistence; tự migrate từ model cũ (books/peers) sang model mới (machines)

### Data model `data.json`
```json
{
  "machines": [{ "id": "<hex>", "alias": "...", "rustdesk_id": "...", "tag": "...", "note": "..." }],
  "roles":    { "admin": ["<machine-id>", ...], "viewer": ["<machine-id>"] }
}
```
- `machines[].rustdesk_id` — ID thật dùng để kết nối từ RustDesk client (`ab.tis`)
- `roles[name]` — array of machine internal `id`

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
