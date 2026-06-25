# Kết luận

## So sánh với các nghiên cứu/sản phẩm tương tự

RustDesk bản gốc, cũng như các sản phẩm remote desktop mã nguồn mở khác (ví dụ Apache
Guacamole, NoMachine, hoặc các bản tự host của TeamViewer/AnyDesk), đều giải quyết tốt bài
toán truyền hình ảnh/điều khiển từ xa, nhưng phần xác thực và phân quyền thường dừng ở mức cơ
bản: RustDesk gốc xác thực bằng mã định danh + mật khẩu của từng máy, không có khái niệm tài
khoản người dùng tổ chức; Guacamole có hỗ trợ LDAP/OIDC nhưng là ứng dụng web, không gặp giới
hạn "desktop không có WebView" mà ROCKY phải giải quyết. So với các giải pháp thương mại
(TeamViewer, AnyDesk) tích hợp sẵn SSO doanh nghiệp, ROCKY không có quy mô hạ tầng và độ hoàn
thiện tương đương, nhưng đạt được mục tiêu tương tự — xác thực tập trung qua Keycloak, phân
quyền truy cập theo nhóm tổ chức — trên nền một sản phẩm mã nguồn mở miễn phí, với chi phí
triển khai thấp hơn nhiều (không cần mua license, không phụ thuộc dịch vụ cloud của hãng thứ
ba) và đặc biệt là **toàn quyền kiểm soát dữ liệu** (self-hosted hoàn toàn, từ Keycloak đến
gateway đến rendezvous server).

Điểm khác biệt cốt lõi của ROCKY so với việc "thêm SSO" theo cách thông thường (ví dụ nhúng
WebView, hoặc đăng ký custom URL scheme) là mô hình lai trình duyệt hệ thống + gateway đóng vai
trò callback receiver — một giải pháp tổng quát có thể tái sử dụng cho bất kỳ ứng dụng desktop
nào không có WebView mà cần tích hợp OAuth/OIDC, không riêng gì RustDesk.

## Những gì đã làm được

- Tích hợp **Keycloak SSO** (Authorization Code Flow) vào client desktop Sciter — môi trường
  không có WebView nhúng — bằng mô hình lai trình duyệt hệ thống + gateway callback receiver,
  cầu nối bằng cơ chế polling bất đồng bộ phía TIScript, không sửa đổi lõi Rust/RustDesk.
- Xây dựng mô hình **phân quyền hai tầng**: Address Book hiển thị đúng danh sách máy theo
  **Keycloak Group** mà người dùng thuộc về; Admin UI phân quyền theo **3 tier**
  (`admin`/`manage_users`/`manage_machines`) trên client Keycloak riêng (`rocky-admin`), kèm
  **2FA (TOTP)** bắt buộc cho admin tối cao.
- Xây dựng **Web Admin UI** 3 tab (Người dùng / Group / Máy) cho phép quản lý toàn bộ vòng đời
  người dùng và máy trạm qua Keycloak Admin REST API, không cần thao tác trực tiếp trên
  Keycloak Console; gateway Node.js không phụ thuộc npm, persistence bằng SQLite.
- **Chặn kết nối trái phép** tới máy không được phân quyền ngay tại tầng Rust
  (`check_access_blocking`, gọi đồng bộ, fail-open khi hạ tầng lỗi).
- **Rebrand** (tên ứng dụng, theme navy/teal, icon) và toàn bộ tính năng mới được tập trung vào
  số lượng tối thiểu các điểm can thiệp, giữ khả năng merge các bản vá bảo mật từ RustDesk gốc
  trong tương lai.
- **CI build** tự động đóng gói cho cả ba nền tảng Windows/Linux/macOS.
- Về quy mô: khoảng 147.000 dòng Rust (kế thừa + tùy biến), hơn 1.000 dòng gateway và 1.000
  dòng Admin UI hoàn toàn mới, 27 endpoint REST API; **22 trường hợp kiểm thử** (hộp đen + thủ
  công trên UI) trải đều 4 nhóm chức năng trọng yếu, tất cả đạt yêu cầu, kể cả 2 lỗi phát sinh
  giữa quá trình kiểm thử (rò rỉ session login treo, JWT giả mạo bị nhận diện sai) đã được phát
  hiện và khắc phục.

## Những gì chưa làm được

- **2FA (TOTP)** chỉ bắt buộc với role `admin` tối cao, chưa mở rộng cho
  `manage_users`/`manage_machines` — hai tier có quyền quản trị thật (CRUD user/máy) nhưng đăng
  nhập không bị bắt OTP.
- **`check_access_blocking` chỉ enforce ở client ROCKY**: người dùng dùng client RustDesk gốc
  (không qua lớp kiểm soát này) vẫn có thể bỏ qua hoàn toàn cơ chế phân quyền — giới hạn của
  thiết kế client-side enforcement.
- Một **service account Keycloak** (`rustdesk-client`) dùng chung cho mọi lệnh Admin REST API
  của cả hai hệ thống con (machine-access và Admin UI) — lộ `CLIENT_SECRET` ảnh hưởng đồng thời
  cả hai.
- Một số thao tác ghi nhiều bước trên SQLite **không có transaction**
  (`setMachineGroups`/`setGroupMachineIds`, tạo user kèm gán Group/role) — có thể để lại trạng
  thái dở nếu hệ thống gặp sự cố giữa các bước.
- **Cấu hình nhạy cảm hardcode** (`VM_HOST`, `KEYCLOAK_HOST`, client secret) trực tiếp trong
  `server.js`, chưa chuyển sang `.env`.
- Hệ thống **chưa container hóa**, chưa tự host hbbs/hbbr — mô hình triển khai hiện tại chỉ chạy
  thủ công ba tiến trình trên một VM thử nghiệm, chưa production-ready.
- Chưa kiểm thử với JWT thật phát sinh từ một phiên **đăng nhập Google Social Login** đầy đủ —
  tính năng mới có hướng dẫn cấu hình, chưa được xác minh end-to-end.
- **CI build Windows/Linux** chưa có lần chạy end-to-end xác nhận thành công sau các lần sửa
  lỗi gần nhất.
- Một số luồng CRUD trên Admin UI (sửa máy, tạo/xóa vai trò, một vài trường hợp đồng bộ dữ
  liệu) còn thiếu hoàn thiện — đã có kế hoạch chi tiết nhưng chưa triển khai hết trong code.

## Đóng góp nổi bật

1. **Mô hình lai OIDC cho desktop app không có WebView** — giải quyết bài toán Authorization
   Code Flow cho một engine UI (Sciter) không thể điều hướng URI bên ngoài, bằng cách ủy quyền
   toàn bộ vai trò callback receiver cho gateway, tách luồng thành hai giai đoạn nối qua
   server-side session. Mô hình có tính tổng quát, áp dụng được cho bất kỳ ứng dụng desktop
   tương tự.
2. **Cơ chế polling bất đồng bộ có trạng thái trong TIScript** — mô phỏng async/await bằng chuỗi
   callback có kiểm soát trên một single-thread UI loop, xử lý đúng cả ba điều kiện dừng (hủy,
   thành công, timeout) mà không để lại timer orphan hay memory leak.
3. **Quản lý vòng đời người dùng toàn diện qua Keycloak Admin REST API** — đưa toàn bộ thao tác
   cấp/thu hồi quyền, khóa/mở tài khoản vào một giao diện web quen thuộc, không cần quản trị
   viên tiếp cận Keycloak Console.
4. **Phân quyền tài nguyên hai tầng tách biệt danh tính và tài nguyên** — Keycloak quản lý "ai
   là ai", ROCKY quản lý "ai được dùng cái gì"; thêm một máy cho cả nhóm người dùng chỉ cần một
   thao tác cấu hình, thu hồi quyền chỉ cần đổi Group trên Keycloak.
5. **Chiến lược tùy biến mã nguồn mở bảo toàn khả năng cập nhật lâu dài** — tập trung hóa điểm
   can thiệp (tên ứng dụng, màu thương hiệu tại một nơi duy nhất; tính năng mới là file riêng
   biệt) để giữ diff với upstream nhỏ và có tổ chức.

## Bài học kinh nghiệm

- Khi tích hợp một giao thức được thiết kế cho trình duyệt (OIDC Authorization Code Flow) vào
  một môi trường không có trình duyệt nhúng, giải pháp đúng không phải là cố mô phỏng trình
  duyệt (nhúng WebView) mà là **xác định lại ranh giới trách nhiệm**: đẩy phần việc trình duyệt
  mới làm tốt sang một thành phần khác (gateway) thay vì ép client phải làm được điều nó không
  được thiết kế để làm.
- **Cơ chế fail-open** (cho phép kết nối khi không xác định được quyền) là một quyết định đánh
  đổi UX-trước-an toàn hợp lý ở giai đoạn thử nghiệm, nhưng cần được nhìn nhận rõ là **lớp bảo
  vệ UX, không phải biên an toàn (security boundary)** thật — nếu không, dễ tạo cảm giác sai về
  mức độ an toàn của hệ thống.
- Khi mô hình phân quyền thay đổi (từ 1 role đơn sang 3-tier), **mọi cơ chế bảo vệ gắn theo
  role cũ (ở đây là 2FA) cần được rà soát lại đồng bộ** — nếu không, các tier mới phát sinh sẽ
  vô tình lọt qua các lớp bảo vệ được thiết kế cho mô hình cũ.
- Các thao tác ghi nhiều bước trên một kho dữ liệu dùng chung (xóa rồi chèn lại mapping,
  tạo user kèm gán quyền) **cần được nhìn nhận là cần transaction ngay từ thiết kế ban đầu**,
  không phải việc bổ sung sau — chi phí sửa sau khi đã có dữ liệu thật cao hơn nhiều so với làm
  đúng từ đầu.
- Giữ diff với một dự án mã nguồn mở upstream nhỏ không tự nhiên xảy ra — nó là kết quả của một
  **nguyên tắc thiết kế được áp dụng có chủ đích** (tập trung điểm can thiệp) ngay từ những thay
  đổi đầu tiên, không thể áp dụng ngược lại sau khi mã đã lan rộng.

# Hướng phát triển

## Hoàn thiện các chức năng đã làm

1. Mở rộng **2FA bắt buộc cho cả ba tier quản trị**, không chỉ riêng admin tối cao, để thống
   nhất mức độ bảo vệ cho mọi tài khoản có quyền thay đổi cấu hình hệ thống.
2. **Tách service account Keycloak riêng** cho luồng Admin UI và luồng machine-access, giảm bán
   kính ảnh hưởng khi một secret bị lộ.
3. **Bổ sung transaction** cho các thao tác ghi nhiều bước trên SQLite gateway, tránh trạng thái
   dữ liệu dở khi có sự cố giữa các bước.
4. **Chuyển cấu hình hardcode sang `.env`** và hoàn thiện các luồng CRUD Admin UI còn thiếu —
   theo kế hoạch đã có ở `optimize-and-package.md` (phần tối ưu mã nguồn) và
   `lap-plan-hoan-thien-tidy-starfish.md`.
5. **Triển khai thật tính năng đăng nhập Google** — phần cấu hình Keycloak đã có hướng dẫn đầy
   đủ (`keycloak-google-login.md`), chỉ cần thực hiện trên Keycloak Console và kiểm thử
   end-to-end.
6. **Hoàn tất xác nhận CI build end-to-end** cho cả ba nền tảng sau các lần sửa lỗi gần nhất.

## Hướng đi mới để cải thiện và nâng cấp

1. **Đẩy lớp kiểm soát truy cập xuống tầng rendezvous/relay server** (hbbs/hbbr) thay vì chỉ
   enforce ở client ROCKY, để chính sách phân quyền không thể bị bỏ qua bằng cách dùng client
   RustDesk gốc — đây là hướng nâng cấp quan trọng nhất nếu muốn đưa hệ thống vào môi trường
   production thực sự.
2. **Container hóa toàn hệ thống** bằng Docker Compose (Keycloak + hbbs/hbbr tự host + ROCKY
   Gateway) và "bake" cấu hình server vào client qua cơ chế `naming`/`custom_server.rs` sẵn có
   của RustDesk, để người dùng cuối không phải tự nhập địa chỉ server — theo kế hoạch đã thiết
   kế ở `optimize-and-package.md` (phần đóng gói).
3. **Hiển thị thông tin hồ sơ người dùng** (tên thật thay vì chỉ username) trên giao diện, bằng
   cách gọi endpoint `/userinfo` của Keycloak với access token hiện có — theo phân tích đã có ở
   `user-profile-auth-notes.md`.
4. Bổ sung **audit log** (ghi nhận ai kết nối tới máy nào, khi nào) ở tầng gateway, phục vụ truy
   vết và tuân thủ (compliance) khi triển khai trong tổ chức thật.
5. Mở rộng mô hình phân quyền để hỗ trợ **đa tổ chức/đa realm** (multi-tenant) nếu hệ thống cần
   phục vụ nhiều tổ chức độc lập trên cùng một hạ tầng Keycloak/Gateway.
6. **Kiểm thử ở môi trường có nhiều người dùng đồng thời** để đo khả năng chịu tải của gateway
   và endpoint `/api/check-access`, trước khi coi hệ thống là sẵn sàng cho môi trường
   production.
