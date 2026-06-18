# ROCKY — Hệ thống Remote Desktop với Xác thực và Phân quyền Tập trung

## 1. Giới thiệu tổng quan

**ROCKY** là một hệ thống điều khiển máy tính từ xa (remote desktop) được xây dựng trên nền tảng **RustDesk** — phần mềm mã nguồn mở viết bằng ngôn ngữ Rust. Dự án được phát triển nhằm mục tiêu đáp ứng nhu cầu quản trị hạ tầng IT trong môi trường doanh nghiệp, nơi đòi hỏi kiểm soát chặt chẽ về **ai được phép truy cập vào máy tính nào**, thay vì để người dùng tự do kết nối như phần mềm gốc.

Điểm khác biệt cốt lõi so với RustDesk gốc là ROCKY tích hợp thêm **hệ thống xác thực tập trung qua Keycloak (SSO)** và **cơ chế phân quyền theo role**, cho phép bộ phận IT kiểm soát quyền truy cập máy tính từ một giao diện quản trị duy nhất mà không cần cấu hình trực tiếp trên từng thiết bị.

---

## 2. Bối cảnh và vấn đề giải quyết

Trong môi trường doanh nghiệp, việc sử dụng các phần mềm remote desktop thông thường (TeamViewer, AnyDesk, RustDesk gốc...) tồn tại một số hạn chế:

- **Không có kiểm soát tập trung**: Bất kỳ ai biết ID và mật khẩu của máy đều có thể kết nối, không phân biệt vai trò hay bộ phận.
- **Khó quản lý quyền truy cập**: Không có giao diện tập trung để admin xem ai đang được phép truy cập vào máy nào.
- **Không tích hợp hệ thống tài khoản công ty**: Người dùng phải nhớ thêm mật khẩu riêng cho phần mềm remote.

**ROCKY giải quyết những vấn đề này bằng cách:**

- Tích hợp đăng nhập một lần (SSO) qua **Keycloak**, cho phép người dùng dùng tài khoản nội bộ (hoặc Google) để xác thực.
- Phân quyền truy cập máy dựa trên **role trong Keycloak** — mỗi role tương ứng với một nhóm máy tính nhất định.
- Cung cấp **Web Admin UI** để quản trị viên IT quản lý toàn bộ hệ thống từ trình duyệt.

---

## 3. Kiến trúc hệ thống

```
┌──────────────────────────────────────────────────────┐
│           ROCKY Desktop Client (Sciter UI)           │
│   - Màn hình chính: kết nối peer, address book       │
│   - Đăng nhập Keycloak qua browser (OIDC flow)       │
│   - Chỉ hiển thị máy được phép theo role             │
└──────────────────────┬───────────────────────────────┘
                       │ HTTP / localhost:3000
┌──────────────────────▼───────────────────────────────┐
│            server.js — Node.js Gateway               │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Admin UI   │  │  Auth Proxy  │  │  AB / AC    │ │
│  │  /admin     │  │  /api/auth/* │  │  /api/ab*   │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘ │
└─────────┼────────────────┼─────────────────┼─────────┘
          │                │                 │
   ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
   │  data.json  │  │  Keycloak   │  │  data.json  │
   │  machines   │  │  :8080      │  │  roles map  │
   │  roles      │  │  realm:     │  └─────────────┘
   └─────────────┘  │  rustdesk   │
                    └─────────────┘
```

### Các thành phần chính

| Thành phần | Công nghệ | Vai trò |
|---|---|---|
| **ROCKY Client** | Rust + Sciter UI | Ứng dụng desktop, giao tiếp với gateway |
| **server.js** | Node.js (không có npm deps) | Gateway trung gian: xác thực, phân quyền, admin API |
| **public/admin.html** | HTML/CSS/JS thuần | Giao diện quản trị web (SPA) |
| **Keycloak** | Java (Docker) | Identity Provider: quản lý users, roles, SSO |
| **data.json** | JSON file | Lưu trữ danh sách máy và ánh xạ role → máy |

---

## 4. Use Case

### UC-01: Người dùng đăng nhập và xem danh sách máy được phép

**Actor**: Nhân viên công ty  
**Điều kiện tiên quyết**: Đã có tài khoản Keycloak và được admin gán role

**Luồng chính**:
1. Người dùng mở ứng dụng ROCKY, vào tab **Address Book**
2. Hệ thống hiển thị nút **Đăng nhập**
3. Người dùng nhấn **Đăng nhập** → trình duyệt tự mở trang Keycloak
4. Người dùng nhập tài khoản (hoặc chọn **Login with Google**)
5. Keycloak xác thực thành công → trả về `access_token` (JWT)
6. ROCKY nhận token, gọi API `/api/address-books`
7. Server giải mã JWT, lấy danh sách role, tra cứu máy tương ứng
8. Address Book hiển thị đúng danh sách máy người dùng được phép thấy

**Kết quả**: Người dùng chỉ thấy và kết nối được các máy thuộc role của mình.

---

### UC-02: Người dùng kết nối đến máy tính từ xa

**Actor**: Nhân viên có quyền truy cập  
**Điều kiện tiên quyết**: Đã đăng nhập (UC-01)

**Luồng chính**:
1. Người dùng double-click vào máy trong Address Book
2. ROCKY mở phiên remote desktop đến máy đích
3. Màn hình của máy đích hiển thị trong cửa sổ ROCKY
4. Người dùng điều khiển bàn phím, chuột từ xa
5. Khi kết thúc, đóng cửa sổ → phiên kết thúc

---

### UC-03: Admin quản lý danh sách máy

**Actor**: Quản trị viên IT  
**Điều kiện tiên quyết**: Đăng nhập Web Admin UI (`admin / admin123`)

**Luồng chính**:
1. Admin truy cập `http://127.0.0.1:3000/admin`
2. Vào tab **Danh sách máy**
3. Nhấn **Thêm máy** → nhập: Tên hiển thị, RustDesk ID, Tag, Ghi chú
4. Chọn các role được phép truy cập máy này
5. Nhấn **Lưu** → máy xuất hiện trong hệ thống

**Luồng phụ — Sửa máy**:
- Nhấn **Sửa** → modal chỉnh sửa thông tin + thay đổi roles → **Lưu**

**Luồng phụ — Xóa máy**:
- Nhấn **Xóa** → máy bị xóa khỏi `data.json` và tất cả role mappings

---

### UC-04: Admin phân quyền role cho máy

**Actor**: Quản trị viên IT

**Luồng chính**:
1. Vào tab **Danh sách role**
2. Hệ thống hiển thị các role cards (admin, viewer, guest...)
3. Trong role card muốn cấu hình, nhấn **+ Thêm máy**
4. Modal hiện danh sách máy chưa thuộc role → chọn máy → **Xác nhận**
5. Máy được thêm vào role, lưu vào `data.json`

**Kết quả**: Từ đây, user có role đó sẽ thấy máy vừa thêm trong Address Book.

---

### UC-05: Admin quản lý người dùng Keycloak

**Actor**: Quản trị viên IT

**Luồng chính**:
1. Vào tab **Người dùng**
2. Hệ thống hiển thị danh sách user từ Keycloak: tên, email, role, trạng thái
3. **Tạo user**: Nhập tên, email, mật khẩu → tạo trực tiếp trong Keycloak
4. **Gán role**: Nhấn **Gán role** → modal chọn role → xác nhận → Keycloak cập nhật
5. **Enable/Disable**: Toggle trạng thái user → Keycloak cập nhật ngay

---

### UC-06: Admin tạo role mới

**Actor**: Quản trị viên IT

**Luồng chính**:
1. Vào tab **Danh sách role** → nhấn **+ Tạo role**
2. Nhập tên role (VD: `engineering`, `devops`) → **Tạo**
3. Role được tạo trong Keycloak client `rustdesk-client`
4. Admin có thể ngay lập tức gán máy và user cho role mới

---

### UC-07: Người dùng đăng xuất

**Actor**: Người dùng đã đăng nhập

**Luồng chính**:
1. Nhấn **Đăng xuất** trong Address Book
2. ROCKY xóa `access_token` khỏi local config ngay lập tức
3. UI trở về màn hình **Đăng nhập** (phản hồi tức thì)
4. Đồng thời gọi API `/api/auth/logout` để server revoke token trên Keycloak
5. Token bị vô hiệu hóa hoàn toàn — không thể tái sử dụng

---

## 5. Luồng nghiệp vụ tổng thể

### 5.1. Luồng thiết lập ban đầu (Admin)

```
[Admin] Cài đặt Keycloak
    │
    ▼
Tạo realm "rustdesk", client "rustdesk-client"
Tạo các role: admin, viewer, guest, ...
    │
    ▼
Chạy server.js (Node.js gateway)
    │
    ▼
Vào Web Admin UI → Tab Máy
Thêm các máy tính vào hệ thống (alias, RustDesk ID, tag)
    │
    ▼
Tab Roles → Gán máy vào từng role
    │
    ▼
Tab Người dùng → Tạo user, gán role
    │
    ▼
Hệ thống sẵn sàng
```

### 5.2. Luồng sử dụng hàng ngày (Người dùng)

```
[Người dùng] Mở ROCKY
    │
    ▼
Tab Address Book → Nhấn [Đăng nhập]
    │
    ▼
Browser mở → Đăng nhập Keycloak (tài khoản công ty / Google)
    │
    ▼
Keycloak xác thực → Cấp JWT (chứa role: viewer, admin...)
    │
    ▼
ROCKY nhận token → Gọi /api/address-books
    │
    ▼
Server lọc máy theo role trong JWT
    │
    ▼
Hiển thị danh sách máy được phép
    │
    ▼
Double-click → Kết nối remote desktop
```

### 5.3. Luồng phân quyền địa chỉ máy (end-to-end)

```
[KC Admin]                    [Web Admin UI]              [ROCKY Client]
Gán user "nam"         →      Tab Roles:              →   User "nam" login
vào role "kế toán"            "kế toán" → [máy-KT-01,     → JWT chứa role
                               máy-KT-02]                   "kế toán"
                               Lưu data.json           →   /api/address-books
                                                            → trả [máy-KT-01,
                                                               máy-KT-02]
                                                            Address Book hiện
                                                            đúng 2 máy kế toán
```

---

## 6. Bảo mật

| Cơ chế | Mô tả |
|---|---|
| **JWT validation** | Server giải mã JWT để lấy role, không cần gọi ngược Keycloak mỗi lần |
| **Token revoke** | Khi logout, token bị revoke tại Keycloak — không thể tái sử dụng |
| **Prompt login** | Mỗi lần đăng nhập, Keycloak luôn yêu cầu nhập lại mật khẩu (`prompt=login`), tránh SSO ngầm |
| **Failopen policy** | Nếu gateway offline, client vẫn hoạt động bình thường (không block oan) |
| **Admin cookie** | Web Admin UI dùng session cookie riêng biệt, không liên quan đến JWT người dùng |

---

## 7. Công nghệ sử dụng

| Lớp | Công nghệ |
|---|---|
| Desktop client | Rust 1.x, Sciter UI (HTML/TIS/CSS) |
| Gateway / API | Node.js (built-ins only: `http`, `fs`, `crypto`) |
| Giao diện admin | HTML5 / CSS3 / Vanilla JS (không có framework) |
| Identity Provider | Keycloak (OpenID Connect / OAuth 2.0) |
| Giao thức kết nối | RustDesk Protocol (protobuf over TCP/UDP), hole-punching, relay |
| Lưu trữ | JSON file (`data.json`) |
