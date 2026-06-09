# Plan: Hoàn thiện Admin UI — Thêm/Sửa/Xóa máy, Phân role, Quản trị user, Data persistence

## Context

Admin UI hiện tại (`server.js` + `public/admin.html`) đã có skeleton 4 tab nhưng còn nhiều lỗ hổng:
- Không có chức năng **edit** peer (chỉ có add/delete)
- Không tạo/xóa được user Keycloak
- Không tạo/xóa được role Keycloak (chỉ gán)
- `data.json` có `"roles": {}` (rỗng) → `/api/address-books` luôn trả về danh sách rỗng
- Model peer không nhất quán: server lưu `{ id, name, status }`, UI gửi `{ id, name, host, platform }`
- `GET /admin/api/keycloak-roles` trả `string[]` nhưng `saveUserRoles` cần `[{id, name}]` → lỗi silent khi gán role

Mục tiêu: hoàn thiện đầy đủ, tất cả chức năng hoạt động end-to-end.

---

## Files sẽ sửa

- `server.js` — thêm endpoints, fix migration, fix httpRequest headers
- `public/admin.html` — thêm form tạo user, delete user, create/delete role, edit peer modal
- `data.json` — tự migrate khi server restart (không sửa tay)

---

## Bước 1: Fix `httpRequest` trả về headers

**File:** `server.js:81`

```js
// Trước:
res.on('end', () => resolve({ status: res.statusCode, body: data }));
// Sau:
res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
```

Cần để lấy `Location` header khi tạo user Keycloak (`POST /users` → `201`, header `Location: .../users/{newId}`).

---

## Bước 2: Fix `loadData()` — migration + default roles

**File:** `server.js` — hàm `loadData()` (hiện chưa có, data được load inline khi start)

Thêm hàm `loadData()` thay thế đoạn load inline:

```js
function loadData() {
  let data;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    data = JSON.parse(raw);
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
  // Đảm bảo roles không rỗng
  if (!data.roles || Object.keys(data.roles).length === 0) {
    data.roles = JSON.parse(JSON.stringify(DEFAULT_DATA.roles));
  }
  if (!data.books) data.books = JSON.parse(JSON.stringify(DEFAULT_DATA.books));
  // Migrate peer model: name → alias, host → hostname, bỏ status
  for (const book of Object.values(data.books)) {
    if (!book.peers) book.peers = [];
    if (!book.tags)  book.tags  = [];
    book.peers = book.peers.map(p => ({
      id:       p.id       || '',
      alias:    p.alias    || p.name || '',
      username: p.username || '',
      hostname: p.hostname || p.host || '',
      platform: p.platform || '',
      tags:     Array.isArray(p.tags) ? p.tags : [],
    }));
  }
  saveData(data);
  return data;
}
```

**Update `DEFAULT_DATA`** — peer model mới (alias thay name, bỏ status):
```js
const DEFAULT_DATA = {
  books: {
    Engineering: { peers: [{ id: 'eng-01', alias: 'Build Server', username: '', hostname: '', platform: '', tags: [] }], tags: [] },
    Marketing:   { peers: [{ id: 'mkt-01', alias: 'Marketing PC', username: '', hostname: '', platform: '', tags: [] }], tags: [] },
    DevOps:      { peers: [], tags: [] },
  },
  roles: {
    admin:  ['Engineering', 'Marketing', 'DevOps'],
    viewer: ['Engineering'],
  },
};
```

---

## Bước 3: Fix `GET /admin/api/keycloak-roles` → trả `[{id, name}]`

**File:** `server.js:262` (1 dòng)

```js
// Trước:
const roles = JSON.parse(r.body).map(r => r.name).filter(...);
// Sau:
const roles = JSON.parse(r.body)
  .filter(r => !r.name.startsWith('default-roles') && r.name !== 'offline_access' && r.name !== 'uma_authorization')
  .map(r => ({ id: r.id, name: r.name }));
```

---

## Bước 4: Fix `POST /admin/api/books/:name/peers` — sanitize peer fields

**File:** `server.js:347`

```js
// Trước: appData.books[name].peers.push(body);  ← push raw body
// Sau:
const peer = {
  id:       (body.id       || '').trim(),
  alias:    (body.alias    || '').trim(),
  username: (body.username || '').trim(),
  hostname: (body.hostname || '').trim(),
  platform: (body.platform || '').trim(),
  tags:     Array.isArray(body.tags) ? body.tags : [],
};
if (!peer.id) { jsonResponse(res, 400, { error: 'Missing peer id' }); return; }
appData.books[name].peers.push(peer);
```

---

## Bước 5: Thêm `PUT /admin/api/books/:name/peers/:id` (Edit peer)

**File:** `server.js` — ngay sau block `peerMatch && DELETE` (line 354–363)

```js
// Edit peer
if (peerMatch && req.method === 'PUT') {
  const name = decodeURIComponent(peerMatch[1]);
  const id   = decodeURIComponent(peerMatch[2]);
  if (!appData.books[name]) { jsonResponse(res, 404, { error: 'Book not found' }); return; }
  const idx = appData.books[name].peers.findIndex(p => p.id === id);
  if (idx === -1) { jsonResponse(res, 404, { error: 'Peer not found' }); return; }
  const existing = appData.books[name].peers[idx];
  appData.books[name].peers[idx] = {
    id,
    alias:    body.alias    !== undefined ? body.alias    : existing.alias,
    username: body.username !== undefined ? body.username : existing.username,
    hostname: body.hostname !== undefined ? body.hostname : existing.hostname,
    platform: body.platform !== undefined ? body.platform : existing.platform,
    tags:     body.tags     !== undefined ? body.tags     : existing.tags,
  };
  saveData(appData);
  jsonResponse(res, 200, { ok: true });
  return;
}
```

Sửa block `peerMatch` để gom cả DELETE và PUT:
```js
const peerMatch = p.match(/^\/admin\/api\/books\/([^/]+)\/peers\/([^/]+)$/);
if (peerMatch) {
  if (req.method === 'DELETE') { /* existing code */ }
  else if (req.method === 'PUT') { /* new code above */ }
  else { jsonResponse(res, 405, { error: 'Method not allowed' }); }
  return;
}
```

---

## Bước 6: Thêm `POST + DELETE /admin/api/users` (Tạo/Xóa user Keycloak)

**File:** `server.js` — chèn TRƯỚC block `userRolesMatch` (line 271)

**POST /admin/api/users:**
```js
if (req.method === 'POST' && p === '/admin/api/users') {
  const { username, email, firstName, lastName, password } = body;
  if (!username || !password) { jsonResponse(res, 400, { error: 'username và password là bắt buộc' }); return; }
  try {
    const r = await keycloakAdminRequest('POST', '/users', {
      username, email: email || '', firstName: firstName || '', lastName: lastName || '',
      enabled: true,
      credentials: [{ type: 'password', value: password, temporary: false }],
    });
    if (r.status === 201) {
      // Lấy ID user mới từ Location header
      const newId = r.headers && r.headers.location ? r.headers.location.split('/').pop() : null;
      jsonResponse(res, 200, { ok: true, id: newId });
    } else {
      const err = JSON.parse(r.body);
      jsonResponse(res, r.status, { error: err.errorMessage || err.error || r.body });
    }
  } catch (err) { jsonResponse(res, 500, { error: err.message }); }
  return;
}
```

**DELETE /admin/api/users/:id** — chèn SAU `userEnabledMatch` (line 302), TRƯỚC `GET /admin/api/roles`:
```js
const userDeleteMatch = p.match(/^\/admin\/api\/users\/([^/]+)$/);
if (userDeleteMatch && req.method === 'DELETE') {
  const userId = userDeleteMatch[1];
  try {
    const r = await keycloakAdminRequest('DELETE', `/users/${userId}`, null);
    if (r.status === 204 || r.status === 200) {
      jsonResponse(res, 200, { ok: true });
    } else {
      jsonResponse(res, r.status, { error: r.body });
    }
  } catch (err) { jsonResponse(res, 500, { error: err.message }); }
  return;
}
```

---

## Bước 7: Thêm `POST + DELETE /admin/api/keycloak-roles` (Tạo/Xóa role Keycloak)

**File:** `server.js` — thêm vào block `GET /admin/api/keycloak-roles` để xử lý cả 3 method:

```js
if (p === '/admin/api/keycloak-roles') {
  if (req.method === 'GET') {
    /* existing filtered list code */
  } else if (req.method === 'POST') {
    const name = body.name && body.name.trim();
    if (!name) { jsonResponse(res, 400, { error: 'Thiếu name' }); return; }
    try {
      const r = await keycloakAdminRequest('POST', '/roles', { name });
      if (r.status === 201) { jsonResponse(res, 200, { ok: true }); }
      else { const e = JSON.parse(r.body); jsonResponse(res, r.status, { error: e.errorMessage || e.error || r.body }); }
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
    return;
  }
}

// Delete role by name (sau block trên)
const kcRoleDelMatch = p.match(/^\/admin\/api\/keycloak-roles\/([^/]+)$/);
if (kcRoleDelMatch && req.method === 'DELETE') {
  const roleName = decodeURIComponent(kcRoleDelMatch[1]);
  try {
    const getRes = await keycloakAdminGet(`/roles/${encodeURIComponent(roleName)}`);
    if (getRes.status === 404) { jsonResponse(res, 404, { error: 'Role not found' }); return; }
    const roleObj = JSON.parse(getRes.body);
    const delRes = await keycloakAdminRequest('DELETE', `/roles-by-id/${roleObj.id}`, null);
    if (delRes.status === 204 || delRes.status === 200) {
      delete appData.roles[roleName];   // xóa luôn khỏi role→book mapping
      saveData(appData);
      jsonResponse(res, 200, { ok: true });
    } else { jsonResponse(res, delRes.status, { error: delRes.body }); }
  } catch (err) { jsonResponse(res, 500, { error: err.message }); }
  return;
}
```

> **Lưu ý Keycloak:** Cần thêm quyền `manage-realm` cho service account `rustdesk-client` trong Keycloak console (Clients → rustdesk-client → Service Account Roles → realm-management → manage-realm). Nếu không có quyền này, tạo/xóa role sẽ trả về 403.

---

## Bước 8: `admin.html` — Fix `kcRoles` type handling

`kcRoles` giờ là `[{id, name}]` thay vì `string[]`. Cập nhật tất cả usages:

**`loadRoles()` — render checkbox grid:**
```js
const roles = kcRoles.filter(r => !['offline_access','uma_authorization'].includes(r.name));
// Trong render: dùng role.name cho display và data-role attribute
```

**`openRoleEditor()` — filter roles:**
```js
const roles = kcRoles.filter(r => !['offline_access','uma_authorization'].includes(r.name));
// checkbox value="${esc(r.name)}", label: ${esc(r.name)}
```

**`saveUserRoles()`** — hiện đã dùng `r.name` và `r.id` nên OK sau khi server trả object.

**`loadAll()` — pre-load kcRoles:**
```js
async function loadAll() {
  const kcRes = await fetch('/admin/api/keycloak-roles');
  kcRoles = await kcRes.json();
  await Promise.all([loadUsers(), loadRoles(), loadBooks()]);
}
```

---

## Bước 9: `admin.html` — Tab Users: Tạo user + Xóa user

**Thêm form tạo user** ngay đầu nội dung tab, bên trên bảng user:
```html
<div class="form-row" style="margin-bottom:16px;flex-wrap:wrap;gap:8px">
  <input id="nu-username"  placeholder="Username *"   style="width:130px">
  <input id="nu-email"     placeholder="Email"        style="width:180px">
  <input id="nu-firstname" placeholder="First name"   style="width:120px">
  <input id="nu-lastname"  placeholder="Last name"    style="width:120px">
  <input id="nu-password"  type="password" placeholder="Password *" style="width:120px">
  <button class="btn btn-primary btn-sm" onclick="createUser()">+ Tạo user</button>
</div>
```

**Thêm nút Xóa** vào mỗi row bảng user (cạnh nút "Gán role" và toggle).

**JS functions:**
```js
async function createUser() { /* POST /admin/api/users, reload loadUsers() */ }
async function deleteUser(id, username) { /* confirm + DELETE /admin/api/users/:id, reload */ }
```

---

## Bước 10: `admin.html` — Tab Roles: Tạo/Xóa Keycloak role

**Thêm section trên cùng tab "Role → Books":**
- Input + button "Tạo role" → `createKcRole()`
- Hiển thị chip list các role hiện tại, mỗi chip có nút × → `deleteKcRole(name)`

```js
async function createKcRole() { /* POST /admin/api/keycloak-roles, reload loadRoles() */ }
async function deleteKcRole(name) { /* confirm + DELETE /admin/api/keycloak-roles/:name, reload */ }
function renderRoleDeleteChips() { /* render chip list trong #roles-list-actions */ }
```

`loadRoles()` gọi `renderRoleDeleteChips()` sau khi load xong.

---

## Bước 11: `admin.html` — Tab Address Books: Edit peer modal

**Update `renderBookCard()`:**
- Cột bảng: `ID | Alias | Username | Hostname | Platform | Tags | Actions`
- Bỏ cột `Status`
- Mỗi row: nút `Sửa` (→ `openEditPeer()`) và `Xóa`

**Update form "Thêm peer":**
- Thay `peer-name-{book}` → `peer-alias-{book}`
- Thay `peer-host-{book}` → `peer-host-{book}` (giữ placeholder Hostname)
- Thêm `peer-username-{book}`
- Bỏ field `Status`

**Update `addPeer()`** để gửi `{ id, alias, username, hostname, platform, tags: [] }`.

**Thêm `openEditPeer(bookName, peerId)`** — render modal inline với các field:
- Alias, Username, Hostname, Platform, Tags (comma-separated)
- Nút Huỷ / Lưu → `saveEditPeer(bookName, peerId, btn)`

**Thêm `saveEditPeer()`** — `PUT /admin/api/books/:name/peers/:id`, đóng modal, reload `loadBooks()`.

**CSS thêm vào `<style>`:**
```css
.modal-overlay { position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:999 }
.modal-box     { background:white;border-radius:10px;padding:28px;min-width:360px;box-shadow:0 8px 32px rgba(0,0,0,.2);max-height:90vh;overflow-y:auto }
.modal-box h3  { color:#1565C0;margin-bottom:16px }
.modal-box label { display:block;font-size:.85rem;color:#444;margin:10px 0 4px }
.modal-box input { width:100%;padding:8px 12px;border:1px solid #ccc;border-radius:6px;font-size:.88rem;outline:none }
.modal-box input:focus { border-color:#1565C0 }
.modal-footer  { display:flex;gap:8px;justify-content:flex-end;margin-top:20px }
```

---

## Thứ tự thực hiện

1. `server.js`: Fix `httpRequest` → trả `headers`
2. `server.js`: Cập nhật `DEFAULT_DATA` + thêm hàm `loadData()` với migration
3. `server.js`: Fix `GET /admin/api/keycloak-roles` trả `[{id, name}]`
4. `server.js`: Fix `POST /admin/api/books/:name/peers` sanitize
5. `server.js`: Thêm `PUT` vào `peerMatch` block
6. `server.js`: Thêm `POST + DELETE /admin/api/users`
7. `server.js`: Thêm `POST + DELETE /admin/api/keycloak-roles`
8. `admin.html`: CSS modal classes
9. `admin.html`: Fix `kcRoles` type + `loadAll()` pre-load
10. `admin.html`: Tab Users — tạo/xóa user
11. `admin.html`: Tab Roles — tạo/xóa role + renderRoleDeleteChips
12. `admin.html`: Tab Books — update columns, addPeer form, openEditPeer/saveEditPeer
13. **Keycloak console** (manual): thêm `manage-realm` cho service account `rustdesk-client`
14. Restart `node server.js`, verify tất cả các flow

---

## Verify

```bash
node server.js
```
Mở `http://127.0.0.1:3000/admin`, login `admin / admin123`:

- [ ] Tab Users: bảng hiện đủ, tạo user mới → xuất hiện trong Keycloak, xóa user → mất khỏi bảng
- [ ] Tab Users: gán role cho user → user login vào ab.tis thấy đúng address book
- [ ] Tab Roles: tạo role mới → hiện trong Keycloak console và trong checkbox grid; xóa role → mất
- [ ] Tab Role → Books: tick checkbox, Save → `/api/address-books` trả đúng book theo role
- [ ] Tab Books: thêm book → hiện card; xóa book → mất
- [ ] Tab Books: thêm peer → hiện trong bảng với đủ cột; nhấn Sửa → modal hiện đúng data, lưu → cập nhật; xóa → mất
- [ ] `data.json`: sau restart, kiểm tra `roles` không còn rỗng, peers có đủ field mới
- [ ] `/api/address-books` với JWT hợp lệ → trả books đúng theo role
