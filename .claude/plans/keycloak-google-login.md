# Cấu hình Keycloak: Google Social Login

## Mục đích

Thêm nút "Đăng nhập với Google" vào trang login Keycloak của realm `rustdesk`, để user ROCKY có thể chọn login qua tài khoản Google thay vì username/password.

---

## Bước 1 — Google Cloud Console

1. Vào https://console.cloud.google.com
2. Chọn project (hoặc tạo mới)
3. APIs & Services → **Credentials** → **+ Create Credentials** → **OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Name: `ROCKY Keycloak` (tùy ý)
6. **Authorized redirect URIs** — thêm:
   ```
   http://localhost:8080/realms/rustdesk/broker/google/endpoint
   ```
   _(Nếu dùng domain thật, thay `localhost:8080` bằng domain KC của bạn)_
7. Nhấn **Create** → sao chép **Client ID** và **Client Secret**

---

## Bước 2 — Keycloak Admin: Thêm Google Identity Provider

1. Vào `http://localhost:8080` → Đăng nhập admin
2. Chọn realm **rustdesk** (góc trên trái)
3. Menu trái → **Identity Providers** → **Add provider** → **Google**
4. Điền:
   | Field | Giá trị |
   |---|---|
   | Client ID | _(lấy từ Bước 1)_ |
   | Client Secret | _(lấy từ Bước 1)_ |
   | Default Scopes | `openid email profile` |
   | Sync Mode | `IMPORT` (tạo user KC lần đầu login) |
5. Nhấn **Save**

Sau bước này, trang login KC tại `/realms/rustdesk/protocol/openid-connect/auth?...` sẽ tự hiển thị nút "Login with Google".

---

## Bước 3 — Mapper: Lấy thông tin profile từ Google

Để KC tự fill `email`, `firstName`, `lastName` từ Google profile:

1. Identity Providers → **Google** → tab **Mappers** → **Add mapper**
2. Tạo 3 mapper:

   **Mapper 1 — Email**
   | Field | Giá trị |
   |---|---|
   | Name | `email` |
   | Sync Mode Override | `Inherit` |
   | Type | `Attribute Importer` |
   | Social Profile JSON Field Path | `email` |
   | User Attribute | `email` |

   **Mapper 2 — First Name**
   | Field | Giá trị |
   |---|---|
   | Name | `firstName` |
   | Type | `Attribute Importer` |
   | Social Profile JSON Field Path | `given_name` |
   | User Attribute | `firstName` |

   **Mapper 3 — Last Name**
   | Field | Giá trị |
   |---|---|
   | Name | `lastName` |
   | Type | `Attribute Importer` |
   | Social Profile JSON Field Path | `family_name` |
   | User Attribute | `lastName` |

> Nếu không thêm mapper, KC vẫn tạo user nhưng firstName/lastName có thể trống.

---

## Bước 4 — Sau khi user Google login lần đầu

Khi user click "Login with Google" và đăng nhập thành công:
- KC tự tạo user mới trong realm `rustdesk`
- `username` dạng: email của user (VD: `user@gmail.com`)
- User **chưa có role** → không truy cập được máy nào

**Admin cần làm thủ công:**
1. Vào Admin UI `http://127.0.0.1:3000/admin` → Tab **Người dùng**
2. Tìm user mới (có badge **Google** màu đỏ)
3. Nhấn **Gán role** → chọn role phù hợp (`viewer`, `admin`, v.v.)

---

## Không cần sửa code

Luồng OAuth2 trong `server.js` (`/api/auth/init` → `/api/auth/callback`) **không cần thay đổi** — KC xử lý toàn bộ phần Google IdP và trả về `access_token` như bình thường.

---

## Kiểm tra

1. Chạy Keycloak: `docker start <keycloak_container>`
2. Chạy gateway: `node server.js`
3. Mở ROCKY client → nhấn Login → trình duyệt mở trang KC login
4. Xác nhận trang có nút "Login with Google"
5. Click → Google OAuth consent screen → cho phép → redirect về → "Login thành công, đóng tab này"
6. ROCKY nhận `access_token` → Address Book load

---

## Lưu ý bảo mật

- Client Secret của Google OAuth **không được** commit vào source code — dùng biến môi trường nếu cần
- Redirect URI phải khớp chính xác (không có trailing slash thừa)
- Nếu KC chạy trên HTTPS, redirect URI cũng phải dùng HTTPS
