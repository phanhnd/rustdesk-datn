# Tổng hợp Sequence Diagram — ROCKY

## Overview

File này gom **tất cả** sequence diagram (mermaid) đang mô tả nghiệp vụ của ROCKY vào một
chỗ duy nhất, để xem nhanh toàn cảnh các luồng tương tác giữa Sciter client, Rust core,
gateway (`server.js`), Keycloak và SQLite (`data/rocky.db`) mà không phải mở từng file
`docs/<module>.md` riêng lẻ.

**File này KHÔNG phải nguồn chính (source of truth)** — mỗi diagram vẫn sống ở file gốc
của module đó, kèm phần "Điểm chú ý" giải thích chi tiết + rủi ro. Khi luồng đổi, sửa ở
file gốc trước, rồi đồng bộ lại bản copy ở đây. File gốc tương ứng được ghi rõ trên mỗi
diagram.

## Danh sách biểu đồ

| # | Diagram | Nguồn | Trạng thái |
|---|---|---|---|
| 1 | Login Keycloak (Address Book) | `docs/address-book.md` | Đã implement |
| 2 | Check-access trước khi connect | `docs/address-book.md` | Đã implement |
| 3 | Logout (Address Book) | `docs/address-book.md` | Đã implement |
| 4 | Đăng nhập Admin UI (tier-aware) | `docs/admin-ui.md` | Đã implement |
| 5 | Tạo user + gán Group + gán admin-tier role | `docs/admin-ui.md` | Đã implement |
| 6 | Tạo Keycloak Group + map Group↔máy (+ xoá group) | `docs/admin-ui.md` | Đã implement |
| 7 | Lấy hồ sơ user qua `/userinfo` | `docs/user-profile-auth-notes.md` | **Đề xuất — chưa implement** |
| 8 | Đăng nhập Admin UI — chi tiết nhánh 2FA (Conditional OTP) | `docs/keycloak.md` | Đã implement |
| 9 | Quản trị máy trạm (tạo / sửa + gán group / xoá máy) | `server.js` + `public/admin.html` | Đã implement |
| 10 | Đăng xuất Admin UI | `server.js` + `public/admin.html` | Đã implement |

---

## 1. Login Keycloak (Address Book)

> Nguồn: [`docs/address-book.md`](address-book.md) — mục "1. Login"

```mermaid
sequenceDiagram
    actor User
    participant TIS as Sciter UI 
    participant Rust as Rust 
    participant GW as server.js 
    participant KC as Keycloak 
    participant DB as rocky.db 
    participant BR as Browser 

    User->>TIS: Click "Login"
    TIS->>GW: POST /api/auth/init
    GW->>GW: sweepStaleSessions() (dọn session quá 10 phút)<br/>sinh session_code, sessions.set(pending:true, createdAt:now)
    GW-->>TIS: { url, session_code }
    TIS->>Rust: handler.open_url(url)
    Rust->>BR: mở trình duyệt hệ thống
    TIS->>TIS: abWaitingBrowser = true

    loop pollKeycloakAuth mỗi 2s (tối đa 60 lần)
        TIS->>GW: POST /api/auth/status { session_code }
        GW-->>TIS: { pending: true }
    end

    BR->>KC: GET /auth?state=session_code...
    User->>KC: Nhập tài khoản / mật khẩu
    KC->>BR: redirect → /api/auth/callback?code&state
    BR->>GW: GET /api/auth/callback?code&state
    GW->>KC: POST /token (exchange code)
    KC-->>GW: { access_token }
    GW->>GW: sessions.set(state, {access_token, pending:false})
    GW-->>BR: HTML "Login thành công, đóng tab này"

    TIS->>GW: POST /api/auth/status { session_code }
    GW->>GW: sessions.delete(session_code)
    GW-->>TIS: { access_token }

    TIS->>Rust: handler.set_local_option("access_token", token)
    Rust->>Rust: LocalConfig::set_option (lưu mã hoá)

    TIS->>GW: POST /api/address-books (Bearer token)
    GW->>GW: introspectTokenCached(token) → verify active+exp qua Keycloak (cache 30s)<br/>→ claim "groups" → getGroupsFromPayload()
    GW->>DB: SELECT machines JOIN machine_groups WHERE group_name IN (groups)
    DB-->>GW: machines[]
    GW-->>TIS: { machines: [...] }

    TIS->>TIS: ab.tags = groups distinct<br/>ab.peers = machines
    TIS->>TIS: app.update() → render SessionList
    TIS-->>User: Hiển thị danh sách Address Book
```

Điểm chú ý (chi tiết đầy đủ ở file gốc): `BR` và `TIS` là 2 tiến trình tách biệt, chỉ nối
qua `session_code` (entry tự dọn sau 10 phút nếu bỏ ngang, `sweepStaleSessions()`); Rust
chỉ tham gia ở `open_url` và lưu token; `introspectTokenCached` verify chữ ký + `exp` thật
qua Keycloak (đã fix 2026-06-22, thay `decodeJwtPayload` cũ).

---

## 2. Check-access trước khi connect (Address Book)

> Nguồn: [`docs/address-book.md`](address-book.md) — mục "2. Check-access trước khi connect"

```mermaid
sequenceDiagram
    actor User
    participant TIS as Sciter UI (index.tis)
    participant Rust as Rust (ui.rs)
    participant GW as server.js (Gateway :3000)
    participant DB as rocky.db (SQLite)

    User->>TIS: Click connect tới remote_id
    TIS->>TIS: createNewConnect(id, type)
    TIS->>Rust: handler.check_access_blocking(id)

    Rust->>Rust: token = LocalConfig::get_option("access_token")
    Rust->>GW: POST /api/check-access<br/>{ rustdesk_id: id }<br/>Authorization: Bearer token (nếu có)

    alt Lỗi mạng / gateway offline (timeout 800ms)
        GW--xRust: (request lỗi/timeout)
        Rust-->>TIS: "" (fail-open)
    else Gateway phản hồi
        GW->>DB: SELECT * FROM machines WHERE rustdesk_id = ?
        alt Máy không có trong DB
            DB-->>GW: null
            GW-->>Rust: { allowed: true }
            Rust-->>TIS: "" (cho qua)
        else Máy có trong DB
            DB-->>GW: machine
            GW->>GW: introspectTokenCached(token)
            alt Không có token / token không active (giả, hết hạn, đã revoke)
                GW-->>Rust: { allowed: false, reason: "login_required" }
                Rust-->>TIS: "Bạn cần đăng nhập để kết nối máy này"
            else Token active (verify qua Keycloak)
                GW->>GW: groups = getGroupsFromPayload(introspection.payload)
                GW->>DB: SELECT machines JOIN machine_groups WHERE group_name IN (groups)
                DB-->>GW: allowedIds
                alt machine.id thuộc allowedIds
                    GW-->>Rust: { allowed: true }
                    Rust-->>TIS: "" (cho qua)
                else machine.id không thuộc allowedIds
                    GW-->>Rust: { allowed: false, reason: "no_permission" }
                    Rust-->>TIS: "Bạn không có quyền truy cập máy này"
                end
            end
        end
    end

    alt err rỗng ("")
        TIS->>Rust: handler.set_remote_id(id)
        TIS->>Rust: handler.new_remote(id, type, force_relay)
        Rust-->>User: Mở session remote
    else err có nội dung
        TIS->>User: msgbox("custom-error", err)
    end
```

Điểm chú ý: chạy đồng bộ/blocking (`reqwest::blocking`); fail-open ở 2 lớp (lỗi mạng và
máy không tồn tại trong DB) — chỉ là UX gate, không phải security boundary đáng tin cậy.

---

## 3. Logout (Address Book)

> Nguồn: [`docs/address-book.md`](address-book.md) — mục "3. Logout"

```mermaid
sequenceDiagram
    actor User
    participant TIS as Sciter UI (ab.tis)
    participant Rust as Rust (LocalConfig)
    participant GW as server.js (Gateway :3000)
    participant KC as Keycloak (:8080)

    User->>TIS: Click "Logout"
    TIS->>TIS: logoutFromKeycloak()
    TIS->>Rust: handler.get_local_option("access_token")
    Rust-->>TIS: token

    Note over TIS: Xoá state + render lại NGAY,<br/>không chờ kết quả revoke
    TIS->>Rust: set_local_option("access_token", "")
    TIS->>Rust: set_local_option("selected-tags", "")
    TIS->>TIS: ab = { tags: [], peers: [] }
    TIS->>TIS: app.update() → UI chuyển về nút "Login" NGAY

    alt token không rỗng
        TIS->>GW: POST /api/auth/logout<br/>Authorization: Bearer token<br/>(fire-and-forget, log warning nếu revoked:false)
        GW->>KC: POST /protocol/openid-connect/revoke<br/>{ client_id, client_secret, token }
        alt revoke thành công (HTTP 2xx)
            KC-->>GW: 200
            GW->>GW: revoked = true
        else revoke lỗi (HTTP lỗi hoặc network error)
            KC--xGW: lỗi / status != 2xx
            GW->>GW: revoked = false<br/>console.error("Token revoke failed", ...)
        end
        GW->>GW: introspectionCache.delete(token)
        GW-->>TIS: { ok: true, revoked }
    end
```

Điểm chú ý: thứ tự thật là xoá state local → cập nhật UI ngay → mới gửi POST logout; server
giờ trả `revoked` đúng thực tế (đã fix 2026-06-22, thay vì luôn `{ok:true}` bất kể revoke
thành công hay không), kèm xoá token khỏi `introspectionCache` ngay khi logout.

---

## 4. Đăng nhập Admin UI — tier-aware

> Nguồn: [`docs/admin-ui.md`](admin-ui.md) — mục "Đăng nhập Admin UI"

```mermaid
sequenceDiagram
    actor Admin
    participant UI as admin.html
    participant GW as server.js
    participant KC as Keycloak

    Admin->>UI: Click "Đăng nhập với Keycloak"
    UI->>GW: GET /admin/login
    GW-->>Admin: 302 → Keycloak /auth (prompt=login)
    Admin->>KC: Nhập username/password
    KC-->>GW: GET /admin/auth/callback?code&state
    GW->>KC: POST /token, POST /token/introspect
    KC-->>GW: introspection { active, resource_access }
    GW->>GW: roles = getRolesFromPayload(introspection, "rocky-admin")
    alt không có admin/manage_users/manage_machines
        GW-->>Admin: 403 "Tài khoản không có quyền quản trị"
    else có ít nhất 1 trong 3 role admin-tier
        GW->>GW: tạo admin_session { sub, username, roles, expiresAt }
        GW-->>Admin: Set-Cookie admin_session, 302 → /admin
    end
    UI->>GW: GET /admin/session
    GW-->>UI: { authenticated: true, username, roles }
    UI->>UI: myAdminRoles = roles; applyTierVisibility() — ẩn/hiện tab + nút theo tier
```

Điểm chú ý: `requireAdminAuth(req, res, allowedRoles)` gate theo tier ở từng route; `admin`
luôn bypass mọi tier-check; `requireSuperAdmin()` riêng cho route chỉ admin tối cao.

---

## 5. Tạo user + gán Group (machine-access) + gán admin-tier role

> Nguồn: [`docs/admin-ui.md`](admin-ui.md) — mục "Luồng tạo user + gán Group"

```mermaid
sequenceDiagram
    actor Super as Admin tối cao
    actor UAdmin as User-admin (manage_users)
    participant UI as admin.html (tab Người dùng)
    participant GW as server.js
    participant KC as Keycloak

    UAdmin->>UI: Nhập username/password/email, Submit
    UI->>GW: POST /admin/api/users {username, password, email, ...}
    Note over GW: requireAdminAuth(req,res,[manage_users])
    GW->>GW: getServiceToken() (cache, client_credentials grant)
    GW->>KC: POST /admin/realms/:realm/users<br/>{username, enabled:true, credentials:[{password}]}
    KC-->>GW: 201 Created, header Location: .../users/{id}
    GW-->>UI: { ok: true, id }

    UAdmin->>UI: "Gán group" cho user vừa tạo, tick group, Submit
    UI->>GW: POST /admin/api/users/:id/groups { groupIds: [...] }
    Note over GW: requireAdminAuth(req,res,[manage_users])
    GW->>KC: PUT /admin/realms/:realm/users/:id/groups/:groupId
    KC-->>GW: 204
    GW-->>UI: { ok: true }

    Super->>UI: "Gán admin-tier" cho user khác, tick admin/manage_users/manage_machines, Submit
    UI->>GW: POST /admin/api/users/:id/admin-roles { roles: [...] }
    Note over GW: requireSuperAdmin(req,res) — chỉ admin tối cao
    GW->>GW: getClientUuid('rocky-admin') (cache theo Map, không còn 1 biến duy nhất)
    GW->>KC: POST /admin/realms/:realm/users/:id/role-mappings/clients/:uuid { roles }
    KC-->>GW: 204
    GW-->>UI: { ok: true }
```

Điểm chú ý: gán Group (machine-access) và gán role admin-tier là 2 route tách biệt với 2
tier-gate khác nhau — `manage_users` không gán được role admin-tier (tránh leo thang
quyền); tạo user và gán Group/role là các request riêng, không transaction.

---

## 6. Tạo Keycloak Group + map Group↔máy (gồm nhánh xoá group)

> Nguồn: [`docs/admin-ui.md`](admin-ui.md) — mục "Luồng tạo Keycloak Group + map Group↔máy"

```mermaid
sequenceDiagram
    actor Super as Admin tối cao
    actor MAdmin as Machine-admin (manage_machines)
    participant UI as admin.html (tab Danh sách group)
    participant GW as server.js
    participant KC as Keycloak
    participant DB as rocky.db (SQLite)

    %% --- Tạo group mới: CHỈ admin tối cao ---
    Super->>UI: Nhập tên group mới, Submit
    UI->>GW: POST /admin/api/groups { name }
    Note over GW: requireSuperAdmin(req,res)
    GW->>KC: POST /admin/realms/:realm/groups { name }
    KC-->>GW: 201 Created
    GW-->>UI: { ok: true }
    Note over DB: machine_groups chưa có dòng nào cho group mới → mặc định 0 máy

    %% --- Map group <-> máy: machine-admin sở hữu (không phải super-admin-exclusive) ---
    MAdmin->>UI: Mở chi tiết group, tick/bỏ tick các máy
    UI->>GW: PUT /admin/api/groups { groupName: [machineId, ...] }
    Note over GW: requireAdminAuth(req,res,[manage_machines])
    Note over UI,GW: body = TOÀN BỘ danh sách máy MỚI của group<br/>(replace, không phải "thêm/bớt")
    GW->>GW: setGroupMachineIds(groupName, ids)
    GW->>DB: DELETE FROM machine_groups WHERE group_name=?
    Note over GW,DB: 2 lệnh KHÔNG transaction — crash giữa lúc này group tạm thời 0 máy
    GW->>DB: INSERT OR IGNORE (group_name, machine_id)<br/>cho từng id còn machineExists()=true
    DB-->>GW: ok
    GW-->>UI: { ok: true }

    %% --- Xoá group: CHỈ admin tối cao ---
    Note over Super,DB: Xoá group
    Super->>UI: Xoá group
    UI->>GW: DELETE /admin/api/groups/:id
    Note over GW: requireSuperAdmin(req,res)
    GW->>GW: resolve id→name (listGroups()) trước khi xoá ở Keycloak
    GW->>KC: DELETE /admin/realms/:realm/groups/:id
    KC-->>GW: 204
    GW->>GW: deleteGroupMapping(groupName)
    GW->>DB: DELETE FROM machine_groups WHERE group_name=?
    DB-->>GW: ok
    GW-->>UI: { ok: true }
```

Điểm chú ý: tạo/xoá Group là độc quyền admin tối cao; map Group↔máy là việc của
machine-admin; Group là realm-level (không cần `clientUuid` như role cũ); xoá Group là 2
lệnh tách biệt (Keycloak rồi SQLite), không transaction.

---

## 7. [ĐỀ XUẤT — CHƯA IMPLEMENT] Lấy hồ sơ user qua `/userinfo`

> Nguồn: [`docs/user-profile-auth-notes.md`](user-profile-auth-notes.md) — "Hướng A"
>
> **Trạng thái: chưa có code nào được viết cho luồng này.** Diagram dưới đây mô tả hướng
> triển khai được khuyến nghị (Hướng A) cho tính năng hiển thị "Hi, {tên}" trên UI Sciter
> sau khi login Keycloak, dựa trên `access_token` đã có sẵn từ luồng Login (diagram #1).
> Vẽ ra để làm rõ thiết kế trước khi code, không phản ánh hành vi hiện tại của app.

```mermaid
sequenceDiagram
    actor User
    participant TIS as Sciter UI (ab.tis)
    participant Rust as Rust (ui.rs)
    participant GW as server.js (Gateway :3000)
    participant KC as Keycloak (:8080)

    Note over TIS,Rust: access_token đã có sẵn từ luồng Login (diagram #1)
    TIS->>Rust: handler.get_user_profile() [hàm mới — chưa tồn tại]
    Rust->>Rust: token = LocalConfig::get_option("access_token")
    Rust->>GW: GET /api/profile [endpoint mới — chưa tồn tại]<br/>Authorization: Bearer token
    GW->>KC: GET /realms/:realm/protocol/openid-connect/userinfo<br/>Authorization: Bearer token
    alt token hợp lệ
        KC-->>GW: { name, preferred_username, email, ... }
        GW-->>Rust: { name, email }
        Rust-->>TIS: { name, email }
        TIS->>TIS: render "Hi, {name}"
    else token hết hạn/không hợp lệ
        KC--xGW: 401
        GW-->>Rust: { error: "invalid_token" }
        Rust-->>TIS: null
        TIS->>TIS: giữ nguyên UI hiện tại (không hiển thị tên)
    end
```

Điểm chú ý (xem đầy đủ ở file gốc): Keycloak tự verify token trước khi trả profile qua
`/userinfo` — không cần gateway tự verify JWT như `decodeJwtPayload()` đang làm; nhược
điểm là thêm 1 round-trip HTTP mỗi lần cần hiển thị hồ sơ (có thể cache phía gateway);
`access_token` TTL ngắn (~300s mặc định Keycloak) nên cần tính tới hết hạn giữa session.

---

## 8. Đăng nhập Admin UI — chi tiết nhánh 2FA (Conditional OTP)

> Nguồn: [`docs/keycloak.md`](keycloak.md) — mục "2. Login Admin UI"

Bản chi tiết hơn diagram #4 — bóc rõ nhánh Keycloak tự xử lý 2FA (đăng ký OTP lần đầu /
nhập OTP đã có), chỉ áp dụng cho role `admin` (admin tối cao), phản ánh đúng code hiện tại
(kiểm tra **3 role admin-tier** ở bước callback, không chỉ riêng `admin`).

```mermaid
sequenceDiagram
    actor Admin
    participant UI as admin.html
    participant GW as server.js
    participant KC as Keycloak (flow browser-admin-otp)

    Admin->>UI: Click "Đăng nhập với Keycloak"
    UI->>GW: GET /admin/login
    GW->>GW: sinh state (CSRF), adminLoginStates.set(state, +5 phút)
    GW-->>Admin: 302 → Keycloak /auth?client_id=rocky-admin<br/>&redirect_uri=.../admin/auth/callback&state=...&prompt=login

    Admin->>KC: GET /auth?... (prompt=login ép hiện lại form,<br/>bỏ qua cookie SSO KEYCLOAK_SESSION cũ)
    KC-->>Admin: Form đăng nhập username/password
    Admin->>KC: Nhập username/password
    KC->>KC: Xác thực user/pass đúng
    KC->>KC: Evaluate flow browser-admin-otp:<br/>Condition - user role == rocky-admin.admin ?

    alt User có role "admin" (admin tối cao)
        alt Chưa có OTP credential
            KC-->>Admin: Hiện QR code đăng ký OTP
            Admin->>Admin: Quét QR bằng app authenticator
            Admin->>KC: Nhập mã 6 số để xác nhận đăng ký
            KC->>KC: Lưu OTP credential cho user
        else Đã có OTP credential
            KC-->>Admin: Hiện form nhập mã OTP
            Admin->>KC: Nhập mã 6 số hiện tại trên app
            KC->>KC: Verify TOTP(secret, time) == mã nhập
        end
    else User chỉ có manage_users / manage_machines / không role nào
        Note over KC: KHÔNG bị bắt OTP — Condition chỉ match role "admin"
    end

    KC-->>Admin: 302 → /admin/auth/callback?code=...&state=...
    Admin->>GW: GET /admin/auth/callback?code&state
    GW->>GW: state khớp adminLoginStates? (chống CSRF, xoá state sau khi dùng)
    GW->>KC: POST /token (exchange code, client_id=rocky-admin + secret)
    KC-->>GW: { access_token }
    GW->>KC: POST /token/introspect (client_id=rocky-admin + secret)
    KC-->>GW: { active, sub, preferred_username, resource_access }
    GW->>GW: roles = getRolesFromPayload(introspection, "rocky-admin")

    alt active=false hoặc không có role nào trong [admin, manage_users, manage_machines]
        GW-->>Admin: 403 "Tài khoản không có quyền quản trị"
    else có ≥1 role admin-tier
        GW->>GW: adminSessions.set(sessionToken, {sub, username, roles,<br/>expiresAt: now + 8h})
        GW-->>Admin: Set-Cookie admin_session (HttpOnly, SameSite=Lax, 8h)<br/>302 → /admin
    end
```

Điểm chú ý: **2FA chỉ bind với role `admin`** — `manage_users`/`manage_machines` đăng
nhập được mà không bị bắt OTP, đây là gap chưa được quyết định lại sau khi mở rộng 3-tier
(xem chi tiết rủi ro ở `docs/keycloak.md`); verify token dùng **introspection** (Keycloak
tự verify signature+expiry), không phải `decodeJwtPayload()` tự decode như luồng client.

## 9. Quản trị máy trạm (tạo / sửa + gán group / xoá máy)

> Nguồn: rà soát trực tiếp `server.js` (route `POST`/`PUT`/`DELETE /admin/api/machines...`)
> + `public/admin.html` (tab "Danh sách máy", hàm `addMachine`/`openEditMachine`/
> `saveEditMachine`/`deleteMachine`). **Chưa đồng bộ sang `docs/admin-ui.md`** — file gốc
> module này cần bổ sung diagram tương ứng sau.

```mermaid
sequenceDiagram
    actor MAdmin as Machine-admin (manage_machines)
    participant UI as admin.html (tab Danh sách máy)
    participant GW as server.js
    participant DB as rocky.db (SQLite)

    %% --- Tạo máy mới ---
    MAdmin->>UI: Nhập alias/rustdesk_id/note, Submit (addMachine)
    UI->>GW: POST /admin/api/machines { alias, rustdesk_id, note }
    Note over GW: requireAdminAuth(req,res,[manage_machines])
    GW->>GW: insertMachine() — sinh id = randomBytes(8).hex
    GW->>DB: INSERT INTO machines (id, alias, rustdesk_id, note)
    DB-->>GW: ok
    GW-->>UI: { ok: true, id }
    UI->>UI: loadMachines() — render lại bảng

    %% --- Sửa máy + gán group (replace toàn bộ) ---
    MAdmin->>UI: openEditMachine() → tick/bỏ tick group, Submit (saveEditMachine)
    UI->>GW: PUT /admin/api/machines/:id { alias, rustdesk_id, note, groups: [...] }
    Note over GW: requireAdminAuth(req,res,[manage_machines])
    GW->>GW: updateMachine(id, {...}) — field undefined giữ giá trị cũ
    GW->>DB: UPDATE machines SET alias=?, rustdesk_id=?, note=? WHERE id=?
    alt machine không tồn tại
        GW-->>UI: 404 { error: "Machine not found" }
    else machine tồn tại
        GW->>GW: setMachineGroups(id, groups) — replace, không merge
        GW->>DB: DELETE FROM machine_groups WHERE machine_id=?
        GW->>DB: INSERT OR IGNORE (group_name, machine_id) cho từng group còn lại
        DB-->>GW: ok
        GW-->>UI: { ok: true }
        UI->>UI: loadMachines() + loadGroups() — render lại bảng máy & group
    end

    %% --- Xoá máy ---
    MAdmin->>UI: Click "Xoá", confirm() (deleteMachine)
    UI->>GW: DELETE /admin/api/machines/:id
    Note over GW: requireAdminAuth(req,res,[manage_machines])
    GW->>GW: deleteMachine(id)
    GW->>DB: DELETE FROM machine_groups WHERE machine_id=?
    GW->>DB: DELETE FROM machines WHERE id=?
    DB-->>GW: ok
    GW-->>UI: { ok: true }
    UI->>UI: loadMachines() + loadGroups() — render lại bảng máy & group
```

Điểm chú ý: cả 3 route đều gate bằng cùng 1 tier `manage_machines` (không tách
tạo/sửa/xoá như bên Group); `id` máy là `crypto.randomBytes(8).hex` sinh ở server, độc
lập hoàn toàn với `rustdesk_id` (ID thật dùng để kết nối); `PUT` ghi `groups` theo kiểu
**replace toàn bộ** (2 câu SQL `DELETE`+`INSERT` không transaction); xoá máy tự xoá luôn
mapping `machine_groups` liên quan trước khi xoá dòng `machines`, không động tới
Keycloak vì machine chỉ là dữ liệu SQLite nội bộ.

---

## 10. Đăng xuất Admin UI

> Nguồn: rà soát trực tiếp `server.js` (route `POST /admin/logout`, hàm
> `buildKeycloakLogoutUrl`) + `public/admin.html` (hàm `doLogout`). **Chưa đồng bộ sang
> `docs/admin-ui.md`**.

```mermaid
sequenceDiagram
    actor Admin
    participant UI as admin.html
    participant GW as server.js
    participant KC as Keycloak

    Admin->>UI: Click "Đăng xuất" (doLogout)
    UI->>GW: POST /admin/logout
    GW->>GW: adminSessions.delete(cookies.admin_session)
    GW->>GW: buildKeycloakLogoutUrl('/admin')<br/>→ .../protocol/openid-connect/logout?client_id=rocky-admin&post_logout_redirect_uri=.../admin
    GW-->>UI: Set-Cookie admin_session=; Max-Age=0<br/>200 { ok: true, logoutUrl }
    UI->>UI: location.href = data.logoutUrl
    UI->>KC: GET /realms/:realm/protocol/openid-connect/logout?...
    KC->>KC: Kết thúc session SSO (KEYCLOAK_SESSION) của user trên browser
    KC-->>UI: 302 → post_logout_redirect_uri (.../admin)
    UI->>GW: GET /admin/session
    GW-->>UI: { authenticated: false } (cookie admin_session đã bị xoá ở bước trên)
    UI->>UI: render lại login-page
```

Điểm chú ý: xoá `admin_session` (cookie + entry trong `adminSessions` Map) xảy ra
**trước**, ngay trong response của `/admin/logout` — round-trip Keycloak end-session chỉ
là bước dọn tiếp theo phía browser, không phải điều kiện để session admin nội bộ bị coi
là đăng xuất; `doLogout()` không có `try/catch`, khác với logout Address Book (diagram
#3) có chủ đích fire-and-forget; dùng đúng `post_logout_redirect_uri=/admin` đã khai báo
sẵn trong "Valid post logout redirect URIs" của client `rocky-admin`, không cần
`prompt=login` như `/admin/login`.

## Change Log

- **2026-06-22 (fix 3 lỗ hổng auth gateway)** — Đồng bộ lại diagram #1 (Login), #2
  (Check-access), #3 (Logout) từ `docs/address-book.md` sau khi fix: `decodeJwtPayload`
  (không verify) → `introspectTokenCached` (verify thật qua Keycloak, cache 30s) ở #1/#2;
  `/api/auth/logout` trả `revoked` đúng thực tế + xoá cache token ở #3. Chi tiết đầy đủ +
  lý do ở Change Log của `docs/address-book.md`.
- **2026-06-21 (bổ sung quản trị máy trạm + logout)** — Thêm diagram #9 (quản trị máy
  trạm: tạo/sửa+gán group/xoá máy) và #10 (đăng xuất Admin UI), rà soát trực tiếp từ
  `server.js`/`public/admin.html` — **chưa đồng bộ ngược lại `docs/admin-ui.md`** (lưu ý
  khác quy ước thường: thường sửa file gốc module trước rồi mới copy vào đây, lần này
  theo yêu cầu cụ thể chỉ thêm vào file tổng hợp). Không có thay đổi code.
- **2026-06-21 (bổ sung 2FA)** — Thêm diagram #8 (chi tiết nhánh Conditional OTP trong
  luồng login Admin UI), đồng bộ từ `docs/keycloak.md` (file mới tổng hợp riêng phần
  Keycloak: xác thực, 2FA, phân quyền, cấu hình). Không có thay đổi code.
- **2026-06-21** — Tạo file, gom 6 sequence diagram đã có sẵn ở `docs/address-book.md`
  (Login, Check-access, Logout) và `docs/admin-ui.md` (Đăng nhập Admin UI, Tạo user+gán
  Group+admin-role, Tạo Group+map máy) vào một file duy nhất để xem toàn cảnh. Thêm 1
  diagram đề xuất mới (#7, lấy hồ sơ user qua `/userinfo`) dựa trên phân tích sẵn có ở
  `docs/user-profile-auth-notes.md` — đánh dấu rõ là chưa implement, chỉ là thiết kế đề
  xuất. Không có thay đổi code.
