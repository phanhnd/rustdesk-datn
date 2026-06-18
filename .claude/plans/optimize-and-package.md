# ROCKY — Kế hoạch: Tối ưu mã nguồn + Đóng gói & Phân phối (v3 — đã xác minh hiện trạng + kiến trúc toàn hệ thống)

## Context

Kế hoạch v1 ban đầu được viết **trước** khi `server.js` migrate từ `data.json` sang SQLite (`data/rocky.db`), và chỉ tính tới việc đóng gói gateway + client mà chưa đặt trong bối cảnh toàn hệ thống. Kế hoạch này đã được kiểm tra lại qua nhiều agent Explore đọc trực tiếp `server.js`, `src/ui/ab.tis`, `public/admin.html`, `Cargo.toml`, `.gitignore`, `libs/hbb_common/src/config.rs`, `src/naming.rs`, `src/custom_server.rs`, `src/core_main.rs` để lấy đúng hiện trạng.

**Kiến trúc toàn hệ thống ROCKY gồm 4 tier**, đã xác nhận với người dùng:

| Tier | Có trong repo này? | Nguồn |
|---|---|---|
| **Desktop Client** (Sciter UI, `src/`, `libs/`) | ✅ Có — build từ source repo này | `cargo build --release` → `.deb` (Linux), cross-build cho Windows/macOS |
| **Gateway + Admin UI** (`server.js`, `public/admin.html`) | ✅ Có — build từ source repo này | Node.js, đóng gói qua Docker image riêng |
| **Keycloak** (SSO/Identity Provider) | ❌ Không — dùng image chính thức | `quay.io/keycloak/keycloak` |
| **hbbs/hbbr** (rendezvous + relay server) | ❌ Không — repo riêng `rustdesk/rustdesk-server`, không có source trong repo này | Image chính thức `rustdesk/rustdesk-server` |

Người dùng đã xác nhận: **tự host cả hbbs/hbbr** (không dùng server công khai `rs-ny.rustdesk.com`) để hệ thống độc lập và kiểm soát được, và đóng gói client cho **càng nhiều OS càng tốt** (Linux build trực tiếp được trong môi trường này; Windows/macOS cần cross-build/CI riêng — sẽ chỉ viết script/hướng dẫn, không thực thi được tại đây).

**Cơ chế chính thức để "bake" cấu hình self-host vào client** (đã xác minh trong source, không phải suy đoán):
- `src/naming.rs` — binary `naming <hbbs_pubkey> <hbbs_host> [api_url] [relay_host]` mã hoá 4 giá trị này (base64 của JSON, không cần ký) thành một chuỗi.
- `src/custom_server.rs::get_custom_server_from_string()` — decode lại chuỗi đó thành `CustomServer{key, host, api, relay}`.
- `src/core_main.rs:498-521` — lệnh `rustdesk --config <chuỗi>` (yêu cầu đã cài + quyền root) áp dụng 4 giá trị vào option runtime: `key`, `custom-rendezvous-server` (hbbs host), `api-server` (chính là `handler.get_api_server()` mà `ab.tis` đang dùng — xem mục 1.5!), `relay-server` (hbbr host).
- ⇒ Đây là cách chính thức để gói `.deb`/`.exe` cài xong tự kết nối đúng hbbs/hbbr/gateway tự host, **không cần người dùng tự tay nhập IP server** sau khi cài.

Mục tiêu:
1. **Tối ưu mã nguồn** — vá cấu hình hardcode, hiệu năng I/O, bảo mật cookie, error handling im lặng, dọn code thừa. (không đổi so với v2)
2. **Đóng gói & phân phối toàn hệ thống** — server stack tự host (Keycloak + hbbs/hbbr + rocky-gateway) qua Docker Compose, và desktop client đa nền tảng có baked-in config trỏ về server stack đó.

Các điểm đã đổi so với kế hoạch v1 (Phần 1 không đổi từ v2, xem dưới):
- **Bỏ hẳn hạng mục "cache data.json"** — `server.js` đã dùng SQLite cho mọi CRUD.
- **`.env` đã có trong `.gitignore`**.
- **ab.tis tái dùng `handler.get_api_server()`** (dòng 682, 807) cho 4 endpoint hardcode — không tạo option mới.
- `catch (_)` thực tế **9 chỗ**; chuỗi tiếng Việt hardcode trong `ab.tis` thực tế **4 chỗ** (707, 718, 728, 783).
- `openRoleEditor()` **và** `saveUserRoles()` trong `admin.html` đều có fetch thừa — sửa cả hai.
- **Phần 2 viết lại hoàn toàn** để bao gồm hbbs/hbbr + cơ chế baked-in config (xem dưới) — kế hoạch v1/v2 chỉ có Keycloak + gateway + client, thiếu mảng rendezvous/relay.

---

## Phần 1: Tối ưu mã nguồn

### 1.1. server.js — Chuyển config hardcode sang `.env` ⚡ CRITICAL

**Hiện trạng** (dòng 9–17):
```js
const KEYCLOAK_URL  = 'http://localhost:8080';
const REALM         = 'rustdesk';
const CLIENT_ID     = 'rustdesk-client';
const CLIENT_SECRET = 'wzZwDnLFW02kkOS3gyCdKWNErENBaEEN';
const REDIRECT_URI  = 'http://127.0.0.1:3000/api/auth/callback';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';
```
Listen port/bind hardcode ở dòng 769 (`127.0.0.1`, `3000`).

**Giải pháp**:
1. Thêm hàm `loadEnv()` đầu `server.js`, parse file `.env` thủ công (không dùng dotenv) — set vào `process.env` nếu key chưa tồn tại.
2. Thay 7 hằng số trên (dòng 9–17) bằng `process.env.X || fallback`. `CLIENT_SECRET` và `ADMIN_PASS` không có fallback an toàn — log warning nếu thiếu.
3. Dòng 769: cổng/bind đọc từ `process.env.PORT || 3000`.

**File cần sửa**: `server.js` dòng 9–17, ~769; tạo `.env.example`.

---

### 1.2. server.js — Cache `admin.html` trong memory (Performance)

**Hiện trạng** (dòng 325–335): route `GET /admin` gọi `fs.readFileSync(file)` trên **mọi request**, không cache.

**Giải pháp**: Thêm biến `let adminHtml = null;` ở top-level, load 1 lần (hoặc lazy-load lần đầu rồi giữ trong memory) thay cho đọc đĩa mỗi request.

**File cần sửa**: `server.js` dòng ~325–335.

> Hạng mục "cache `data.json`" của kế hoạch cũ đã **loại bỏ** — không còn áp dụng vì data layer là SQLite.

---

### 1.3. server.js — Vá bảo mật Cookie (Medium)

**Hiện trạng**:
- Dòng 346: `'Set-Cookie': \`admin_token=${token}; HttpOnly; Path=/\`,` — thiếu `SameSite`.
- Dòng 359: `'Set-Cookie': 'admin_token=; Max-Age=0; Path=/',` — thiếu cả `HttpOnly` và `SameSite`.

**Giải pháp**: Thêm `; SameSite=Strict` vào cả hai header (giữ nguyên `HttpOnly`; không thêm `Secure` vì admin UI hiện chạy qua HTTP nội bộ — sẽ là việc khác nếu sau này có TLS).

**File cần sửa**: `server.js` dòng 346, 359.

---

### 1.4. server.js — Sửa silent error handling (Code Quality)

**Hiện trạng**: 9 chỗ `catch (_) { ... }` nuốt lỗi hoàn toàn — dòng **55, 258, 341, 369, 383, 416, 499, 568, 706, 726** (mỗi chỗ bọc một `JSON.parse` hoặc gọi Keycloak).

**Giải pháp**: Thay `catch (_)` bằng `catch (err) { console.error('[ERROR] <context>', err.message); ... }`, giữ nguyên hành vi fallback hiện có (không throw, không đổi response), chỉ thêm log.

**File cần sửa**: `server.js` các dòng nêu trên.

---

### 1.5. src/ui/ab.tis — Dùng `handler.get_api_server()` thay URL hardcode (Flexibility)

**Hiện trạng**: 4 chỗ hardcode `"http://127.0.0.1:3000"` — dòng **705, 734, 757, 798**. Trong khi đó dòng 682 và 807 (cùng file) đã dùng `handler.get_api_server() + "/api/ab/get"` / `"/api/ab"` — đây là cơ chế configurable URL **đã có sẵn** trong RustDesk (option `api-server`, xem `src/ui_interface.rs:1016`, `src/common.rs:1048`).

**Giải pháp**: Thay 4 chỗ hardcode bằng `handler.get_api_server() + "/api/auth/init"` (và tương tự cho `/api/auth/status`, `/api/address-books`, `/api/auth/logout`) — nhất quán với pattern đã dùng trong cùng file, **không** thêm option mới.

**File cần sửa**: `src/ui/ab.tis` dòng 705, 734, 757, 798.

---

### 1.6. src/ui/ab.tis — try-catch JSON.parse + translate() error strings (Robustness)

**Hiện trạng**:
- Dòng 689: `ab = JSON.parse(data.data);` — không có try-catch (so sánh: dòng 655 `JSON.parse(handler.get_lan_peers())` đã có try-catch đúng pattern).
- 4 chuỗi lỗi tiếng Việt hardcode gán vào `abError` (hiển thị trực tiếp lên UI): dòng 707 `"Không thể kết nối tới cổng xác thực"`, dòng 718 `"Lỗi khởi tạo xác thực: " + err`, dòng 728 `"Hết thời gian đăng nhập"`, dòng 783 `"Lỗi tải dữ liệu: " + err`. File đã có pattern `translate("English string")` ở nhiều chỗ (dòng 24, 28, 113) và thậm chí `err = translate(err)` ở dòng 672.

**Giải pháp**:
1. Bọc dòng 689 trong try-catch giống pattern dòng 654–656.
2. Tạo 4 key tiếng Anh mới (vd: `"Failed to connect to auth gateway"`, `"Login timed out"`...), gọi `translate("key")` thay cho chuỗi tiếng Việt cứng tại 4 vị trí trên.
3. Theo quy tắc Localization trong CLAUDE.md: thêm 4 key vào `template.rs` (master list) + `en.rs` (text tiếng Anh) + `vi.rs` (text tiếng Việt = đúng chuỗi hiện tại đang hardcode) — các file ngôn ngữ khác để giá trị rỗng `("key", "")` theo đúng convention hiện có cho key chưa dịch.

**File cần sửa**: `src/ui/ab.tis` dòng 689, 707, 718, 728, 783; `src/lang/template.rs`, `src/lang/en.rs`, `src/lang/vi.rs`.

---

### 1.7. public/admin.html — Loại bỏ fetch thừa (openRoleEditor + saveUserRoles)

**Hiện trạng**: Cả hai hàm fetch lại toàn bộ `/admin/api/users` chỉ để tìm 1 user theo id, trong khi global `allUsers` (khai báo dòng 249, populate trong `loadUsers()` dòng 356) đã có sẵn dữ liệu:
- `openRoleEditor()` dòng 421–423.
- `saveUserRoles()` dòng 457–459.

**Giải pháp**: Thay cả hai đoạn fetch bằng `const user = allUsers.find(u => u.id === userId) || {...};` (giữ default tương ứng từng hàm).

**File cần sửa**: `public/admin.html` dòng 421–423, 457–459.

---

## Phần 2: Đóng gói & Phân phối toàn hệ thống

Repo này chỉ build ra 2 trong 4 tier (Client, Gateway). Keycloak và hbbs/hbbr dùng image chính thức, được orchestrate cùng nhau qua Docker Compose để tạo thành "server stack" tự host hoàn chỉnh. Client build riêng, baked-in config để tự trỏ về server stack đó.

### 2.1. Server stack — Docker Compose (Keycloak + hbbs/hbbr + rocky-gateway)

**File cần tạo**: `docker-compose.yml`, `docker/gateway/Dockerfile` (FROM `node:22-alpine`, build từ `server.js` + `public/` trong repo này).

Services:
- **`keycloak`**: image `quay.io/keycloak/keycloak:26`, realm `rustdesk` auto-import (cần xuất realm JSON từ Keycloak Console hiện tại, theo cấu hình mô tả trong `.claude/baocaoc4.md` / `.claude/plans/keycloak-login-address-book.md` — client `rustdesk-client`, service-account roles `view-users`/`manage-users`/`view-realm`/**`manage-realm`** mới thêm).
- **`hbbs`** + **`hbbr`**: image chính thức `rustdesk/rustdesk-server` (KHÔNG build từ source — repo này không chứa source của nó). Mount volume riêng để giữ keypair `id_ed25519`/`id_ed25519.pub` sinh tự động qua các lần restart (mất key = toàn bộ client phải config lại). Expose port `21115-21119`.
- **`rocky-gateway`**: build từ `docker/gateway/Dockerfile`; mount `.env`; **mount volume riêng cho `/app/data`** để `rocky.db` persist qua restart/rebuild.
- Network bridge nội bộ; ra ngoài chỉ expose port cần thiết (3000 admin/gateway, 8080 keycloak, 21115-21119 hbbs/hbbr).

> Lưu ý triển khai thực tế (không thuộc source repo, cần làm khi vận hành): sau lần đầu `docker compose up`, đọc public key hbbs sinh ra trong volume (file `id_ed25519.pub`) để dùng ở bước 2.3 — đây là giá trị `key` cần bake vào client.

### 2.2. Thêm `data/` vào `.gitignore`

`data/rocky.db` là dữ liệu runtime sinh ra tự động (hiện đang untracked: `?? data/` trong git status) — không nên commit. `data.json` đã được track từ trước (chỉ dùng để migrate 1 lần) — giữ nguyên, không untrack.

**File cần sửa**: `.gitignore` — thêm dòng `data/`.

### 2.3. Bake cấu hình self-host vào client lúc đóng gói ⚡ Quan trọng

Dùng đúng cơ chế chính thức đã xác minh trong source (`src/naming.rs`, `src/custom_server.rs`, `src/core_main.rs:498-521`), thay vì để người dùng tự nhập IP server sau khi cài:

```bash
# 1. Build tool naming (chỉ cần làm 1 lần khi build packaging tooling)
cargo build --release --bin naming

# 2. Sinh chuỗi config từ: hbbs pubkey, hbbs host, gateway API URL, hbbr host
./target/release/naming "<hbbs_id_ed25519_pubkey>" "<hbbs_host>:21116" \
    "http://<gateway_host>:3000" "<hbbr_host>:21117"
# In ra: rustdesk-custom_serverd-<encoded>.exe
```

Tích hợp vào script cài đặt (postinst của `.deb`, hoặc first-run script):
```bash
rustdesk --config "<phần <encoded> lấy từ tên file trên>"
```
Lệnh này set 4 option runtime cùng lúc: `key`, `custom-rendezvous-server` (= hbbs), `api-server` (= gateway — **đây chính là option `handler.get_api_server()` mà `ab.tis` đang dùng ở mục 1.5**, nên không cần cấu hình gì thêm phía client), `relay-server` (= hbbr). Yêu cầu RustDesk đã **cài đặt** và lệnh chạy với quyền root (theo logic tại `core_main.rs:500`).

**File liên quan**: `src/naming.rs`, `src/custom_server.rs`, `src/core_main.rs` (chỉ đọc — không cần sửa code, chỉ cần dùng đúng tool có sẵn); script đóng gói mới `install-client.sh` hoặc tích hợp vào `.deb` postinst.

### 2.4. Đóng gói Rust desktop client — Linux (.deb)

`Cargo.toml` dòng 241–247 đã xác nhận đúng:
```toml
[profile.release]
lto = true
codegen-units = 1
panic = 'abort'
strip = true
#opt-level = 'z' # only have smaller size after strip
rpath = true
```
**Giải pháp**: Bỏ comment dòng 246 (`opt-level = 'z'`) để giảm kích thước binary.

```bash
cargo build --release
python3 build.py
```
Output: `target/release/rustdesk_<version>_amd64.deb`. Build trực tiếp được trong môi trường hiện tại (Linux).

### 2.5. Đóng gói client — Windows (.exe/.msi) và macOS (.dmg)

Môi trường hiện tại là Linux, **không thể build/test trực tiếp** Windows hay macOS tại đây. Phạm vi thực hiện được: viết script + tài liệu hướng dẫn (`docs/packaging-windows.md`, `docs/packaging-macos.md`) mô tả:
- Windows: build trên máy/CI Windows theo hướng dẫn build chính thức của RustDesk (`README.md`), sau đó áp dụng bước 2.3 bằng cách **rename file .exe** thành `rustdesk-custom_serverd-<encoded>.exe` (cơ chế gốc dùng đặt tên file — xem `get_custom_server_from_string()` trong `src/custom_server.rs`, xử lý cả trường hợp Windows tự thêm `(1)`, `(2)` khi trùng tên).
- macOS: build trên máy/CI macOS, đóng gói `.dmg`, áp dụng bước 2.3 qua `rustdesk --config` sau khi cài (tương tự Linux, không dùng cơ chế rename file).
- Cả hai cần CI riêng (GitHub Actions runner Windows/macOS) — ngoài phạm vi thực thi của agent trong môi trường này; chỉ chuẩn bị script/workflow, người dùng tự chạy trên runner thật.

### 2.6. Systemd service cho Node.js Gateway (deploy không dùng Docker)

**File cần tạo**: `res/rocky-gateway.service` — `WorkingDirectory=/opt/rocky-gateway`, `EnvironmentFile=.env`, `ExecStart=/usr/bin/node server.js`, `Restart=on-failure`. Dùng khi không muốn chạy gateway trong Docker (vẫn cần Keycloak + hbbs/hbbr chạy riêng, qua Docker hoặc cài thủ công).

### 2.7. Script cài đặt gateway (`install-gateway.sh`, không dùng Docker)

1. Copy `server.js` + `public/` vào `/opt/rocky-gateway/`.
2. Copy `data.json` (chỉ dùng để seed migrate lần đầu — `migrateFromJsonIfNeeded()` tự tạo `data/rocky.db` khi server start).
3. Tạo thư mục `data/` với quyền ghi cho user `rocky`.
4. Copy `.env.example` → `.env` nếu chưa có.
5. Cài systemd service từ `res/rocky-gateway.service`, `systemctl enable --now rocky-gateway`.

---

## Thứ tự thực hiện

| # | Task | Ưu tiên | File |
|---|---|---|---|
| 1 | `.env` + `loadEnv()` thay config hardcode | CRITICAL | `server.js:9-17,769`, `.env.example` |
| 2 | Cache `admin.html` trong memory | High | `server.js:325-335` |
| 3 | Cookie `SameSite=Strict` | High | `server.js:346,359` |
| 4 | Sửa 9 chỗ `catch (_)` → log lỗi | Medium | `server.js:55,258,341,369,383,416,499,568,706,726` |
| 5 | 4 URL hardcode → `handler.get_api_server()` | Medium | `src/ui/ab.tis:705,734,757,798` |
| 6 | try-catch JSON.parse + translate() 4 chuỗi lỗi | Medium | `src/ui/ab.tis:689,707,718,728,783`, `src/lang/{template,en,vi}.rs` |
| 7 | Bỏ fetch thừa (openRoleEditor + saveUserRoles) | Low | `public/admin.html:421-423,457-459` |
| 8 | Bỏ comment `opt-level='z'` | Low | `Cargo.toml:246` |
| 9 | Thêm `data/` vào `.gitignore` | Packaging | `.gitignore` |
| 10 | Docker Compose: keycloak + hbbs + hbbr + rocky-gateway | Packaging | `docker-compose.yml`, `docker/gateway/Dockerfile` |
| 11 | Script bake config self-host vào client (`naming` + `--config`) | Packaging | `install-client.sh` |
| 12 | Build .deb Linux (bật `opt-level='z'`) | Packaging | `Cargo.toml`, `build.py` |
| 13 | Tài liệu hướng dẫn build Windows/macOS | Packaging | `docs/packaging-windows.md`, `docs/packaging-macos.md` |
| 14 | Systemd service + install-gateway.sh (đường thay thế không-Docker) | Packaging | `res/rocky-gateway.service`, `install-gateway.sh` |

---

## Verification

### Sau tối ưu server.js:
```bash
cp .env.example .env   # điền KC_CLIENT_SECRET, ADMIN_PASS
node server.js
curl -i http://127.0.0.1:3000/admin           # phải redirect / yêu cầu login
curl -i -X POST http://127.0.0.1:3000/admin/login -d '...'   # Set-Cookie phải có SameSite=Strict
```
Sửa file `public/admin.html`/`.env` xong, refresh trang admin nhiều lần — xác nhận nội dung vẫn đúng (cache không làm stale khi chưa restart server; nếu cần reload khi sửa file thì restart server theo thiết kế).

### Sau tối ưu ab.tis:
- Build lại Sciter UI, mở Address Book → đăng nhập qua OAuth → xác nhận luồng vẫn hoạt động với `handler.get_api_server()` (cần set option `api-server` đúng nếu khác `127.0.0.1:3000`).
- Set `api-server` về URL khác → xác nhận cả 6 endpoint (`/api/ab/get`, `/api/ab`, `/api/auth/init`, `/api/auth/status`, `/api/address-books`, `/api/auth/logout`) đều dùng URL mới.
- Đổi ngôn ngữ UI sang English → xác nhận 4 message lỗi hiển thị tiếng Anh thay vì tiếng Việt cứng.

### Sau đóng gói server stack:
```bash
docker compose up -d
# http://localhost:3000/admin đăng nhập được qua Keycloak
# restart container rocky-gateway → machines/roles vẫn còn (volume data/)
# restart container hbbs → key trong volume vẫn còn (không bị đổi id_ed25519 mới)
```

### Sau bake config + đóng gói client (Linux):
```bash
sudo dpkg -i target/release/rustdesk_<version>_amd64.deb
sudo rustdesk --config "<encoded>"   # bake hbbs/hbbr/gateway vào option runtime
rustdesk   # mở app — không cần nhập IP server, Address Book tự gọi đúng gateway tự host
# Settings > Network: xác nhận custom-rendezvous-server/relay-server/api-server đã đúng giá trị self-host
# Thử kết nối 2 máy qua hbbs/hbbr tự host (không qua rs-ny.rustdesk.com)
```
Windows/macOS: không thể tự verify trong môi trường này — chỉ kiểm tra script/tài liệu hợp lý, để người dùng build & test trên CI/máy thật.
