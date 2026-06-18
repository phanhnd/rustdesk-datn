# Admin UI & Gateway (server.js + public/admin.html)

## Overview

Gateway Node.js (`server.js`) và giao diện quản trị web (`public/admin.html`) cho phép quản trị viên IT quản lý **máy trạm (machines)**, **vai trò (roles)** và **người dùng Keycloak**, đồng thời phục vụ luồng đăng nhập SSO và kiểm soát truy cập cho client ROCKY (`src/ui/ab.tis`). Dữ liệu máy trạm và ánh xạ role↔máy được lưu trong SQLite (`data/rocky.db`) thông qua module built-in `node:sqlite` — không có npm dependency.

## Key Files

| File | Vai trò |
|---|---|
| `server.js` | HTTP server: Admin REST API, OIDC auth proxy với Keycloak, endpoint kiểm soát truy cập, lớp truy cập SQLite |
| `public/admin.html` | SPA quản trị: 3 tab Người dùng / Danh sách role / Danh sách máy |
| `data/rocky.db` | SQLite database (tự sinh khi chạy `node server.js` lần đầu) |
| `data.json` | File JSON lịch sử — chỉ đọc một lần để migrate sang `data/rocky.db` nếu DB còn rỗng, sau đó không còn được dùng |
| `src/ui/ab.tis` | Client Sciter — gọi `/api/address-books`, `/api/check-access`, hiển thị danh sách máy theo role |

## Flow

### Schema SQLite

```sql
CREATE TABLE machines (
  id          TEXT PRIMARY KEY,
  alias       TEXT NOT NULL DEFAULT '',
  rustdesk_id TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT ''
);
CREATE TABLE machine_roles (
  role_name  TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  PRIMARY KEY (role_name, machine_id)
);
```

Không có cột `tag` (đã bỏ khỏi mô hình máy trạm — xem Change Log). Quan hệ N–N giữa role và máy lưu trực tiếp trong `machine_roles`.

### Lớp truy cập dữ liệu trong `server.js`

| Hàm | Việc làm |
|---|---|
| `getAllMachines()` | Lấy toàn bộ máy, gắn thêm `roles: [...]` cho mỗi máy |
| `getMachineById(id)` / `getMachineByRustdeskId(rid)` | Tra cứu 1 máy |
| `insertMachine()` / `updateMachine()` / `deleteMachine()` | CRUD máy (xóa máy tự xóa luôn các dòng `machine_roles` liên quan) |
| `setMachineRoles(machineId, roleNames)` | Ghi lại toàn bộ role của 1 máy |
| `getRolesMap()` | `{roleName: [machineId,...]}` — dùng cho `GET /admin/api/roles` |
| `setRoleMachineIds(roleName, ids)` | Ghi lại toàn bộ máy thuộc 1 role — dùng cho `PUT /admin/api/roles` |
| `deleteRoleMapping(roleName)` | Xóa toàn bộ mapping của 1 role (khi xóa KC role) |
| `getMachinesForRoles(roleNames)` | Trả về máy (kèm `roles`) mà ít nhất 1 role trong danh sách có quyền — dùng cho `/api/check-access` và `/api/address-books` |

### Migration một lần từ `data.json`

Khi khởi động, `migrateFromJsonIfNeeded()` kiểm tra `SELECT COUNT(*) FROM machines`:
- Nếu > 0 → bỏ qua (đã có dữ liệu, không migrate lại).
- Nếu = 0 và `data.json` tồn tại → đọc từng `machine` (bỏ field `tag`) và từng `roles[roleName] = [...]` để insert vào 2 bảng.
- Nếu = 0 và không có `data.json` → seed 3 máy demo.

### Luồng kiểm soát truy cập / Address Book (không đổi về API contract)

```
ROCKY client (ab.tis / ui.rs)
    │ POST /api/check-access {rustdesk_id} + Bearer token
    │ POST /api/address-books            + Bearer token
    ▼
server.js: decode JWT → roles → getMachinesForRoles(roles)
    ▼
SQLite (machines ⨝ machine_roles)
```

`/api/address-books` trả về mỗi machine kèm field `roles: [...]` (role Keycloak được gán cho máy đó) — `ab.tis` dùng field này để dựng panel filter bên trái Address Book (trước đây dựng từ `tag`, nay dựng từ `roles`).

## Change Log

- **2026-06-17** — Thay `data.json` (JSON phẳng) bằng SQLite (`data/rocky.db`, qua `node:sqlite`) làm persistence chính cho `machines` + `machine_roles`. Giữ `data.json` làm migrate-source một lần, không xóa.
- **2026-06-17** — Bỏ hoàn toàn trường `tag` khỏi mô hình máy trạm: schema DB, `GET/POST/PUT /admin/api/machines`, `GET /admin/api/roles`, và toàn bộ UI quản lý máy/role trong `public/admin.html`.
- **2026-06-17** — `src/ui/ab.tis` (`getAddressBooks()`): panel filter "Tags" bên trái Address Book nay dựng từ `machine.roles` (trả về từ `/api/address-books`) thay cho `machine.tag` đã bị xóa. Hành vi filter/chọn tag trong UI không đổi, chỉ đổi nguồn dữ liệu.
- **2026-06-17** — Vá lỗi tồn đọng tại `POST /api/check-access`: handler tham chiếu biến `body` chưa từng được đọc từ request (do `readBody`/`JSON.parse` trước đó chỉ chạy trong nhánh `/admin/api/*`), khiến endpoint luôn lỗi và phụ thuộc hoàn toàn vào timeout 800ms phía client (failopen). Đã thêm đọc/parse body riêng cho endpoint này.
