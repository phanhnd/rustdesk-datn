# CHƯƠNG 2: KHẢO SÁT HIỆN TRẠNG VÀ PHÂN TÍCH YÊU CẦU

> **Ghi chú đối chiếu (2026-06-24):** Bản này đã được sửa lại toàn bộ so với bản nháp PDF
> (`DATN20252_PhuongAnh (3).pdf`) để khớp với implementation thực tế. Các điểm thay đổi
> chính: (1) mô hình phân quyền tách thành 2 hệ độc lập (machine-access theo Keycloak Group,
> Admin UI theo 3-tier client role); (2) lưu trữ SQLite thay JSON; (3) trường "tag" máy trạm
> đã bỏ; (4) Google login ghi nhận là tính năng tùy chọn/cấu hình thêm; (5) bổ sung nhánh
> ngoại lệ UC-02 và use case 2FA; (6) điền bảng so sánh tính năng 0.1.4;
> (7) tách UC-05 thành quản lý nhóm + quản lý phân quyền admin.
> Chi tiết phân tích đầy đủ: `danh-gia-doi-chieu-chuong2-phuonganh.md`.

Chương 1 đã trình bày bối cảnh của bài toán truy cập và quản lý thiết bị từ xa, cùng với
các mục tiêu và định hướng giải pháp của đồ án với hệ thống. Trong đó, ba yêu cầu kỹ thuật
trọng tâm được xác định bao gồm: (i) xây dựng một hệ thống remote desktop có hiệu năng cao
và có khả năng tự chủ hạ tầng, (ii) tích hợp xác thực tập trung với phân quyền chi tiết dựa
trên vai trò người dùng, và (iii) quản lý tập trung danh bạ máy trạm với khả năng đồng bộ và
phân quyền truy cập. Chương 2 này sẽ trình bày kết quả khảo sát chi tiết các giải pháp hiện
có (cả thương mại và mã nguồn mở), từ đó phân tích các yêu cầu chức năng và phi chức năng
của hệ thống, đồng thời đặc tả chi tiết các use case quan trọng làm cơ sở cho việc thiết kế
và triển khai trong các chương tiếp theo.

---

## 2.1 Khảo sát hiện trạng

### 2.1.1 Đánh giá các giải pháp thương mại

TeamViewer hiện được xem là giải pháp remote desktop có thị phần lớn nhất và danh tiếng lâu
đời trên thị trường. Giải pháp này cung cấp bộ kỹ năng phụ trợ phong phú bao gồm hỗ trợ đa
nền tảng (Windows, macOS, Linux, Android, iOS), ghi phiên làm việc, hỗ trợ nhiều người dùng
cùng tham gia vào phiên kết nối, và khả năng truy cập từ thiết bị di động. Giao diện được
đánh giá là trực quan, dễ sử dụng ngay cả với người mới bắt đầu, và hiệu năng kết nối nhìn
chung ổn định với độ trễ thấp trong điều kiện mạng tốt. Tuy nhiên, chi phí bản quyền của
TeamViewer là rất cao với cá nhân và doanh nghiệp nhỏ, trong khi phiên bản miễn phí bị giới
hạn về dung lượng và tính năng. Một hạn chế đáng kể khác là người dùng phải phụ thuộc hoàn
toàn vào máy chủ trung gian của TeamViewer, dẫn đến nguy cơ về quyền riêng tư và bảo mật
dữ liệu khi thông tin truyền qua bên thứ ba mà tổ chức không thể kiểm soát [1].

AnyDesk là một lựa chọn phổ biến khác, nổi bật với tốc độ kết nối nhờ sử dụng độc quyền
DeskRT (bộ codec truyền hình ảnh từ xa được công ty đứng sau AnyDesk phát triển) tối ưu cho
tốc độ khung hình cao và độ trễ thấp, ngay cả khi kết nối mạng không ổn định. AnyDesk có
giao diện người dùng mượt mà, chuyên nghiệp, với các tùy chọn được tổ chức rõ ràng và dễ
sử dụng. Tuy nhiên, tương tự TeamViewer, AnyDesk cũng gặp phải vấn đề về chi phí và sự phụ
thuộc vào máy chủ bên thứ ba. Người dùng cá nhân thường xuyên kết nối vào cùng một thiết bị
có thể gặp thông báo trả phí, gây gián đoạn trải nghiệm và làm giảm hiệu quả công việc. Cả
hai giải pháp thương mại đều không cung cấp khả năng tự lưu trữ (self-hosted) cho phiên bản
miễn phí, điều này khiến chúng không phù hợp với các tổ chức có yêu cầu kiểm soát dữ liệu
nội bộ nghiêm ngặt [2] [3].

### 2.1.2 Đánh giá giải pháp mã nguồn mở RustDesk

RustDesk nổi lên như một giải pháp thay thế mã nguồn mở đầy triển vọng cho các phần mềm
remote desktop thương mại, được xây dựng dựa trên nền tảng Web Real-Time Communication
(WebRTC - một tập hợp các giao thức, API và thư viện cho phép hai thiết bị truyền thông thời
gian thực trực tiếp với nhau qua Internet mà không cần cài plugin), cùng công nghệ cốt lõi
đằng sau các ứng dụng hội nghị truyền hình phổ biến như Zoom và Google Meet. Điểm mạnh cốt
lõi của RustDesk nằm ở ba yếu tố chính: mã nguồn mở hoàn toàn, khả năng tự lưu trữ
(self-hosted) máy chủ relay, và hiệu năng cao nhờ được viết bằng ngôn ngữ Rust [4] [5].

Về tính minh bạch và bảo mật, RustDesk có toàn bộ mã nguồn được công khai trên nền tảng
GitHub, cho phép cộng đồng kiểm tra, đánh giá và phát hiện các lỗ hổng bảo mật tiềm ẩn một
cách độc lập. Điều này tạo ra sự tin cậy cao hơn so với các giải pháp đóng mã nguồn, nơi
người dùng buộc phải tin tưởng vào nhà cung cấp mà không thể tự kiểm chứng. RustDesk sử dụng
giao thức truyền thông dựa trên cơ chế ICE (Interactive Connectivity Establishment), tương tự
như WebRTC, với sự hỗ trợ của STUN và TURN (hai giao thức hỗ trợ các thiết bị kết nối với nhau
qua Internet khi chúng nằm sau NAT hoặc firewall) để xử lý các tình huống NAT phức tạp. Cơ chế
này cho phép RustDesk thử nghiệm nhiều phương thức kết nối khác nhau, bao gồm kết nối trực tiếp
(peer-to-peer) khi có thể, và fallback sang chế độ relay qua máy chủ TURN khi không thể thiết
lập kết nối trực tiếp do các ràng buộc của NAT hoặc tường lửa [6] [7].

Về khả năng tự chủ hạ tầng, RustDesk cho phép người dùng triển khai máy chủ relay (hbbs –
RustDesk ID/Rendezvous Server, hbbr – RustDesk Relay Server) của riêng mình thông qua Docker
hoặc các phương thức cài đặt truyền thống. Khi tự lưu trữ, toàn bộ dữ liệu kết nối được định
tuyến qua hạ tầng do người dùng kiểm soát, không phải qua bất kỳ máy chủ trung gian nào của
bên thứ ba. Đây là một lợi thế vượt trội về mặt bảo mật và quyền riêng tư so với các giải
pháp thương mại, đặc biệt đối với các tổ chức có chính sách bảo mật nghiêm ngặt [4] [5].

Về chi phí, RustDesk hoàn toàn miễn phí cho cả mục đích sử dụng cá nhân và thương mại. Người
dùng không gặp phải các thông báo thương mại gây gián đoạn hay giới hạn tính năng khó chịu như
khi sử dụng phiên bản miễn phí của TeamViewer hay AnyDesk, giúp tiết kiệm đáng kể chi phí vận
hành cho các tổ chức [6].

### 2.1.3 Hạn chế của RustDesk bản gốc

Mặc dù sở hữu nhiều ưu điểm vượt trội, RustDesk phiên bản mã nguồn mở miễn phí vẫn tồn tại
những hạn chế đáng kể đối với các tổ chức có nhu cầu quản lý tập trung và phân quyền chi tiết.

Hạn chế thứ nhất liên quan đến cơ chế xác thực và phân quyền. RustDesk bản gốc không hỗ trợ
xác thực qua các giao thức chuẩn như OAuth2 hay OpenID Connect (OIDC) để tích hợp với các hệ
thống quản lý danh tính tập trung như Keycloak. Thay vào đó, người dùng chỉ cần biết ID của
máy trạm đích là có thể kết nối, không có khái niệm tài khoản người dùng tập trung hay phân
quyền truy cập dựa trên vai trò. Điều này gây khó khăn cho việc quản lý người dùng trong môi
trường tổ chức, nơi cần kiểm soát chặt chẽ ai có quyền truy cập vào thiết bị nào.

Hạn chế thứ hai liên quan đến tính năng Address Book. RustDesk bản gốc lưu trữ danh sách máy
trạm (Address Book) cục bộ trên từng thiết bị của người dùng, không hỗ trợ đồng bộ giữa các
thiết bị. Các thảo luận trong cộng đồng RustDesk chỉ ra rằng phiên bản mã nguồn mở miễn phí
không có cơ chế đồng bộ hóa Address Book tự động, và người dùng muốn có tính năng này phải
nâng cấp lên phiên bản Pro có trả phí hoặc tự xây dựng giải pháp thay thế thủ công như sử
dụng trình quản lý mật khẩu để lưu trữ ID kết nối. Ngoài ra, không có cơ chế phân quyền truy
cập Address Book – bất kỳ ai biết ID của máy đều có thể kết nối nếu máy được cấu hình chấp
nhận kết nối không mật khẩu.

Hạn chế thứ ba liên quan đến khả năng quản trị tập trung. RustDesk bản gốc không cung cấp
giao diện quản trị web (Web Admin UI) để quản lý người dùng, vai trò, thiết bị và các ánh xạ
phân quyền. Các tác vụ quản trị như thêm người dùng mới, gán quyền truy cập, hoặc cấu hình
danh sách máy mà một nhóm người dùng được phép truy cập đều phải thực hiện thủ công thông qua
các công cụ dòng lệnh hoặc can thiệp trực tiếp vào cơ sở dữ liệu (nếu có).

### 2.1.4 Bảng so sánh tính năng

| Tính năng | TeamViewer | AnyDesk | RustDesk gốc | **ROCKY** |
|---|---|---|---|---|
| Xác thực tập trung (OIDC/OAuth2) | Có (trả phí) | Có (trả phí) | Không | **Có** |
| Self-hosted toàn bộ | Không | Không | Có | **Có** |
| Web Admin UI | Có (trả phí) | Có (trả phí) | Không | **Có** |
| Phân quyền truy cập theo nhóm | Có (trả phí) | Có (trả phí) | Không | **Có** |
| Address Book đồng bộ theo phân quyền | Có (trả phí) | Có (trả phí) | Không (miễn phí) | **Có** |
| Đăng nhập Google (SSO) | Có (trả phí) | Có (trả phí) | Không | **Có (qua Keycloak)** |
| Miễn phí hoàn toàn | Không | Không | Có | **Có** |
| Mã nguồn mở | Không | Không | Có | **Có (fork RustDesk)** |
| Đa nền tảng | Có | Có | Có | Có (Windows/Linux/macOS) |
| 2FA cho quản trị viên | Có (trả phí) | Có (trả phí) | Không | **Có (TOTP)** |

Qua bảng so sánh trên, có thể thấy các giải pháp thương mại như TeamViewer và AnyDesk cung cấp
đầy đủ các tính năng quản lý tập trung, nhưng chỉ ở các gói trả phí cao và người dùng không
thể tự chủ về hạ tầng. RustDesk mã nguồn mở cung cấp nền tảng kỹ thuật tốt với chi phí bằng
không và khả năng tự lưu trữ, nhưng thiếu hoàn toàn các tính năng quản lý tập trung cần thiết
cho tổ chức. RustDesk Pro (phiên bản thương mại) giải quyết các hạn chế về quản lý tập trung
nhưng lại đánh đổi bằng chi phí bản quyền và mất đi bản chất mã nguồn mở. Đồ án này hướng đến
việc kết hợp những ưu điểm của cả hai: giữ nguyên bản chất mã nguồn mở và miễn phí của
RustDesk, đồng thời bổ sung các tính năng quản lý tập trung (xác thực OIDC, phân quyền theo
nhóm, Address Book đồng bộ, Web Admin UI) thông qua việc xây dựng một gateway trung gian bằng
Node.js.

---

## 2.2 Tổng quan chức năng

Dựa trên kết quả khảo sát hiện trạng và phân tích nhu cầu của tổ chức đối với một hệ thống
quản lý và truy cập thiết bị từ xa, phần này trình bày tổng quan các chức năng của hệ thống
cần xây dựng. Các chức năng được mô tả ở mức cao, làm cơ sở cho việc phân tích và thiết kế
chi tiết trong các chương tiếp theo.

### 2.2.1 Biểu đồ use case tổng quát

Hệ thống ROCKY được xây dựng nhằm cung cấp giải pháp truy cập và quản lý thiết bị từ xa với
cơ chế xác thực và tập trung phân quyền. Dựa trên yêu cầu nghiệp vụ, các chức năng của hệ
thống được xác định rõ và mô hình hóa thông qua biểu đồ use case.

Hệ thống có hai nhóm tác nhân chính tham gia là **Người dùng** và **Quản trị viên**. Quản trị
viên được phân thành 3 tier (cấp độ quyền):
- **Admin tối cao** (`admin`): toàn quyền hệ thống — bao gồm tạo/xóa nhóm Keycloak và gán/thu
  hồi quyền quản trị cho các quản trị viên khác; bắt buộc sử dụng xác thực 2 lớp (2FA/TOTP).
- **Quản trị người dùng** (`manage_users`): CRUD tài khoản Keycloak và gán người dùng vào nhóm
  truy cập máy trạm.
- **Quản trị máy trạm** (`manage_machines`): CRUD danh sách máy trạm và gán máy vào nhóm truy
  cập.

Bất kỳ quản trị viên nào có ít nhất một trong ba quyền trên đều có thể đăng nhập vào Web Admin
UI.

*(Hình 2.1: Biểu đồ use case tổng quan — vẽ lại theo sơ đồ dưới)*

```
Hệ thống ROCKY
├── Người dùng
│   ├── Đăng nhập (Keycloak)
│   ├── Đăng xuất
│   ├── Xem danh sách máy (Address Book)
│   ├── Tìm kiếm máy
│   └── Kết nối từ xa
└── Quản trị viên (3 tier)
    ├── Đăng nhập Web Admin UI
    ├── Đăng xuất
    ├── Quản lý người dùng          [manage_users / admin]
    ├── Quản lý máy trạm            [manage_machines / admin]
    ├── Quản lý nhóm truy cập       [admin (tạo/xóa nhóm) + manage_users/manage_machines (xem/gán)]
    └── Quản lý phân quyền Admin UI [admin tối cao]
```

Người dùng là những nhân viên hoặc cá nhân được cấp tài khoản trong hệ thống Keycloak, đăng
nhập bằng tài khoản nội bộ (username/password) hoặc tùy chọn đăng nhập qua Google (khi đã
cấu hình Keycloak Identity Provider Google) chờ được phân quyền truy cập. Sau khi đăng nhập
thông qua Keycloak, người dùng có thể xem danh sách các máy trạm mà mình được phép truy cập
dựa trên **nhóm (Keycloak Group)** được gán. Từ danh sách này, người dùng có thể lựa chọn
thiết bị và thực hiện kết nối điều khiển từ xa thông qua nền tảng RustDesk. Ngoài ra, người
dùng có thể thực hiện chức năng đăng xuất để kết thúc phiên làm việc và hủy hiệu lực phiên
xác thực hiện tại.

Quản trị viên là người chịu trách nhiệm quản lý toàn bộ hệ thống. Tùy theo tier quyền, quản
trị viên có thể quản lý danh sách người dùng, quản lý danh sách máy trạm, quản lý các nhóm
truy cập trong hệ thống. Thông qua giao diện Web Admin UI, quản trị viên có thể tạo mới, chỉnh
sửa hoặc vô hiệu hóa tài khoản người dùng; thêm, sửa hoặc xóa máy trạm; tạo và quản lý các
nhóm; đồng thời gán người dùng và máy trạm vào các nhóm tương ứng để kiểm soát quyền truy cập.
Chỉ admin tối cao mới có thể tạo/xóa nhóm Keycloak và gán quyền quản trị Admin UI.

### 2.2.2 Biểu đồ use case phân rã

#### a. Biểu đồ use case phân rã "Đăng nhập với Keycloak"

*(Hình 2.2: Biểu đồ use case phân rã Đăng nhập)*

Chức năng đăng nhập là chức năng đầu tiên mà người dùng phải thực hiện để truy cập vào hệ
thống ROCKY. Hệ thống sử dụng Keycloak làm máy chủ quản lý danh tính tập trung và hỗ trợ
cơ chế xác thực theo chuẩn OpenID Connect (OIDC).

Use Case "Đăng nhập" được phân rã thành hai hình thức xác thực khác nhau gồm: Đăng nhập bằng
tên đăng nhập và mật khẩu (luồng chính, luôn khả dụng) và Đăng nhập bằng tài khoản Google
(tùy chọn — chỉ khả dụng khi quản trị viên đã cấu hình Identity Provider Google trên Keycloak).
Hai Use Case này có mối quan hệ kế thừa (Generalization) với Use Case "Đăng nhập", thể hiện
việc người dùng có thể lựa chọn một trong hai phương thức xác thực để truy cập hệ thống.

Sau khi người dùng xác thực thành công, Keycloak sẽ cấp Access Token chứa thông tin định danh
và danh sách **nhóm (groups claim)** mà người dùng thuộc về. Token này được sử dụng trong các
yêu cầu tiếp theo để hệ thống xác định quyền truy cập vào danh sách máy trạm và các chức năng
tương ứng. Trong trường hợp xác thực thất bại hoặc máy chủ Keycloak không phản hồi, hệ thống
sẽ hiển thị thông báo lỗi và yêu cầu người dùng thực hiện đăng nhập lại.

#### b. Biểu đồ use case phân rã "Tạo kết nối từ xa"

*(Hình 2.3: Biểu đồ use case phân rã Kết nối từ xa)*

Biểu đồ Use Case phân rã Kết nối từ xa mô tả các chức năng được thực hiện khi người dùng
thiết lập phiên điều khiển máy tính từ xa.

Khi người dùng lựa chọn một máy trạm trong Address Book, hệ thống sẽ **<<include>>** kiểm tra
quyền truy cập (gửi yêu cầu `/api/check-access` tới Gateway, Gateway xác minh người dùng thuộc
nhóm có quyền truy cập máy đó). Nếu có quyền, hệ thống **<<include>>** khởi tạo kết nối thông
qua hạ tầng RustDesk và thiết lập phiên điều khiển từ xa. Ngoài ra, trong một số trường hợp
máy trạm được cấu hình yêu cầu mật khẩu truy cập, hệ thống sẽ **<<extend>>** kích hoạt Use
Case "Nhập mật khẩu máy".

**Các nhánh ngoại lệ quan trọng:**
- Người dùng **chưa đăng nhập**: hệ thống hiển thị msgbox yêu cầu đăng nhập trước.
- Người dùng **không có quyền truy cập máy** (không thuộc nhóm nào được gán cho máy đó):
  hệ thống hiển thị msgbox từ chối truy cập.
- Máy trạm **ngoại tuyến**: hệ thống hiển thị trạng thái Offline, kết nối không được thiết lập.
- **Lỗi mạng**: hệ thống hiển thị lỗi kết nối, người dùng có thể thực hiện lại thao tác.

#### c. Biểu đồ use case phân rã "Quản lý người dùng"

*(Hình 2.4: Biểu đồ use case phân rã Quản lý người dùng — Actor: Quản trị viên có quyền
`manage_users` hoặc `admin`)*

Biểu đồ Use Case phân rã Quản lý người dùng mô tả các chức năng quản trị liên quan đến vòng
đời tài khoản người dùng trong hệ thống.

Chức năng **thêm người dùng** cho phép quản trị viên tạo mới tài khoản trực tiếp trên hệ thống
Keycloak. Chức năng **gán nhóm truy cập** được sử dụng để cấp quyền truy cập máy trạm tương ứng
cho người dùng (gán user vào Keycloak Group). Chức năng **vô hiệu hóa người dùng** cho phép tạm
khóa tài khoản mà không cần xóa dữ liệu liên quan. Chức năng **xóa người dùng** loại bỏ vĩnh
viễn tài khoản khỏi Keycloak.

> **Lưu ý:** Chức năng **chỉnh sửa thông tin cơ bản** (tên, email) của người dùng đã tạo chưa
> được triển khai trong phiên bản hiện tại — Admin UI cung cấp tạo/khóa/xóa/gán nhóm, chưa có
> endpoint PUT để cập nhật thông tin cá nhân. Đây là tính năng dự kiến bổ sung trong phiên bản
> tiếp theo.

Thông qua chức năng quản lý người dùng, quản trị viên có thể kiểm soát tập trung toàn bộ tài
khoản trong hệ thống và đảm bảo việc phân quyền được thực hiện chính xác.

#### d. Biểu đồ use case phân rã "Quản lý nhóm truy cập"

*(Hình 2.5: Biểu đồ use case phân rã Quản lý nhóm truy cập)*

Hệ thống sử dụng **Keycloak Group** (nhóm cấp realm) làm đơn vị phân quyền truy cập máy
trạm — không phải Keycloak Client Role. Mỗi nhóm đại diện cho một tập người dùng được phép
truy cập một tập máy trạm nhất định (ví dụ: nhóm "IT Department", nhóm "Finance").

Use Case "Quản lý nhóm truy cập" bao gồm:
- **Tạo nhóm** (chỉ admin tối cao): tạo Keycloak Group mới.
- **Thêm người dùng vào nhóm** (`manage_users` / `admin`): gán user vào Group.
- **Xóa người dùng khỏi nhóm** (`manage_users` / `admin`): gỡ user khỏi Group.
- **Thêm máy trạm vào nhóm** (`manage_machines` / `admin`): gán machine ID vào Group (lưu
  trong bảng `machine_groups` SQLite).
- **Xóa máy trạm khỏi nhóm** (`manage_machines` / `admin`): gỡ machine khỏi Group.
- **Xóa nhóm** (chỉ admin tối cao): xóa Keycloak Group và toàn bộ ánh xạ máy trạm liên quan.

Khi người dùng đăng nhập vào hệ thống, Gateway đọc claim **`groups`** trong JWT Access Token
để xác định danh sách máy trạm mà người dùng được phép truy cập. Cơ chế này giúp đơn giản hóa
việc quản trị, đồng thời nâng cao tính bảo mật và khả năng kiểm soát truy cập trong toàn hệ
thống.

#### e. Biểu đồ use case phân rã "Quản lý máy trạm"

*(Hình 2.6: Biểu đồ use case phân rã Quản lý máy trạm — Actor: Quản trị viên có quyền
`manage_machines` hoặc `admin`)*

Biểu đồ Use Case phân rã Quản lý máy trạm mô tả các chức năng liên quan đến việc quản lý
danh sách thiết bị trong hệ thống ROCKY.

Khi thêm máy mới, quản trị viên cần cung cấp các thông tin như tên hiển thị, RustDesk ID, và
ghi chú. Chức năng cập nhật máy trạm cho phép chỉnh sửa các thông tin đã khai báo trước đó.
Chức năng xóa máy trạm giúp loại bỏ các thiết bị không còn sử dụng trong hệ thống.

Bên cạnh đó, quản trị viên có thể gán một hoặc nhiều nhóm truy cập cho từng máy trạm. Việc
này giúp hệ thống xác định chính xác người dùng nào được phép nhìn thấy và kết nối tới thiết
bị tương ứng.

#### f. Biểu đồ use case phân rã "Quản lý phân quyền Admin UI"

*(Hình 2.7: Biểu đồ use case phân rã Quản lý phân quyền Admin — Actor: Admin tối cao)*

Use Case này chỉ dành cho **admin tối cao**. Admin tối cao có thể gán hoặc thu hồi 3 loại
quyền quản trị (`admin`, `manage_users`, `manage_machines`) cho các tài khoản người dùng khác.
Đây là cơ chế phân tầng quyền quản trị, cho phép ủy quyền một phần cho các quản trị viên
cấp dưới mà không cần chia sẻ toàn bộ quyền hệ thống.

### 2.2.3 Quy trình nghiệp vụ

#### a. Quy trình đăng nhập và truy cập máy từ xa

*(Hình 2.8: Biểu đồ hoạt động Đăng nhập và Kết nối từ xa)*

```
Actors: User | ROCKY Client | Gateway | Keycloak
────────────────────────────────────────────────────────────────────────
Mở ứng dụng ROCKY
  → ROCKY Client kiểm tra token đã lưu
    ├── [Token còn hợp lệ] → bỏ qua bước xác thực, gọi thẳng API Address Book
    └── [Token hết hạn / chưa có] → Hiển thị nút Đăng nhập
          → User nhấn Đăng nhập
              → Gateway tạo URL OIDC Authorization → Mở trình duyệt hệ thống
              → User nhập username/password (hoặc Google nếu đã cấu hình)
              → Keycloak xác thực
                  ├── [Thành công] → Cấp Access Token (chứa claim groups)
                  │     → Gateway nhận callback, lưu token tạm
                  │     → ROCKY Client polling nhận Token
                  └── [Thất bại] → Thông báo lỗi → User thực hiện lại
  → ROCKY Client gọi /api/address-books (kèm token)
  → Gateway giải mã token, đọc groups claim, truy vấn DB lấy danh sách máy theo nhóm
  → Trả danh sách máy về ROCKY Client
  → User chọn máy trạm
      → ROCKY Client gọi /api/check-access
          ├── [Không đăng nhập] → Msgbox yêu cầu đăng nhập
          ├── [Không có quyền] → Msgbox từ chối truy cập
          └── [Có quyền] → Khởi tạo kết nối RustDesk → Phiên điều khiển từ xa
```

Biểu đồ hoạt động trên mô tả quy trình nghiệp vụ chính của hệ thống ROCKY từ khi người dùng
khởi động ứng dụng cho đến khi thiết lập thành công phiên điều khiển từ xa.

Quy trình bắt đầu khi người dùng mở ứng dụng ROCKY. Hệ thống kiểm tra sự tồn tại và tính hợp
lệ của Access Token đã được lưu từ phiên đăng nhập trước. Nếu token còn hiệu lực, hệ thống bỏ
qua bước xác thực và chuyển trực tiếp sang quá trình lấy danh sách máy trạm được phép truy
cập. Ngược lại, nếu token không tồn tại hoặc đã hết hạn, giao diện sẽ hiển thị chức năng
đăng nhập.

Người dùng thực hiện đăng nhập thông qua Keycloak bằng tài khoản nội bộ (username/password)
hoặc tùy chọn tài khoản Google (khi đã cấu hình). Sau khi xác thực thành công, Keycloak cấp
Access Token chứa thông tin định danh và danh sách **nhóm (groups)** mà người dùng thuộc về.
ROCKY Client sử dụng token này để gửi yêu cầu lấy Address Book tới Gateway.

Gateway thực hiện giải mã Access Token, đọc claim `groups` để xác định danh sách nhóm của
người dùng, sau đó truy vấn cơ sở dữ liệu SQLite để lấy các máy trạm được gán cho những nhóm
đó. Kết quả được trả về cho ứng dụng và hiển thị trên giao diện Address Book.

Người dùng chọn máy trạm để kết nối. ROCKY Client gửi yêu cầu kiểm tra quyền truy cập tới
Gateway. Nếu người dùng không đăng nhập hoặc không thuộc nhóm có quyền truy cập máy đó, hệ
thống hiển thị thông báo từ chối. Nếu có quyền, ROCKY Client sẽ khởi tạo kết nối từ xa thông
qua hạ tầng RustDesk và thiết lập phiên điều khiển từ xa. Sau khi kết nối thành công, người
dùng có thể thao tác trên thiết bị đích cho đến khi kết thúc phiên làm việc.

#### b. Quy trình quản lý người dùng và phân quyền

*(Hình 2.9: Biểu đồ hoạt động Quản lý người dùng và Phân quyền)*

Biểu đồ hoạt động trên mô tả quy trình quản lý người dùng và phân quyền được thực hiện bởi
quản trị viên thông qua giao diện Web Admin UI.

Quy trình bắt đầu khi quản trị viên đăng nhập vào hệ thống quản trị (xác thực qua Keycloak
client `rocky-admin`; admin tối cao bắt buộc thêm bước xác thực 2 lớp TOTP) và truy cập chức
năng quản lý người dùng. Hệ thống hiển thị danh sách các tài khoản hiện có được đồng bộ từ
Keycloak.

Tại đây, quản trị viên có thể thực hiện các thao tác như tạo mới người dùng, vô hiệu hóa tài
khoản, xóa tài khoản, hoặc gán người dùng vào nhóm truy cập máy trạm. Sau khi lựa chọn thao
tác phù hợp, yêu cầu được gửi tới Gateway để xử lý.

Gateway thực hiện trao đổi với Keycloak nhằm cập nhật thông tin tương ứng. Trong trường hợp
thao tác thành công, hệ thống cập nhật lại giao diện và hiển thị kết quả cho quản trị viên.
Nếu xảy ra lỗi trong quá trình xử lý hoặc kết nối tới Keycloak không thành công, hệ thống sẽ
hiển thị thông báo lỗi và yêu cầu quản trị viên thực hiện lại thao tác.

Thông qua quy trình này, toàn bộ việc quản lý danh tính và phân quyền được thực hiện tập
trung, giúp đơn giản hóa công tác quản trị và đảm bảo tính nhất quán của dữ liệu người dùng
trong toàn hệ thống.

---

## 2.3 Đặc tả chức năng

### 2.3.1 Đặc tả use case Đăng nhập qua Keycloak

| Tên ca sử dụng | Đăng nhập qua Keycloak | ID | UC-01 | Mức quan trọng | Cao |
|---|---|---|---|---|---|
| **Tác nhân chính** | Người dùng | **Loại** | Chi tiết, thiết yếu | | |
| **Mô tả ngắn gọn** | Người dùng đăng nhập thông qua Keycloak (Authorization Code Flow + OIDC) | | | | |
| **Loại sự kiện** | Ngoại | | | | |
| **Sự kiện kích hoạt** | Người dùng nhấn nút Đăng nhập trên giao diện | | | | |
| **Tiền điều kiện** | Người dùng có tài khoản hợp lệ trên Keycloak | | | | |
| **Hậu điều kiện** | Người dùng được xác thực và nhận Access Token (có claim `groups`) | | | | |

**Luồng sự kiện chính:**
1. Người dùng mở ứng dụng ROCKY
2. Người dùng chọn chức năng Đăng nhập
3. Hệ thống chuyển hướng tới trang đăng nhập Keycloak (mở trình duyệt hệ thống)
4. Người dùng nhập thông tin xác thực (username/password) hoặc lựa chọn đăng nhập bằng Google
   *(nếu đã cấu hình Identity Provider Google trên Keycloak)*
5. Keycloak kiểm tra thông tin đăng nhập
6. Keycloak xác thực thành công và cấp Access Token (chứa claim `groups`)
7. Hệ thống lưu token và chuyển sang giao diện Address Book
8. Hệ thống hiển thị danh sách máy trạm người dùng được phép truy cập
9. Người dùng bắt đầu sử dụng hệ thống

**Các luồng ngoại lệ:**

*4a. Thông tin đăng nhập không hợp lệ*
- Keycloak từ chối xác thực
- Hệ thống hiển thị thông báo lỗi
- Người dùng thực hiện đăng nhập lại

*5a. Máy chủ Keycloak không phản hồi*
- Hệ thống hiển thị thông báo lỗi kết nối
- Người dùng có thể thử lại sau

*6a. Token không hợp lệ*
- Hệ thống từ chối đăng nhập
- Người dùng phải thực hiện xác thực lại

---

### 2.3.2 Đặc tả use case Kết nối từ xa

| Tên ca sử dụng | Kết nối từ xa | ID | UC-02 | Mức quan trọng | Cao |
|---|---|---|---|---|---|
| **Tác nhân chính** | Người sử dụng | **Loại** | Chi tiết, thiết yếu | | |
| **Mô tả ngắn gọn** | Người dùng lựa chọn máy trạm được phép kết nối và nhập mật khẩu để tạo một remote desktop | | | | |
| **Sự kiện kích hoạt** | Người dùng nhấn/nhập máy trạm trên giao diện | | | | |
| **Tiền điều kiện** | Người dùng đã đăng nhập thành công | | | | |
| **Hậu điều kiện** | Phiên điều khiển từ xa được thiết lập | | | | |

**Luồng sự kiện chính:**
1. Người dùng mở Danh sách máy trạm (Address Book)
2. Hệ thống hiển thị danh sách máy trạm được phép truy cập
3. Người dùng chọn máy trạm cần kết nối
4. Hệ thống kiểm tra quyền truy cập (gọi `/api/check-access`)
5. Hệ thống khởi tạo kết nối RustDesk
6. Phiên điều khiển từ xa được thiết lập
7. Người dùng thao tác trên máy trạm từ xa
8. Người dùng đóng phiên kết nối

**Các luồng ngoại lệ:**

*3a. Người dùng chưa đăng nhập*
- Hệ thống hiển thị msgbox yêu cầu đăng nhập trước
- Luồng kết thúc, người dùng cần đăng nhập lại

*4a. Người dùng không có quyền truy cập máy*
- Gateway trả về `{ allowed: false, reason: "no_permission" }`
- Hệ thống hiển thị msgbox từ chối truy cập
- Kết nối không được thiết lập

*4b. Máy trạm ngoại tuyến*
- Hệ thống hiển thị trạng thái Offline
- Kết nối không được thiết lập

*4c. Lỗi mạng*
- Hệ thống hiển thị lỗi kết nối
- Người dùng có thể thực hiện lại thao tác

---

### 2.3.3 Quản lý danh sách người dùng

| Tên ca sử dụng | Quản lý người dùng | ID | UC-03 | Mức quan trọng | Cao |
|---|---|---|---|---|---|
| **Tác nhân chính** | Quản trị viên (`manage_users` hoặc `admin`) | **Loại** | Quan trọng, thiết yếu | | |
| **Mô tả ngắn gọn** | Quản trị viên quản lý tài khoản người dùng trong hệ thống, bao gồm vòng đời người dùng: tạo người dùng, xem danh sách người dùng, vô hiệu hóa người dùng, xóa người dùng, gán nhóm truy cập | | | | |
| **Sự kiện kích hoạt** | Quản trị viên chọn tab Quản lý người dùng trên giao diện hệ thống | | | | |
| **Tiền điều kiện** | Quản trị viên đã đăng nhập Web Admin UI | | | | |
| **Hậu điều kiện** | Thông tin người dùng được cập nhật trên Keycloak | | | | |

**Luồng sự kiện chính:**
1. Quản trị viên truy cập giao diện quản trị
2. Quản trị viên chọn chức năng "Người dùng"
3. Hệ thống hiển thị danh sách người dùng hiện có
4. Quản trị viên lựa chọn một thao tác quản lý
5. Hệ thống thực hiện thao tác tương ứng
6. Kết quả được lưu trên Keycloak
7. Hệ thống cập nhật giao diện

**Luồng con UC-03.1: Thêm người dùng**
1. Quản trị viên nhập họ tên, email, tên đăng nhập và mật khẩu
2. Quản trị viên nhấn nút "Thêm người dùng"
3. Hệ thống tạo tài khoản trên Keycloak

**Luồng con UC-03.2: Gán nhóm truy cập**
1. Quản trị viên chọn người dùng
2. Quản trị viên chọn chức năng "Gán nhóm"
3. Chọn nhóm (Keycloak Group) cần gán
4. Nhấn xác nhận
5. Hệ thống cập nhật tư cách thành viên nhóm trên Keycloak

**Luồng con UC-03.3: Vô hiệu hóa người dùng**
1. Quản trị viên chọn người dùng
2. Chọn chức năng "Vô hiệu hóa"
3. Xác nhận thao tác
4. Hệ thống vô hiệu hóa tài khoản (đặt `enabled=false` trên Keycloak)

**Luồng con UC-03.4: Xóa người dùng**
1. Quản trị viên chọn người dùng
2. Chọn chức năng "Xóa"
3. Xác nhận thao tác
4. Hệ thống xóa tài khoản khỏi Keycloak

**Các luồng ngoại lệ:**
- Dữ liệu nhập không hợp lệ
- Người dùng đã tồn tại (trùng username/email)
- Không thể kết nối Keycloak

---

### 2.3.4 Quản lý danh sách máy trạm

| Tên ca sử dụng | Quản lý danh sách máy trạm | ID | UC-04 | Mức quan trọng | Cao |
|---|---|---|---|---|---|
| **Tác nhân chính** | Quản trị viên (`manage_machines` hoặc `admin`) | **Loại** | Quan trọng, thiết yếu | | |
| **Mô tả ngắn gọn** | Quản trị viên quản lý danh sách các máy trạm trong hệ thống, bao gồm thêm/sửa/xóa máy trạm | | | | |
| **Sự kiện kích hoạt** | Quản trị viên chọn Quản lý máy trạm trên giao diện hệ thống | | | | |
| **Tiền điều kiện** | Quản trị viên đăng nhập Web Admin UI | | | | |
| **Hậu điều kiện** | Dữ liệu máy trạm được cập nhật trong hệ thống (SQLite) | | | | |

**Luồng sự kiện chính:**
1. Quản trị viên mở chức năng "Danh sách máy"
2. Hệ thống hiển thị danh sách máy trạm
3. Quản trị viên lựa chọn thao tác quản lý
4. Hệ thống cập nhật dữ liệu
5. Hệ thống hiển thị kết quả

**Luồng con UC-04.1: Thêm máy trạm**
1. Quản trị viên nhập tên máy trạm, RustDesk ID, ghi chú
2. Quản trị viên nhấn "thêm"
3. Hệ thống lưu thông tin máy trạm vào cơ sở dữ liệu

**Luồng con UC-04.2: Chỉnh sửa máy trạm**
1. Quản trị viên nhấn "sửa" máy trạm muốn sửa
2. Hệ thống hiển thị các thông số máy trạm
3. Quản trị viên thay đổi thông tin
4. Nhấn "Lưu"
5. Hệ thống lưu dữ liệu

**Luồng con UC-04.3: Xóa máy trạm**
1. Quản trị viên nhấn "xóa" máy trạm muốn xóa
2. Xác nhận thao tác
3. Hệ thống xóa máy khỏi dữ liệu quản lý và toàn bộ ánh xạ nhóm liên quan

**Các luồng ngoại lệ:**
- RustDesk ID không hợp lệ
- Máy đã tồn tại
- Lỗi kết nối hệ thống

---

### 2.3.5 Quản lý danh sách nhóm truy cập

| Tên ca sử dụng | Quản lý nhóm truy cập | ID | UC-05 | Mức quan trọng | Cao |
|---|---|---|---|---|---|
| **Tác nhân chính** | Quản trị viên (xem: `manage_users`/`manage_machines`; tạo/xóa nhóm: `admin` tối cao) | **Loại** | Quan trọng, thiết yếu | | |
| **Mô tả ngắn gọn** | Quản trị viên tạo và quản lý các nhóm truy cập (Keycloak Group) để phân quyền người dùng truy cập máy trạm | | | | |
| **Sự kiện kích hoạt** | Quản trị viên chọn Quản lý nhóm truy cập | | | | |
| **Tiền điều kiện** | Quản trị viên đã đăng nhập hệ thống | | | | |
| **Hậu điều kiện** | Nhóm và ánh xạ quyền truy cập được cập nhật | | | | |

**Luồng sự kiện chính:**
1. Quản trị viên chọn chức năng quản lý nhóm
2. Hệ thống hiển thị danh sách nhóm hiện có (kèm số user, số máy trong từng nhóm)
3. Quản trị viên lựa chọn thao tác quản lý
4. Hệ thống thực hiện cập nhật
5. Kết quả được lưu vào hệ thống

**Luồng con UC-05.1: Tạo nhóm** *(chỉ admin tối cao)*
1. Quản trị viên nhập tên nhóm
2. Quản trị viên nhấn "tạo nhóm"
3. Hệ thống tạo Keycloak Group mới trên realm

**Luồng con UC-05.2: Gán người dùng vào nhóm** *(`manage_users` hoặc `admin`)*
1. Quản trị viên chọn nhóm
2. Quản trị viên nhấn "thêm user"
3. Quản trị viên chọn user muốn thêm vào
4. Xác nhận

**Luồng con UC-05.3: Gán máy trạm vào nhóm** *(`manage_machines` hoặc `admin`)*
1. Quản trị viên chọn nhóm
2. Quản trị viên nhấn "thêm máy"
3. Quản trị viên chọn máy trạm muốn thêm vào
4. Xác nhận

**Luồng con UC-05.4: Xóa nhóm** *(chỉ admin tối cao)*
1. Quản trị viên chọn nhóm
2. Nhấn "xóa"
3. Xác nhận

**Các luồng ngoại lệ:**
- Tên nhóm đã tồn tại
- Không thể kết nối Keycloak

---

### 2.3.6 Quản lý phân quyền Admin UI

| Tên ca sử dụng | Quản lý phân quyền Admin | ID | UC-06 | Mức quan trọng | Cao |
|---|---|---|---|---|---|
| **Tác nhân chính** | Admin tối cao (`admin`) | **Loại** | Quan trọng, thiết yếu | | |
| **Mô tả ngắn gọn** | Admin tối cao gán hoặc thu hồi quyền quản trị Admin UI (`admin`/`manage_users`/`manage_machines`) cho các tài khoản | | | | |
| **Sự kiện kích hoạt** | Admin tối cao chọn thao tác gán/thu hồi quyền admin trên trang Quản lý người dùng | | | | |
| **Tiền điều kiện** | Admin tối cao đã đăng nhập (đã qua 2FA) | | | | |
| **Hậu điều kiện** | Quyền quản trị được cập nhật trên Keycloak client `rocky-admin` | | | | |

**Luồng sự kiện chính:**
1. Admin tối cao chọn người dùng trên giao diện
2. Chọn chức năng "Gán quyền admin" hoặc "Thu hồi quyền admin"
3. Chọn tier quyền (`admin`/`manage_users`/`manage_machines`)
4. Xác nhận
5. Hệ thống cập nhật client role trên Keycloak (`rocky-admin`)

**Các luồng ngoại lệ:**
- Không thể kết nối Keycloak
- Không đủ quyền (chỉ admin tối cao mới thực hiện được)

---

### 2.3.7 Xác thực 2 lớp (2FA) cho Admin tối cao

| Tên ca sử dụng | Xác thực 2 lớp | ID | UC-07 | Mức quan trọng | Cao |
|---|---|---|---|---|---|
| **Tác nhân chính** | Admin tối cao (`admin`) | **Loại** | Chi tiết, thiết yếu | | |
| **Mô tả ngắn gọn** | Admin tối cao bắt buộc phải xác thực thêm bằng mã OTP (TOTP) khi đăng nhập Admin UI | | | | |
| **Sự kiện kích hoạt** | Admin tối cao đăng nhập vào Web Admin UI | | | | |
| **Tiền điều kiện** | Tài khoản có role `admin` trên client `rocky-admin`; đã thiết lập authenticator TOTP | | | | |
| **Hậu điều kiện** | Admin tối cao được xác thực đầy đủ và truy cập được toàn bộ chức năng | | | | |

**Luồng sự kiện chính:**
1. Admin nhập username/password trên trang đăng nhập Admin UI
2. Keycloak yêu cầu nhập mã OTP (Authentication Flow `browser-admin-otp`)
3. Admin nhập mã 6 chữ số từ ứng dụng authenticator (Google Authenticator, Authy…)
4. Keycloak xác thực OTP thành công
5. Admin được cấp token và truy cập Admin UI

**Các luồng ngoại lệ:**
- Mã OTP sai/hết hạn: Keycloak từ chối, yêu cầu nhập lại
- Chưa thiết lập TOTP: Keycloak chuyển hướng màn hình đăng ký authenticator

---

## 2.4 Yêu cầu phi chức năng

Bên cạnh các yêu cầu chức năng, hệ thống ROCKY cần đáp ứng một số yêu cầu phi chức năng
nhằm đảm bảo khả năng vận hành ổn định, an toàn và đáp ứng nhu cầu triển khai trong môi
trường doanh nghiệp.

### 2.4.1 Yêu cầu bảo mật

Hệ thống phải đảm bảo chỉ những người dùng có quyền mới có thể truy cập vào các tài nguyên
tương ứng.

- Người dùng phải xác thực thông qua hệ thống trước khi sử dụng hệ thống.
- Người dùng chỉ được xem và kết nối tới các máy trạm thuộc nhóm (Keycloak Group) được cấp.
- Admin tối cao bắt buộc sử dụng xác thực 2 lớp (TOTP) khi đăng nhập Admin UI.
- JWT Access Token không được lưu trữ dưới dạng plaintext lâu dài; session kết thúc khi token
  hết hạn hoặc user đăng xuất.

### 2.4.2 Yêu cầu độ tin cậy

Hệ thống phải đảm bảo khả năng hoạt động ổn định và duy trì tính nhất quán của dữ liệu.

- Các thông tin về máy trạm, nhóm và phân quyền phải được lưu trữ và duy trì nhất quán.
- Sau mỗi lần thay đổi cấu hình, dữ liệu phải được cập nhật và lưu trữ ngay lập tức.
- Việc phân quyền mới phải có hiệu lực ngay sau khi được cập nhật.
- Hệ thống phải có khả năng tiếp tục hoạt động sau khi phát sinh lỗi tạm thời từ các thành
  phần phụ trợ.
- Các lỗi phát sinh trong quá trình hoạt động phải được ghi nhận để phục vụ công tác giám sát
  và khắc phục sự cố.

### 2.4.3 Yêu cầu khả năng sử dụng

Hệ thống phải cung cấp giao diện đơn giản, dễ sử dụng đối với cả người dùng thông thường và
quản trị viên.

- Danh sách máy trạm được hiển thị tự động dựa trên quyền truy cập của người dùng.
- Các chức năng quản trị được cung cấp thông qua giao diện Web Admin UI tập trung.

### 2.4.4 Yêu cầu khả năng bảo trì và mở rộng

Hệ thống phải hỗ trợ việc bảo trì và mở rộng trong tương lai.

- Kiến trúc Gateway tách biệt với ứng dụng ROCKY Client giúp thuận lợi cho việc nâng cấp và
  bảo trì.
- Có thể thay thế cơ chế lưu trữ dữ liệu hiện tại (SQLite) bằng cơ sở dữ liệu khác khi quy
  mô hệ thống tăng lên.

### 2.4.5 Yêu cầu công nghệ

Hệ thống được xây dựng dựa trên các công nghệ mã nguồn mở nhằm đảm bảo khả năng triển khai
linh hoạt và dễ dàng kiểm soát.

- Ứng dụng desktop được phát triển bằng ngôn ngữ Rust và Sciter UI.
- Gateway được phát triển bằng Node.js (chỉ dùng built-in modules: `http`, `fs`, `crypto`,
  `node:sqlite`; không có npm dependency).
- Keycloak được sử dụng làm hệ thống định danh và xác thực tập trung.
- **Dữ liệu cấu hình (máy trạm, ánh xạ nhóm–máy) được lưu trữ bằng SQLite** (`data/rocky.db`)
  thông qua module `node:sqlite` tích hợp sẵn của Node.js.
- Chức năng điều khiển từ xa được xây dựng trên nền tảng RustDesk.
- Keycloak được triển khai bằng Docker (`docker run`). Gateway (`node server.js`) và RustDesk
  rendezvous/relay server chạy trực tiếp trên host; Docker Compose toàn hệ thống là tính năng
  dự kiến cho phiên bản tiếp theo.
