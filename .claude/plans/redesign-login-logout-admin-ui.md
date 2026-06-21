# Redesign luồng login/logout Admin UI — chặn root cause SSO + thống nhất mọi trang lỗi

## Context

Bản fix trước (`.claude/plans/fix-bug-khi-t-i-steady-scone.md`, đã code xong) chỉ thêm
1 link "thử lại" ở riêng trang lỗi 403 — là **bandaid**, không chặn root cause. Sau khi
phân tích kỹ hơn (kèm sequence diagram), root cause thực sự là: cookie SSO của Keycloak
(`KEYCLOAK_SESSION`) là **theo browser + theo realm**, không theo client/app. Bất kỳ lần
đăng nhập thành công nào trong realm `rustdesk` — qua `rustdesk-client` (desktop ROCKY,
`ab.tis: loginWithKeycloak`), qua Keycloak Account/Admin Console trực tiếp, hay qua
chính `/admin/login` ở 1 lần test trước — đều tạo session dùng chung. Lần sau bấm
"Đăng nhập với Keycloak" ở admin UI, nếu session đó chưa hết hạn, Keycloak **không hiện
form** mà âm thầm cấp lại đúng danh tính cũ cho `rocky-admin` → role-check fail → 403.
Vì vậy bug **không cần** người dùng từng "login admin UI ở rocky client" — chỉ cần tài
khoản đó từng login *bất kỳ đâu* trong realm.

User đã xác nhận chọn hướng: **chặn triệt để ở phía admin bằng `prompt=login`**, đánh
đổi 1 bất đối xứng đã được giải thích và chấp nhận (admin login xong có thể khiến
`rustdesk-client` tự đăng nhập cùng tài khoản nếu dùng chung browser — không phải lỗ
hổng quyền, vì luôn là đúng tài khoản vừa nhập tay).

> **Đính chính sau khi code xong:** khi lưu changelog đã kiểm tra lại `git log -S` và
> phát hiện route `/api/auth/init` (luồng login của `rustdesk-client`, `server.js` dòng
> 759-774) **đã có sẵn `prompt: 'login'` từ commit `1462e5738`, có trước task này** —
> không phải do thay đổi hôm nay. Nghĩa là `rustdesk-client` tự nó cũng luôn ép nhập lại
> credential ở chính nút login riêng của nó. Vậy bất đối xứng nói trên **không xảy ra
> trên thực tế qua các nút login của UI** — cookie SSO chung vẫn được tạo sau mỗi lần
> đăng nhập, nhưng cả `/admin/login` và `/api/auth/init` đều tự chặn việc âm thầm tái
> dùng nó ở chính điểm khởi tạo của mình. Đánh đổi vẫn được giữ làm quyết định đã chốt
> (không sai khi áp dụng), chỉ là rủi ro thực tế thấp hơn đã nghĩ lúc lập plan.

## Approach

### 1. Chặn root cause: `/admin/login` luôn ép nhập lại credential

`server.js`, route `/admin/login` (hiện ~dòng 362-375) — thêm `prompt: 'login'` vào
`params` khi dựng URL `/auth`:
```js
const params = new URLSearchParams({
  client_id: ADMIN_CLIENT_ID,
  redirect_uri: ADMIN_REDIRECT_URI,
  response_type: 'code',
  scope: 'openid',
  state,
  prompt: 'login',
});
```
Không ảnh hưởng tiện lợi "khỏi đăng nhập lại trong ngày" — lớp tiện lợi đó nằm ở
`admin_session` cookie (8h, kiểm tra qua `GET /admin/session` lúc `admin.html` load,
`checkSession()`) và không liên quan gì tới `prompt=login`; người dùng có session admin
hợp lệ không bao giờ thấy lại nút "Đăng nhập với Keycloak".

### 2. Thống nhất mọi nhánh lỗi của `/admin/auth/callback` qua 1 helper

Hiện có 4 nhánh lỗi khác nhau, chỉ nhánh 403 (role-check fail) có link thoát (từ bản fix
trước); 3 nhánh còn lại (state invalid/expired, token exchange fail, exception) vẫn là
dead-end. Thêm helper, đặt cạnh `buildKeycloakLogoutUrl` (giữ nguyên, vẫn dùng cho
`/admin/logout`):
```js
function renderAdminAuthError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><body><h2>${message}</h2>
    <p><a href="/admin/login">Quay lại đăng nhập</a></p>
    </body></html>`);
}
```
Vì `/admin/login` giờ luôn ép nhập lại credential, link quay lại đơn giản là đủ —
**không cần** round-trip Keycloak end-session (`buildKeycloakLogoutUrl`) cho nhánh 403
nữa, đơn giản hoá so với bản fix trước.

Áp dụng helper cho cả 4 nhánh:
- State invalid/expired (400): `renderAdminAuthError(res, 400, 'Đăng nhập thất bại: state không hợp lệ hoặc đã hết hạn.')`
- Token exchange fail (400): `renderAdminAuthError(res, 400, 'Đăng nhập thất bại.')`
- Role-check fail (403): `renderAdminAuthError(res, 403, 'Tài khoản không có quyền quản trị.')`
- Exception (catch, 500): đổi `res.end('...' + err.message)` thành
  `console.error('[admin/auth/callback] lỗi đăng nhập:', err)` (log server-side, không
  lộ `err.message` ra UI — info-disclosure cleanup) rồi
  `renderAdminAuthError(res, 500, 'Đăng nhập thất bại do lỗi hệ thống.')`.

Giữ nguyên các `console.log('[admin/auth/callback DEBUG]'...)` đang có (instrumentation
có sẵn, không thuộc phạm vi fix này).

### 3. `/admin/logout` — không đổi

Vẫn dùng `buildKeycloakLogoutUrl('/admin')` như bản fix trước (nút "Đăng xuất" trong
app shell) — đây vẫn là full Keycloak end-session hợp lý, không liên quan tới
`prompt=login`.

### Không làm

- Không đụng `public/admin.html`, không đổi response shape của `/admin/session` hay
  `/admin/logout`.
- Không đụng flow `/api/auth/*` của `rustdesk-client` / `src/ui/ab.tis` — chấp nhận bất
  đối xứng SSO 1 chiều đã thống nhất, không cô lập 2 chiều (sẽ cần đổi cấu trúc Keycloak
  realm, ngoài phạm vi này).
- Không đổi logic role-check hay `/admin/api/*`.

### Phụ thuộc cấu hình Keycloak — **giảm so với bản fix trước**

Vì nhánh 403 không còn gọi Keycloak end-session nữa, **không cần** thêm
`http://localhost:3000/admin/login` vào "Valid post logout redirect URIs" (khác với
plan trước). Chỉ còn cần đảm bảo `http://localhost:3000/admin` đã có trong danh sách đó
(cho nút "Đăng xuất" ở `/admin/logout`, vốn đã yêu cầu từ bản fix trước) — nếu đã thêm
rồi thì không cần làm gì thêm.

## Documentation (theo CLAUDE.md)

Sau khi code xong:
- Thêm changelog mới vào `docs/admin-ui.md`, ghi rõ: đổi từ "recovery link + Keycloak
  logout" sang "chặn root cause bằng `prompt=login`" — vì sao (cookie SSO theo realm,
  không theo client), đánh đổi đã chấp nhận (bất đối xứng 1 chiều), và đơn giản hoá phụ
  thuộc Keycloak (bỏ yêu cầu `/admin/login` trong allowlist).
- Thêm dòng changelog vào `.claude/plans/fix-bug-khi-t-i-steady-scone.md` ghi rõ bản fix
  đó đã bị **thay thế** bởi plan này (không xoá nội dung cũ, chỉ note suy luận đã đổi).

## Tiến độ / Changelog

### 2026-06-20 — Đã triển khai xong code

`node --check server.js` pass. Đã áp dụng đúng 3 thay đổi ở mục Approach: thêm
`prompt: 'login'` vào `/admin/login`, thêm helper `renderAdminAuthError`, áp dụng cho
cả 4 nhánh lỗi của `/admin/auth/callback` (đã bỏ `buildKeycloakLogoutUrl` khỏi nhánh
403, hàm này giờ chỉ còn dùng ở `/admin/logout`). Đã ghi changelog vào
`docs/admin-ui.md` và note liên kết trong `fix-bug-khi-t-i-steady-scone.md`.

**Diff đầy đủ (`git diff server.js`), 4 vị trí thay đổi:**
1. Thêm `renderAdminAuthError(res, status, message)` (dòng 297-302), đặt ngay sau
   `buildKeycloakLogoutUrl` (dòng 289-295, không đổi).
2. `/admin/login` (route GET, ~dòng 369): thêm `prompt: 'login',` vào object `params`
   truyền cho `URLSearchParams`.
3. `/admin/auth/callback` (route GET, ~dòng 385-440) — 4 nhánh lỗi đổi sang gọi helper:
   - dòng ~397: state invalid/expired → `renderAdminAuthError(res, 400, 'Đăng nhập thất bại: state không hợp lệ hoặc đã hết hạn.')`
   - dòng ~413: token exchange fail → `renderAdminAuthError(res, 400, 'Đăng nhập thất bại.')`
   - dòng ~420: role-check fail → `renderAdminAuthError(res, 403, 'Tài khoản không có quyền quản trị.')` (bỏ hẳn `buildKeycloakLogoutUrl('/admin/login')` + link Keycloak logout của bản fix trước)
   - dòng ~437-438 (catch block): bỏ `res.end('...' + err.message)` (info-disclosure), thay bằng `console.error('[admin/auth/callback] lỗi đăng nhập:', err)` rồi `renderAdminAuthError(res, 500, 'Đăng nhập thất bại do lỗi hệ thống.')`.
4. `/admin/logout` (route POST, ~dòng 460+): **không đổi** — vẫn `buildKeycloakLogoutUrl('/admin')`.

**Phát hiện thêm khi rà lại diff để lưu changelog:** route `/api/auth/init` (luồng login
của `rustdesk-client`, dòng 759-774) **đã có `prompt: 'login'` từ trước** (commit
`1462e5738`, xác nhận bằng `git log --all -p -S "prompt: 'login'" -- server.js`) —
không phải thay đổi của task này. Đã đính chính lại mục Context ở trên: bất đối xứng SSO
giữa 2 nút login không thực sự xảy ra qua UI, vì cả 2 route đều tự ép `prompt=login`
độc lập với nhau.

Chưa test
end-to-end trong browser (cần user tự thực hiện theo mục Verification dưới — đặc biệt
bước 1, vốn cần có sẵn 1 session SSO "sai tài khoản" để tái hiện đúng kịch bản bug cũ).

## Verification

1. Trong browser đang có session SSO của user không có role `admin` trên `rocky-admin`
   (vd. tạo session đó bằng cách login `testadmin` qua app desktop ROCKY hoặc Keycloak
   Account Console — không cần qua admin UI): mở `/admin`, bấm "Đăng nhập với Keycloak"
   → xác nhận lần này Keycloak **hiện form nhập username/password** (khác hành vi cũ).
2. Đăng nhập lại đúng bằng `testadmin` ở form đó → xác nhận vẫn vào trang lỗi 403, có
   link "Quay lại đăng nhập" → bấm lại → Keycloak hiện form lần nữa (không lặp vô hạn
   một cách âm thầm — luôn cho cơ hội nhập tài khoản khác).
3. Đăng nhập bằng `admintest` (có role `admin` trên `rocky-admin`) → vào được app shell,
   `GET /admin/session` trả `authenticated:true, username:"admintest"`.
4. Test các nhánh lỗi còn lại có link "Quay lại đăng nhập" hoạt động: mở
   `/admin/auth/callback` với `state` sai/thiếu → xác nhận 400 có link, không còn dead-end.
5. Test nút "Đăng xuất" (`POST /admin/logout`) trong app shell → vẫn hoạt động đúng như
   cũ, không regress.
6. Mở lại `/admin` sau khi đã có `admin_session` hợp lệ (chưa hết hạn 8h) → xác nhận
   vào thẳng app shell, **không** thấy lại nút "Đăng nhập với Keycloak" / không bị hỏi
   lại credential — xác nhận tiện lợi cũ được giữ nguyên.
