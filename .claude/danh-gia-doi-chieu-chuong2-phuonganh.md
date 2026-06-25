# Đánh giá & đối chiếu `.claude/DATN20252_PhuongAnh (3).pdf` với hiện trạng project

> Ngày đánh giá: 2026-06-23. Tài liệu được đánh giá: `.claude/DATN20252_PhuongAnh (3).pdf`
> (20 trang) — chương "Khảo sát hiện trạng & Phân tích yêu cầu" (đánh số `0.x`, có vẻ là số
> chương tạm, sẽ được gán lại khi ghép vào báo cáo chính).
> Nguồn đối chiếu hiện trạng thật: `CLAUDE.md`, `docs/admin-ui.md`, `docs/address-book.md`,
> `docs/keycloak.md`, `.claude/baocaoc4.md`, `.claude/baocaoc5.md`.
> Trạng thái: **đã sửa xong (2026-06-24)** — xem bản chỉnh sửa tại `baocaoc2.md`.

## Điểm được — về mặt tài liệu

- Cấu trúc đúng chuẩn cho một chương phân tích yêu cầu: khảo sát hiện trạng (TeamViewer/
  AnyDesk/RustDesk gốc) → tổng quan use case → use case phân rã → đặc tả use case (bảng
  UC-01…UC-05) → yêu cầu phi chức năng. Văn phong nhất quán, lập luận về hạn chế RustDesk
  gốc (không OIDC, AB không đồng bộ, không Web Admin UI) đúng và khớp với động lực đồ án.
- UC-02 "Kết nối từ xa" (include kiểm tra quyền → thiết lập kết nối RustDesk, extend nhập
  password) bám khá sát luồng thật (`check_access_blocking` → `new_remote`).

## Thiếu sót / lệch so với hệ thống thật

### 1. Mô hình phân quyền — lệch lớn nhất, vì đây là đóng góp lõi của đồ án

Tài liệu mô tả **một** actor "Quản trị viên" duy nhất, toàn quyền, và **một** lớp "role"
đơn cho cả việc xác định máy trạm (UC-05 "Quản lý role và phân quyền") lẫn quyền quản trị.
Thực tế hệ thống đã tách thành **2 hệ độc lập** (`docs/admin-ui.md`, `docs/keycloak.md`):

- Machine-access: **Keycloak Group** (không còn gọi "role"), đọc qua claim `groups`.
- Admin UI: **3 client role riêng** trên client `rocky-admin` (`admin`/`manage_users`/
  `manage_machines`), có ranh giới quyền rõ (chỉ admin tối cao tạo/xoá Group và gán role
  admin-tier).

Tài liệu hoàn toàn không thể hiện sự phân tầng này — nếu dùng nguyên bản này làm Chương 2
thì sẽ **không khớp** với Chương 4/5 đã viết.

### 2. Thiếu hoàn toàn 2FA

Không một dòng nào nhắc tới việc Admin UI bắt buộc 2FA (TOTP) cho admin tối cao — một
tính năng bảo mật đã triển khai thật (`browser-admin-otp` flow).

### 3. Đăng nhập Google bị trình bày như đã hoàn thiện

UC-01 và biểu đồ use case phân rã "Đăng nhập" coi "Đăng nhập với Google" là nhánh ngang
hàng, đã hoàn chỉnh với username/password. Thực tế theo `CLAUDE.md`/`docs/keycloak.md`,
Google login **mới chỉ có hướng dẫn cấu hình** (`.claude/plans/keycloak-google-login.md`),
**chưa cấu hình/kiểm thử thật** trên Keycloak.

### 4. Trường "tag" của máy trạm — vừa lỗi thời, vừa mâu thuẫn nội bộ

- Mục 0.3.4 (UC-04.1 "Thêm máy trạm") ghi: *"Quản trị viên nhập tên máy trạm, RustDesk ID,
  **tag**, ghi chú."*
- Nhưng trường `tag` đã bị **xoá hoàn toàn** khỏi schema máy trạm thật từ 2026-06-17
  (`docs/admin-ui.md` Change Log).
- Mâu thuẫn nội bộ: ngay mục 0.2.2(e) của cùng tài liệu lại mô tả đúng (không có tag):
  *"tên hiển thị, RustDesk ID, và ghi chú"*.

### 5. Use case "Sửa người dùng" (UC-03) chưa có tương ứng thật

Tài liệu liệt kê đủ vòng đời: Thêm/**Sửa**/Mở khóa/Khóa/Phân quyền người dùng. Nhưng API
thật (`CLAUDE.md` mục Admin API) chỉ có `POST` (tạo), `DELETE` (xoá), `PUT .../enabled`
(khoá/mở), `POST|DELETE .../groups`, `POST|DELETE .../admin-roles` — **không có** endpoint
nào sửa thông tin cơ bản (tên/email) của user đã tạo.

### 6. Yêu cầu phi chức năng 0.4.5 — 2 điểm lỗi thời

- *"Dữ liệu cấu hình được lưu trữ dưới dạng tệp JSON"* — thực tế đã chuyển sang **SQLite**
  (`data/rocky.db`) từ 2026-06-17; `data.json` giờ chỉ là nguồn migrate một lần.
- *"Hệ thống hỗ trợ triển khai trong môi trường Docker đối với các thành phần máy chủ"* —
  thực tế **chưa container hóa**: chỉ Keycloak chạy bằng `docker run` thủ công, gateway
  chạy trực tiếp `node server.js`, chưa có Dockerfile/Compose nào trong repo (kế hoạch nằm
  ở `.claude/plans/optimize-and-package.md`, chưa triển khai).

### 7. UC-02 thiếu 2 nhánh ngoại lệ quan trọng đã có thật trong code

Tài liệu chỉ liệt kê "máy ngoại tuyến" và "lỗi mạng". Thiếu 2 nhánh thực tế quan trọng hơn
về nghiệp vụ phân quyền: **chưa đăng nhập** (`reason: login_required` → msgbox yêu cầu đăng
nhập) và **không có quyền truy cập máy** (`reason: no_permission` → msgbox từ chối) — đây
chính là use case mà toàn bộ tính năng kiểm soát truy cập của đồ án hướng tới, nhưng lại
không xuất hiện trong đặc tả.

### 8. Bảng so sánh tính năng (0.1.4) còn là placeholder

Sau heading "Bảng so sánh tính năng" chỉ có chữ in nghiêng *"Bảng so sánh..."* — bảng thật
chưa được điền, trong khi đoạn văn ngay dưới đã bàn luận như thể bảng đã tồn tại.

## Mức độ ảnh hưởng nếu ghép vào báo cáo tổng

Nếu file này được dùng làm Chương 2 (Khảo sát & phân tích yêu cầu) của cùng báo cáo có
Chương 4/5 đã viết (cập nhật đúng theo source), thì **điểm 1, 2, 3** sẽ tạo ra mâu thuẫn rõ
giữa các chương — Chương 2 mô tả yêu cầu/use case theo mô hình phân quyền và đăng nhập cũ
(1 role đơn, không 2FA, Google login đã xong), còn Chương 4/5 mô tả đúng hiện trạng (2 tầng
phân quyền, 2FA, Google login mới ở mức kế hoạch). Cần cập nhật lại phần use case "Quản lý
nhóm truy cập"/"Quản lý người dùng" và bổ sung use case 2FA + sửa nhánh ngoại lệ UC-02
trước khi coi là hoàn chỉnh.

## Việc đã làm (hoàn thành 2026-06-24 → xem `baocaoc2.md`)

- [x] Viết lại UC-05 "Quản lý role và phân quyền" → tách thành UC-05 "Quản lý nhóm truy cập"
  (Keycloak Group) và UC-06 "Quản lý phân quyền Admin UI" (3-tier).
- [x] Thêm UC-07 "Xác thực 2 lớp (2FA)" cho riêng admin tối cao.
- [x] Sửa UC-01: Google login ghi nhận là tùy chọn, chỉ khả dụng khi đã cấu hình Keycloak IdP.
- [x] Sửa UC-04.1: bỏ trường "tag" khỏi luồng sự kiện.
- [x] UC-03: bỏ "Sửa người dùng", thêm ghi chú tính năng chưa có endpoint; thêm UC-03.4 Xóa
  người dùng; đổi "Gán role" → "Gán nhóm truy cập".
- [x] Sửa 2.4.5: đổi "lưu JSON" → "lưu SQLite"; làm rõ chỉ Keycloak dùng Docker, chưa có Compose.
- [x] Bổ sung 2 nhánh ngoại lệ "chưa đăng nhập" / "không có quyền" vào UC-02.
- [x] Điền bảng so sánh tính năng đầy đủ ở mục 2.1.4.
- [x] Thay toàn bộ thuật ngữ "role" → "nhóm (Group/Keycloak Group)" trong ngữ cảnh phân quyền
  máy trạm; sửa "role được lưu trong Access Token" → "claim groups trong JWT".
- [x] Sửa actor Hình 0.6 (Quản lý máy trạm) từ "Người dùng" → "Quản trị viên".
