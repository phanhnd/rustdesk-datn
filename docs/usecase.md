# Use Case Diagram — ROCKY Remote Desktop System

## Tổng quan tác nhân

| Tác nhân | Mô tả |
|---|---|
| 👑 **Super Admin** | Admin tối cao — full quyền trên Admin UI, duy nhất tạo/xóa Group và phân quyền admin-tier |
| 🔧 **Admin** | Tài khoản có role `manage_users` hoặc `manage_machines` — quản lý user/máy nhưng không tạo Group |
| 👤 **Người dùng** | Nhân viên dùng Rocky Desktop Client — login, xem danh sách máy, kết nối từ xa |
| 🔐 **Keycloak** | Identity Provider — xác thực và cấp JWT cho cả Admin UI lẫn Rocky Client |

---

## Biểu đồ Use Case

```mermaid
flowchart LR
    %% ── ACTORS ────────────────────────────────────────────────
    SA["👑 Super Admin"]
    ADM["🔧 Admin\nmanage_users /\nmanage_machines"]
    USR["👤 Người dùng\nRocky Client"]
    KC(["🔐 Keycloak\nIdentity Provider"])

    %% ── SYSTEM BOUNDARY ───────────────────────────────────────
    subgraph SYS ["🏢 ROCKY Remote Desktop System"]

        subgraph ADMIN_UI ["🖥️  Admin UI  (Web — localhost:3000/admin)"]
            direction TB
            UA1(["Đăng nhập\nSSO"])
            UA2(["Đăng xuất"])
            UA3(["Quản lý User\nCRUD + enable/disable"])
            UA4(["Gán User ↔ Group"])
            UA5(["Phân quyền\nAdmin-tier\n★ Super Admin only"])
            UA6(["Tạo / Xóa Group\n★ Super Admin only"])
            UA7(["Quản lý máy trạm\nCRUD"])
            UA8(["Gán máy ↔ Group"])
            UA9(["Xem Group\n+ thành viên + máy"])
        end

        subgraph CLIENT ["💻 Rocky Desktop Client"]
            direction TB
            UC1(["Đăng nhập\nKeycloak"])
            UC2(["Xem Address Book\ndanh sách máy theo Group"])
            UC3(["Kết nối máy\ntừ xa"])
            UC4(["Đăng xuất"])
        end

        subgraph GW ["⚙️  Rocky Gateway  (Node.js — server.js)"]
            direction TB
            GW1(["Xác thực\nJWT token"])
            GW2(["Kiểm tra quyền\ntruy cập máy"])
            GW3(["Trả về\nAddress Books\ntheo Group"])
        end

    end

    %% ── ACTOR → USE CASE (Admin UI) ───────────────────────────
    SA  --> UA1 & UA2 & UA3 & UA4 & UA5 & UA6 & UA7 & UA8 & UA9
    ADM --> UA1 & UA2 & UA3 & UA4 & UA7 & UA8 & UA9

    %% ── ACTOR → USE CASE (Client) ─────────────────────────────
    USR --> UC1 & UC2 & UC3 & UC4

    %% ── INCLUDE (dashed) ──────────────────────────────────────
    UA1 -. «include» .-> KC
    UA2 -. «include» .-> KC
    UC1 -. «include» .-> KC
    UC4 -. «include» .-> KC

    UC2 -. «include» .-> GW3
    UC3 -. «include» .-> GW2
    GW2 -. «include» .-> GW1
    GW3 -. «include» .-> GW1

    %% ── EXTEND ────────────────────────────────────────────────
    UA5 -. «extend»\nchỉ Super Admin .-> UA3
    UA6 -. «extend»\nchỉ Super Admin .-> UA9
```

---

## Chi tiết Use Case theo nhóm

### Admin UI — Quản lý User (role: `manage_users` hoặc `admin`)

| Use Case | Mô tả ngắn | Endpoint |
|---|---|---|
| Đăng nhập SSO | Redirect → Keycloak → callback → session cookie | `GET /admin/login` → `GET /admin/auth/callback` |
| Đăng xuất | Xóa session + redirect Keycloak logout | `POST /admin/logout` |
| Xem danh sách User | Lấy toàn bộ Keycloak user + group membership | `GET /admin/api/users` |
| Tạo User | Tạo user trong Keycloak | `POST /admin/api/users` |
| Xóa User | Xóa vĩnh viễn khỏi Keycloak | `DELETE /admin/api/users/:id` |
| Enable / Disable | Kích hoạt hoặc vô hiệu hóa tài khoản | `PUT /admin/api/users/:id/enabled` |
| Gán User ↔ Group | Thêm / gỡ user khỏi Keycloak Group | `POST/DELETE /admin/api/users/:id/groups` |
| Phân quyền Admin-tier ★ | Gán/gỡ role `admin`/`manage_users`/`manage_machines` | `POST/DELETE /admin/api/users/:id/admin-roles` |

> ★ Chỉ Super Admin (`admin` role) mới thực hiện được.

---

### Admin UI — Quản lý máy trạm (role: `manage_machines` hoặc `admin`)

| Use Case | Mô tả ngắn | Endpoint |
|---|---|---|
| Xem danh sách máy | Toàn bộ máy trong DB + Group gán | `GET /admin/api/machines` |
| Thêm máy | Tạo bản ghi máy mới (alias, rustdesk_id, note) | `POST /admin/api/machines` |
| Sửa máy | Cập nhật alias / rustdesk_id / note | `PUT /admin/api/machines/:id` |
| Xóa máy | Xóa máy khỏi DB + gỡ toàn bộ group mapping | `DELETE /admin/api/machines/:id` |
| Xem Group + thành viên + máy | Hiện Group với danh sách user và máy trạm | `GET /admin/api/groups` |
| Gán máy ↔ Group | Cập nhật mapping N–N machine ↔ Group | `PUT /admin/api/groups` |
| Tạo Group ★ | Tạo Keycloak Group mới | `POST /admin/api/groups` |
| Xóa Group ★ | Xóa Keycloak Group + toàn bộ mapping | `DELETE /admin/api/groups/:id` |

---

### Rocky Desktop Client — Người dùng cuối

| Use Case | Mô tả ngắn | Endpoint / Cơ chế |
|---|---|---|
| Đăng nhập Keycloak | Mở browser → Keycloak → callback → lưu access_token | `POST /api/auth/init` → `GET /api/auth/callback` → poll `/api/auth/status` |
| Xem Address Book | Tải danh sách máy được phép theo Group của user | `POST /api/address-books` (JWT → groups → machines) |
| Kết nối máy từ xa | Kiểm tra quyền → thiết lập phiên RustDesk | `POST /api/check-access` → RustDesk P2P/relay |
| Đăng xuất | Thu hồi access_token tại Keycloak | `POST /api/auth/logout` (revoke token) |

---

### Gateway — Use Case nội bộ (không actor trực tiếp)

| Use Case | Kích hoạt bởi | Mô tả |
|---|---|---|
| Xác thực JWT token | `check-access`, `address-books` | Introspect token qua Keycloak, cache 30 giây |
| Kiểm tra quyền theo Group | Kết nối máy từ xa | So sánh group của user với group gán máy trong DB |
| Trả về Address Books | Xem Address Book | Lọc danh sách máy theo group membership của user |

---

## Luồng chính (sequence tóm tắt)

```mermaid
sequenceDiagram
    actor USR as 👤 Người dùng
    participant APP as Rocky Client
    participant GW as Gateway
    participant KC as Keycloak

    USR->>APP: Nhấn "Đăng nhập"
    APP->>GW: POST /api/auth/init
    GW-->>APP: { url (Keycloak), session_code }
    APP->>KC: Mở browser → Keycloak login
    KC-->>GW: GET /api/auth/callback?code=...&state=...
    GW->>KC: Exchange code → access_token
    GW-->>APP: Poll /api/auth/status → { access_token }

    USR->>APP: Mở tab Address Book
    APP->>GW: POST /api/address-books (Bearer token)
    GW->>KC: Introspect token → groups
    GW->>GW: getMachinesForGroups(groups)
    GW-->>APP: { machines: [...] }

    USR->>APP: Chọn máy → Kết nối
    APP->>GW: POST /api/check-access { rustdesk_id }
    GW->>KC: Introspect token → groups
    GW->>GW: allowed = groups ∩ machine.groups ≠ ∅
    GW-->>APP: { allowed: true/false }
    APP->>APP: Mở phiên RustDesk hoặc báo lỗi
```

---

## Change Log

| Ngày | Thay đổi |
|---|---|
| 2026-06-25 | Tạo file — biểu đồ use case tổng quan hệ thống ROCKY sau khi tách gateway thành module |
