Chương 4 đã trình bày chi tiết quá trình phân tích, thiết kế, triển khai
và đánh giá hệ thống ROCKY, bao gồm kiến trúc tổng thể, thiết kế giao
diện, biểu đồ tuần tự cho các luồng xác thực và truy vấn Address Book,
cũng như kết quả kiểm thử trên các kịch bản khác nhau. Dựa trên nền tảng
đó, Chương 5 này tập trung làm rõ tám giải pháp và đóng góp nổi bật nhất
của đồ án. Đây là những nội dung cốt lõi tạo nên sự khác biệt của hệ
thống ROCKY so với RustDesk bản gốc, đồng thời giải quyết các bài toán
thực tế mà các tổ chức gặp phải khi triển khai giải pháp remote desktop
mã nguồn mở. Mỗi giải pháp được trình bày theo cấu trúc ba phần chính:
(i) bài toán/vấn đề đặt ra, (ii) giải pháp đã triển khai, (iii) kết quả
đạt được.

# Gỉai pháp tích hợp Keycloak vào mã nguồn Rust (giao diện Sciter)

## Bài toán

Khi tích hợp xác thực Keycloak vào hệ thống ROCKY, thách thức kỹ thuật
đầu tiên và khó nhất không phải là bản thân giao thức OIDC, mà là câu
hỏi: làm thế nào để một ứng dụng desktop native có thể tham gia vào
Authorization Code Flow - một luồng vốn được thiết kế cho trình duyệt
web? Authorization Code Flow theo chuẩn OIDC yêu câu hai khả năng mà ứng
dụng desktop thông thường không có sẵn. Thứ nhất, ứng dụng phải có thể
mở một trang web (trang đăng nhập Keycloak) và sau đó nhận lại kết quả
từ trang đó thông qua một redirect URI. Đối với ứng dụng web, điều này
tự nhiên: trình duyệt redirect về URL của chính ứng dụng. Đối với ứng
dụng desktop, không có URI nào để redirect về URL của chính ứng dụng.
Thứ hai, ứng dụng phải có thể lắng nghe callback URI - tức là phải có
một HTTP server đang chạy sẵn, hoặc phải đăng ký custom URI scheme với
hệ điều hành.

RustDesk (phiên bản Sciter) không có WebView nhúng - Sciter chỉ là
engine đồ họa render HTML/CSS, không phải trình duyệt đầy đủ và không
thể điều hướng đến URI bên ngoài. Với Sciter, mọi cơ chế tương tác với
web đều phải thông qua hàm handler.open_url() ­ hàm này chỉ mở trình
duyệt hệ thống với URL cho trước và không cung cấp bất kỳ cơ chế nào để
nhận kết quả trả về.

## Giải pháp

Đồ án giải quyết bài toán bằng mô hình lai kết hợp trình duyệt hệ thống
và gateway đóng vai trò callback receive, thay vì cố gắng nhúng Webview
hay đăng ký custom URL scheme.

1.  **Bước 1 ­ Gateway đảm nhận vai trò callback receiver**: thay vì
    ROCKY client lắng nghe callback URL toàn bộ OIDC flow được ủy quyền
    cho gateway Node.js. Redirect URI đăng ký với keycloak là
    http://127.0.0.1:3000/api/auth/callback ­ callback trả về gateway,
    không phải client. Gateway là HTTP server đang chạy sẵn, có đủ năng
    lực nhận request, xử lý authorization code và trao đổi lấy token.

2.  **Bước 2 ­ Phân tách luồng thành hai giai đoạn**: Luồng được chia
    thành hai giai đoạn không đồng bộ, kết nối qua server­side session.
    Giai đoạn 1: ROCKY client gọi POST api/auth/init, gateway sinh OAuth
    state ngẫu nhiên và lưu vào sesion, trả về authorize URL. Client
    dùng handler.open_url() mở URL trong trình duyệt hệ thống. Giai đoạn
    2: người dùng đăng nhập trên trình duyệt, Keycloak redirect về GET
    /api/auth/callback trên gateway, gateway xác thực state, trao đổi
    code lấy token và lưu vào session.

3.  **Bước 3 ­ Polling cầu nối hai giai đoạn**: Endpoint POST
    /api/auth/status cho phép client polling định kỳ. Khi callback hoàn
    tất và token đã được lưu vào session, lần polling tiếp theo trả về
    token cho client. Cơ chế này giải quyết hoàn toàn bài toán giao tiếp
    giữa trình duyệt và ứng dụng desktop mà không cần bất kỳ cơ chế liên
    tiến trình nào.

Điểm quan trọng: toàn bộ logic xác thực nằm ở gateway. ROCKY client chỉ
đóng vai trò orchestrator đơn giản -- gọi init, mở browser, polling
status, nhận token -- giữ cho phần mã TIScript tối giản và dễ bảo trì.

*Biểu đồ luồng OIDC lai - trình duyệt hệ thống + gateway callback
receiver*

## Kết quả đạt được

Giải pháp tích hợp OIDC vào RustDesk/Sciter mà không cần sửa đổi bất kỳ
thành phần lõi nào của RustDesk. Toàn bộ thay đổi phía client chỉ nằm
trong tệp TIScript ( 250 dòng), không có thay đổi nào ở phần Rust
backend. Mô hình này cũng có tính tổng quát: có thể áp dụng cho bất kỳ
ứng dụng desktop nào không có WebView mà cần tích hợp OAuth/OIDC, miễn
là ứng dụng có thể mở trình duyệt và có một gateway HTTP đang chạy cục
bộ.

# Cơ chế polling bất đồng bộ phát hiện hoàn tất xác thực

## Bài toán

Khi luồng xác thực được phân tách thành hai giai đoạn không đồng bộ (mục
5.1), phát sinh bài toán: làm thế nào để ROCKY client biết chính xác khi
nào người dùng hoàn thành đăng nhập trên trình duyệt và token đã sẵn
sàng? Câu hỏi này có nhiều ràng buộc kỹ thuật phức tạp.

TIScript chạy trên single-thread UI loop -- không thể tạo thread riêng
để chờ, không thể block UI loop vì giao diện sẽ đóng băng. Rust có thể
gọi hàm TIScript qua Element::call_method(), nhưng chỉ khi có sự kiện
kích hoạt từ phía Rust trước. Ngoài ra, người dùng có thể đóng trình
duyệt mà không hoàn thành đăng nhập, hoặc mất nhiều phút để nhập thông
tin; cần xử lý cả hai trường hợp.

## Giải pháp

Đồ án thiết kế cơ chế polling bất đồng bộ có trạng thái (stateful async
polling) trong TIScript, mô phỏng async/await bằng chuỗi callback có
kiểm soát. Khi loginWithKeycloak() được gọi, biến \_pollingActive = true
và bộ đếm \_pollCount = 0 được khởi tạo. Hàm pollKeycloakAuth() được gọi
lần đầu; nếu chưa có token, nó lên lịch gọi lại chính mình sau 2 giây
bằng self.timer(2000, fn). Mỗi lần gọi kiểm tra ba điều kiện dừng: (1)
\_pollingActive == false (người dùng nhấn Hủy), (2) nhận được token
(thành công), (3) \_pollCount \> 60 (timeout sau 2 phút). Khi token
nhận được, TIScript lưu token vào biến cục bộ, gọi ngay
getAddressBooks(), đồng thời gọi view.xcall('saveToken', token) để Rust
backend lưu token bền vững bằng handler.set_local_option(). Nút 'Hủy'
đặt \_pollingActive = false và clear timer, đưa UI về trạng thái ban đầu
tức thì.

Ở phía gateway, mỗi session polling còn được gắn thêm thời điểm tạo và
được dọn định kỳ (sweepStaleSessions()) nếu quá 10 phút không hoàn tất,
để không rò bộ nhớ khi người dùng bỏ ngang luồng đăng nhập giữa lúc
redirect Keycloak.

## Kết quả đạt được

Cơ chế polling đạt độ trễ phát hiện token trung bình dưới 2 giây. Giao
diện hoàn toàn responsive trong suốt quá trình chờ. Trường hợp timeout
và hủy bỏ đều được xử lý đúng, không để lại timer orphan hay memory
leak. Nếu người dùng mất kết nối mạng giữa chừng, polling tự phục hồi
khi kết nối trở lại, thay vì báo lỗi ngay lập tức.

# Mô hình phân quyền hai tầng độc lập: Keycloak Group cho Address Book và 3-tier role cho Admin UI

## Bài toán

Sau khi tích hợp xác thực tập trung, câu hỏi tiếp theo là: làm thế nào
để mỗi người dùng sau khi đăng nhập chỉ thấy đúng những máy trạm họ được
phép điều khiển, và đồng thời làm thế nào để nhiều nhân viên IT có thể
cùng vận hành trang quản trị mà không phải ai đăng nhập được cũng có
toàn quyền? Thiết kế ban đầu gộp chung cả hai mục đích này vào một cơ
chế duy nhất -- Keycloak client role trên một client (rustdesk-client),
với ba giá trị admin/viewer/guest.

Cách gộp này bộc lộ hai hạn chế khi đồ án mở rộng quy mô. Thứ nhất,
client role của Keycloak gắn cố cứng với một client OAuth2 cụ thể,
không phù hợp để biểu diễn các nhóm/phòng ban độc lập với việc ai được
vào trang quản trị -- mỗi khi cần thêm một nhóm máy mới lại phải tạo
thêm một role mới trên đúng client đó. Thứ hai, một role admin duy nhất
gánh hết các quyền quản trị (CRUD người dùng, CRUD máy, cấu hình ánh xạ)
vi phạm nguyên tắc least-privilege khi tổ chức cần nhiều người vận hành
trang quản trị nhưng ở các mức trách nhiệm khác nhau.

## Giải pháp

Đồ án tách bài toán thành hai hệ phân quyền độc lập, dùng chung một
Keycloak realm nhưng không chia sẻ dữ liệu cho nhau:

1.  **Phân quyền máy trạm (Address Book) theo Keycloak Group**: chuyển
    từ client role sang Keycloak Group ở mức realm. Gateway đọc claim
    "groups" trong access token (qua protocol mapper "Group Membership"
    gắn trên rustdesk-client), tra cứu tập hợp máy tương ứng trong bảng
    machine_groups của SQLite. Group là khái niệm realm-level của
    Keycloak -- không gắn với một client cụ thể, nên việc thêm một
    nhóm/phòng ban mới chỉ cần tạo Group mới và gán user/máy vào, không
    đụng đến cấu hình client OAuth2 nào.

2.  **Phân quyền trang quản trị theo 3 client role trên client riêng
    rocky-admin**: admin (admin tối cao -- toàn quyền, đồng thời là cấp
    duy nhất được tạo/xoá Group và duy nhất được gán/gỡ 3 role
    admin-tier này cho người khác), manage_users (CRUD người dùng + gán
    user vào Group), manage_machines (CRUD máy trạm + gán máy vào
    Group). Hàm requireAdminAuth(req, res, allowedRoles) gate quyền
    theo từng route /admin/api/* (thay vì một kiểm tra toàn cục duy
    nhất ở đầu), và requireSuperAdmin(req, res) riêng cho các route chỉ
    admin tối cao mới được gọi.

3.  **Ranh giới quyền giữa các tier** được xác định rõ trước khi triển
    khai: việc gán máy↔Group thuộc về manage_machines (không phải đặc
    quyền riêng của admin tối cao); manage_users không được gán role
    admin-tier cho bất kỳ ai (tránh nguy cơ leo thang quyền -- chỉ admin
    tối cao mới gán được); tạo/xoá Group là độc quyền admin tối cao.

Hai hệ phân quyền này hoàn toàn tách biệt về dữ liệu: một người dùng có
thể vừa thuộc Group "phòng kế toán" (machine-access) vừa có role
manage_machines (Admin UI), hai việc không ảnh hưởng nhau và được đọc từ
hai nơi khác nhau trong token/Keycloak Admin API.

## Kết quả

Việc thêm một nhóm/phòng ban máy mới chỉ cần tạo một Keycloak Group và
gán user/máy vào, không cần sửa cấu hình client hay code gateway. Thu
hồi quyền truy cập máy của một người dùng chỉ cần gỡ họ khỏi Group trên
Keycloak. Token xác thực được ký bằng khóa bí mật của Keycloak nên
không thể giả mạo. Đồng thời, trang quản trị có thể được vận hành bởi
nhiều nhân viên IT ở các mức trách nhiệm khác nhau mà không ai trong số
họ (trừ admin tối cao) có thể tự cấp thêm quyền cho mình hoặc cho người
khác. Hạn chế còn ghi nhận trung thực: cơ chế 2FA (mục dưới) hiện chỉ
bắt buộc với riêng role admin, chưa mở rộng cho manage_users/
manage_machines sau khi tách thành 3 tier -- đây là một gap đã được ghi
nhận, dành cho phần hướng phát triển.

# Quản lý vòng đời người dùng toàn diện qua Keycloak Admin REST API

## Bài toán

RustDesk bản gốc không có khái niệm tài khoản người dùng -- mọi máy đều
có thể kết nối nếu biết mã định danh và mật khẩu. Khi đưa Keycloak vào
làm hệ thống quản lý danh tính trung tâm, một bài toán mới xuất hiện:
quản trị viên cần có khả năng quản lý toàn bộ vòng đời của người dùng
trong tổ chức -- từ khi nhân viên gia nhập đến khi rời đi -- mà không
phải thao tác thủ công trên giao diện Keycloak vốn phức tạp và không
thân thiện với người dùng phổ thông. Vòng đời một người dùng trong hệ
thống điều khiển từ xa bao gồm nhiều sự kiện quan trọng: được cấp tài
khoản khi gia nhập, được giao quyền truy cập vào nhóm máy phù hợp với
vai trò, cần được điều chỉnh quyền khi chuyển bộ phận, cần bị tạm khóa
nhanh chóng khi có sự cố bảo mật, và cần xóa sạch dấu vết khi rời tổ
chức. Mỗi bước đều cần được thực hiện kịp thời và đúng đắn để đảm bảo an
toàn thông tin.

## Giải pháp

Đồ án xây dựng một lớp REST API trên gateway (server.js) đóng vai trò
trung gian giữa trang quản trị web và Keycloak Admin REST API, sử dụng
một service account riêng để thực hiện mọi lệnh gọi quản trị thay cho
từng quản trị viên -- quản trị viên không cần và không bao giờ thấy
thông tin đăng nhập kỹ thuật của service account đó. Mỗi sự kiện trong
vòng đời người dùng được ánh xạ thành một thao tác trên giao diện web
đơn giản: tạo tài khoản, gán/thu hồi quyền truy cập máy theo Group, điều
chỉnh quyền quản trị bằng gán/gỡ role admin-tier (chỉ admin tối cao thực
hiện được), tạm khóa khẩn cấp bằng một nút bật/tắt, và xóa tài khoản.
Bản cập nhật gần nhất còn gộp luôn bước gán Group/role admin-tier vào
ngay form tạo người dùng, để toàn bộ quy trình "tạo tài khoản mới và cấp
quyền tương ứng" thực hiện trong một lượt thay vì phải tạo xong rồi mở
riêng từng dialog gán quyền như trước.

## Kết quả đạt được

Quản trị viên có thể thực hiện toàn bộ vòng đời người dùng từ một giao
diện web quen thuộc, không cần tiếp cận Keycloak Admin Console. Thời
gian thực hiện mỗi thao tác giảm đáng kể so với làm thủ công trực tiếp
trên Keycloak, đặc biệt với thao tác tạo người dùng kèm cấp quyền nay
gộp được vào một lượt submit. Quan trọng hơn, các thao tác nhạy cảm như
khóa tài khoản khẩn cấp có thể được thực hiện ngay lập tức bởi quản trị
viên mà không cần kiến thức sâu về Keycloak, giảm nguy cơ chậm trễ trong
xử lý sự cố bảo mật.

# Đăng nhập bằng Google qua Keycloak Identity Provider và 2FA bắt buộc cho admin tối cao

## Bài toán

Hai vấn đề thực tế phát sinh khi vận hành xác thực tập trung qua
Keycloak. Thứ nhất, yêu cầu người dùng tạo và nhớ thêm một tài khoản
Keycloak riêng -- tách biệt với tài khoản Google Workspace/Gmail mà họ
đã dùng hàng ngày -- làm tăng ma sát khi onboarding và dễ dẫn đến thói
quen đặt mật khẩu yếu hoặc dùng lại mật khẩu cũ. Thứ hai, tài khoản
admin tối cao có toàn quyền trên cả hệ thống (quản lý người dùng, máy
trạm, phân quyền), nên chỉ bảo vệ bằng một lớp mật khẩu là không đủ --
cần thêm một lớp xác thực nữa dành riêng cho cấp quyền cao nhất này.

## Giải pháp

1.  **Đăng nhập bằng Google**: cấu hình Google làm một Identity Provider
    trên Keycloak (Client ID/Secret lấy từ Google Cloud Console). Vì
    toàn bộ luồng đăng nhập của ROCKY (cả Admin UI và client desktop)
    đều redirect người dùng tới trang đăng nhập do Keycloak host, nút
    "Đăng nhập bằng Google" xuất hiện tự động trên trang đó ngay sau khi
    cấu hình xong trên Keycloak -- không cần sửa code ở gateway
    (server.js) hay giao diện Sciter. Người dùng có thể chọn đăng nhập
    bằng Google hoặc bằng tài khoản Keycloak gốc, tuỳ nhu cầu.

2.  **2FA (TOTP) bắt buộc riêng cho role admin tối cao**: cấu hình một
    Authentication Flow tùy biến trên Keycloak (browser-admin-otp),
    nhân bản từ flow Browser gốc, với điều kiện rẽ nhánh là vai trò của
    người dùng (role = rocky-admin.admin) thay vì điều kiện mặc định
    "đã từng cấu hình OTP" -- lựa chọn này tránh được trường hợp một
    admin tối cao mới tạo, chưa từng đăng ký OTP, lại được bỏ qua bước
    xác thực hai lớp. Flow này chỉ gán riêng cho client rocky-admin,
    không ảnh hưởng đến luồng đăng nhập của client desktop.

## Kết quả đạt được

Người dùng có thể đăng nhập bằng tài khoản Google sẵn có, không cần tạo
và nhớ thêm mật khẩu riêng cho hệ thống, giảm ma sát khi onboarding mà
vẫn giữ song song lựa chọn đăng nhập bằng tài khoản Keycloak gốc cho
người không dùng Google. Trang quản trị web có thêm một lớp bảo vệ 2FA
cho tài khoản có quyền cao nhất mà không cần triển khai thêm hạ tầng gửi
SMS hay email -- toàn bộ dựa trên TOTP có sẵn trong Keycloak. Hạn chế
còn tồn đọng, được ghi nhận trung thực để phục vụ hướng phát triển: 2FA
hiện chỉ bắt buộc với role admin, hai role manage_users/manage_machines
-- vốn cũng có quyền quản trị thật -- vẫn đăng nhập được mà không bị yêu
cầu OTP.

# Đồng bộ nhận diện thương hiệu xuyên suốt ba nền tảng kỹ thuật

## Bài toán

Hệ thống ROCKY bao gồm ba thành phần giao diện người dùng được xây dựng trên ba nền tảng kỹ thuật hoàn toàn khác nhau: Rocky Client dùng engine Sciter để render HTML/CSS với cú pháp CSS không chuẩn; Admin UI là trang web HTML/CSS chạy trên trình duyệt; trang đăng nhập Keycloak dựa trên FreeMarker template và PatternFly CSS framework. Người dùng di chuyển qua cả ba trong một luồng làm việc điển hình -- nhân viên thông thường: mở Rocky Client → redirect sang trang đăng nhập Keycloak → xác thực thành công quay lại client; quản trị viên: mở Admin UI → redirect sang Keycloak → vào trang quản trị. Nếu màu sắc, logo và tổng thể thị giác khác nhau giữa các bước, người dùng cảm nhận mình đang dùng ba sản phẩm riêng biệt thay vì một hệ thống duy nhất.

Thách thức có hai lớp. Lớp thứ nhất là kỹ thuật: mỗi nền tảng có cơ chế styling hoàn toàn khác nhau và không tương thích nhau. Sciter không hỗ trợ CSS custom properties theo chuẩn trình duyệt -- không có `:root { --var }` hay `var(--var)` -- mà phải khai báo qua cú pháp độc quyền `var(name): value` bên trong block `html {}` và đọc lại bằng `color(name)` trong file CSS. Đặc biệt, `color(name)` chỉ dùng được trong CSS thật; bên trong chuỗi TIScript hay thuộc tính SVG inline phải dùng hex literal trực tiếp. Admin UI chạy trên trình duyệt thật nên dùng CSS custom properties chuẩn trong `:root`. Keycloak dùng FreeMarker template và PatternFly CSS, phải override bằng theme con chứ không được sửa thẳng vào theme built-in -- nếu sửa trực tiếp, mỗi lần upgrade Keycloak lên version mới sẽ ghi đè hoặc xung đột toàn bộ thay đổi. Lớp thứ hai là bảo trì: nếu không có một bảng màu chung làm nguồn sự thật, mỗi lần điều chỉnh màu thương hiệu phải sửa ba nơi bằng ba cú pháp khác nhau, dễ xảy ra lệch màu tích lũy qua các lần chỉnh sửa sau này.

## Giải pháp

Đồ án thiết lập một bảng màu thương hiệu duy nhất (palette navy/teal) làm nguồn sự thật, sau đó ánh xạ từng token màu sang cú pháp tương ứng của từng nền tảng:

| Token | Giá trị | Vai trò |
|---|---|---|
| accent | `#00D2D3` | teal chính -- logo, chữ ROCKY, spinner, accent dialog login |
| button | `#58D0F8` | xanh nhạt -- icon highlight, nút và điểm nhấn phụ |
| dark (navy) | `#111D43` | nền navy đậm -- gradient banner |
| text | `#16234F` | chữ chính |
| light-text | `#5C6F94` | chữ phụ/label |
| border | `#D7E3F3` | viền input/divider |

**Rocky Client (Sciter)**: toàn bộ bảng màu khai báo trong block `html { ... }` của `src/ui/common.css` theo cú pháp Sciter (`var(name): value`). Các file CSS khác đọc bằng `color(name)`. Những nơi không thể dùng `color(name)` -- fill SVG inline trong TIS, chuỗi JS bên trong TIScript -- dùng hex literal tương ứng từ bảng trên: màu accent cho dialog login (`msgbox.tis`), fill icon recording và icon máy tính (`header.tis`, `file_transfer.tis`), màu spinner loading Address Book (`ab.tis`), và nền banner popup About (`index.tis` -- dùng `linear-gradient(left,#111D43,#00D2D3)` thay vì màu đặc vì màu button quá nhạt để làm nền chữ trắng).

**Admin UI (trình duyệt)**: bảng màu khai báo trong `:root { ... }` của `public/admin.html` bằng CSS custom properties chuẩn (`--accent`, `--text`, `--border`...). Giá trị đồng bộ với bảng token trên, nhưng Admin UI chọn nền sáng (`--bg: #F7FAFF`) thay vì navy đậm -- sau phản hồi thực tế về khả năng đọc khi theo dõi bảng dữ liệu dài trên nền tối. Sự khác biệt có chủ đích này được ghi nhận rõ trong tài liệu để tránh nhầm lẫn khi bảo trì.

**Trang đăng nhập Keycloak**: đồ án tạo một theme con tên `rocky` kế thừa theme `keycloak` built-in qua cơ chế chuẩn (`theme.properties`: `parent=keycloak`). Nguyên tắc áp dụng là chỉ override đúng phần cần đổi -- `template.ftl` chỉ sửa khối `#kc-header` để thay logo, tiêu đề và tagline; toàn bộ layout, form đăng nhập và xử lý lỗi vẫn kế thừa nguyên bản từ theme cha. Bảng màu khai báo trong `:root { ... }` ở đầu `rocky.css` bằng CSS variables chuẩn (`--rocky-teal: #01D2D3`, `--rocky-dot: #58D0F8`...), đồng bộ với bảng token trên. File này được nạp sau `login.css` của PatternFly trong danh sách `styles` để thắng các selector trùng mà không cần copy lại toàn bộ CSS gốc. Logo lục giác nhúng qua thẻ `<img>` trong `template.ftl`. Theme được gán per-realm (`Realm Settings → Theme → Login theme = rocky`), không ảnh hưởng các realm khác dùng theme mặc định. Một điểm kỹ thuật phát sinh trong quá trình triển khai: label tiếng Việt phải đặt trong `messages_en.properties` thay vì `messages_vi.properties`, vì khi realm chưa bật Internationalization locale luôn resolve về `en` -- `messages_vi.properties` bị Keycloak bỏ qua hoàn toàn dù file tồn tại. Đưa bản dịch thẳng vào `messages_en.properties` đảm bảo hiển thị đúng bất kể cấu hình i18n của realm.

Ba thành phần dùng chung hex code từ cùng một bảng màu thương hiệu, nhưng mỗi thành phần khai báo theo cú pháp của nền tảng mình -- không thành phần nào phải dùng cú pháp của thành phần khác. Đây là điểm mấu chốt: mỗi thành phần tiếp tục tuân thủ quy tắc của nền tảng riêng trong khi vẫn cho ra màu sắc đồng nhất từ góc nhìn người dùng.

## Kết quả đạt được

Người dùng trải qua một luồng thị giác liền mạch: logo lục giác sáu chấm, màu teal/cyan làm màu nhấn, và tone navy xuất hiện nhất quán từ màn hình Rocky Client, qua trang đăng nhập Keycloak, đến Admin UI -- không còn điểm đứt gãy thương hiệu khi chuyển qua lại giữa các thành phần. Vì toàn bộ thay đổi Keycloak đi qua cơ chế kế thừa theme chuẩn, việc upgrade Keycloak lên version mới không làm mất branding hay phát sinh xung đột file. Về mặt bảo trì, cấu trúc token hoá màu sắc -- một bảng màu duy nhất ánh xạ sang ba cú pháp tương ứng -- đảm bảo rằng nếu cần điều chỉnh màu trong tương lai, người phát triển chỉ cần xác định đúng token và cập nhật tại ba file khai báo (`common.css`, `admin.html`, `rocky.css`), thay vì tìm kiếm hex literal rải rác trong toàn bộ codebase. Hạn chế còn ghi nhận trung thực: Admin UI chủ ý dùng nền sáng thay vì navy để đảm bảo khả năng đọc bảng dữ liệu -- đây là sự khác biệt có chủ đích, được chấp nhận; tiêu đề và tagline trong Keycloak theme hiện đang hardcode cho một thương hiệu duy nhất, nên nếu sau này cần branding riêng cho realm thứ hai sẽ phải copy nguyên thư mục theme thay vì tham số hoá -- đánh đổi được chấp nhận vì hệ thống hiện chỉ vận hành một thương hiệu.

# Tùy biến mã nguồn mở RustDesk bảo toàn khả năng cập nhật lâu dài

## Bài toán

Xây dựng ROCKY trên nền mã nguồn mở RustDesk mang lại lợi thế lớn về
thời gian và chất lượng kỹ thuật, nhưng đặt ra bài toán bảo trì dài hạn:
nếu sửa đổi tràn lan vào mã nguồn gốc để thay logo, màu sắc, và tên ứng
dụng, việc tích hợp bản vá bảo mật từ RustDesk trong tương lai sẽ trở
nên cực kỳ khó khăn. Diff giữa ROCKY và RustDesk phải được giữ nhỏ và có
tổ chức.

## Giải pháp

Đồ án áp dụng nguyên tắc tập trung hóa điểm can thiệp: thay vì sửa đổi
phân tán, toàn bộ tùy biến được dẫn về số lượng tối thiểu các vị trí
chiến lược. Tên ứng dụng được định nghĩa tại một điểm duy nhất trong
file cấu hình, và toàn bộ giao diện đọc từ đó. Màu sắc thương hiệu được
khai báo dưới dạng biến CSS tập trung, cho phép thay đổi toàn bộ giao
diện bằng cách sửa bốn dòng. Tính năng Keycloak được bổ sung hoàn toàn
vào các file giao diện hiện có mà không sửa đổi bất kỳ hàm nào đã tồn
tại. Các thành phần hoàn toàn mới -- gateway và giao diện quản trị -- là
file riêng biệt, không tạo phụ thuộc vào mã nguồn gốc của RustDesk.

## Kết quả đạt được

Tổng số file bị sửa đổi so với bản gốc RustDesk là rất nhỏ và có tổ chức
rõ ràng. Khi RustDesk phát hành bản vá mới, phần lớn mã lõi (Rust
backend, network layer) có thể merge mà không có xung đột. Phần giao
diện tùy biến được tách biệt hoàn toàn nên dễ dàng xác định và giải
quyết xung đột nếu có. Mô hình này có thể tái sử dụng như một hướng dẫn
thực hành tốt cho bất kỳ tổ chức nào muốn xây dựng phiên bản branded của
RustDesk.

# Làm chủ toàn bộ chuỗi build – modify – đóng gói mã nguồn RustDesk đa nền tảng

## Bài toán

Xây dựng ROCKY trên nền mã nguồn mở RustDesk đòi hỏi nhiều hơn việc đọc
hiểu kiến trúc -- nhóm phát triển phải thực sự làm chủ được toàn bộ chuỗi
từ biên dịch mã nguồn, sửa đổi nội dung giao diện, đến xuất ra gói cài đặt
chạy được trên từng hệ điều hành. Đây là bài toán kỹ thuật không tầm thường:
RustDesk kết hợp Rust (backend, capture, codec), TIScript/HTML/CSS (giao diện
Sciter), Python (script đóng gói), vcpkg (quản lý thư viện native C/C++), và
GitHub Actions (CI/CD) thành một hệ thống build đa tầng, trong đó mỗi tầng
có thể thất bại im lặng nếu một dependency bị thiếu hoặc phiên bản không khớp.

Cụ thể, các bẫy kỹ thuật không được tài liệu chính thức ghi rõ bao gồm:
phiên bản Rust bị ràng buộc cứng không vượt quá 1.77 (Rust 1.78 trở lên thay
đổi ABI layout của kiểu i128 làm vỡ liên kết với crate sciter-rs đang dùng
phiên bản cố định); vcpkg phải dùng đúng triplet x64-windows-static (không
có hậu tố -md) vì build script libs/scrap/build.rs hardcode triplet này khi
dò tìm thư viện trên Windows; script đóng gói build.py chứa nhiều lỗi đường
dẫn (tham chiếu sai thư mục DEBIAN/, pam.d/, resources/) khiến giai đoạn
packaging thất bại ngay cả khi bước biên dịch đã thành công; file
res/inline-sciter.py -- dùng để nhúng toàn bộ giao diện TIS/HTML/CSS vào
binary trên Windows -- không khai báo encoding UTF-8 khi mở file, gây
UnicodeDecodeError ngay khi gặp văn bản tiếng Việt trong giao diện tùy biến
của ROCKY.

## Giải pháp

Nhóm đã phân tích toàn bộ pipeline build từ đầu đến cuối, ghi nhận từng
điểm thất bại, tìm nguyên nhân gốc, và triển khai sửa chữa theo nguyên tắc
can thiệp tối thiểu -- chỉ đụng đúng chỗ gây lỗi, không refactor hay tái
cấu trúc code không liên quan.

**Phía build Rust và dependency native**: Ghim phiên bản Rust tại 1.75.0 trong
file rust-toolchain.toml và trong GitHub Actions workflow để mọi môi trường
(máy phát triển, CI/CD) dùng cùng toolchain. Cài đặt LLVM/Clang 15.0.6 phục
vụ bindgen. Cấu hình vcpkg ở chế độ manifest (đọc vcpkg.json ở thư mục gốc)
với triplet x64-windows-static cho Windows và x64-linux cho Linux; thiết lập
biến môi trường VCPKG_ROOT đúng thứ tự trước khi gọi cargo build.

**Phía script đóng gói**: Sửa build.py tại ba điểm lỗi đường dẫn (DEBIAN/,
pam.d/, resources/), đảm bảo thư mục resources/ luôn được tạo ngay cả khi
không có cờ --feature nào được truyền vào, và điều chỉnh lại logic tìm
rustdesk-portable-packer (luôn build vào workspace-root target/release/, không
phải vào resources/). Sửa res/inline-sciter.py để mở tất cả file src/ui/*
với encoding='utf-8' tường minh, giải quyết toàn bộ UnicodeDecodeError trên
Windows runner.

**Phía CI/CD đa nền tảng**: Xây dựng ba job trong .github/workflows/build.yml
cho Windows (self-extracting .exe), Linux (.deb và .AppImage), và macOS (.dmg).
Job macOS là hoàn toàn mới -- upstream RustDesk không có CI job nào build
Sciter client cho macOS (chỉ có Flutter macOS), nên toàn bộ job được xây dựng
dựa trên nhánh osx/non-flutter có sẵn trong build.py nhưng chưa từng được
CI kích hoạt. Mỗi job đều bao gồm bước tải Sciter runtime (libsciter-gtk.so
trên Linux, libsciter.dylib trên macOS, sciter.dll trên Windows) từ repository
c-smile/sciter-sdk vào thư mục gốc ngay trước khi build, vì các file runtime
này không được vendor trong mã nguồn RustDesk.

**Quy trình modify giao diện**: Mỗi khi sửa file CSS/TIS trong src/ui/, chạy
lại python3 res/inline-sciter.py để tái tạo src/ui/inline.rs -- file này nhúng
toàn bộ tài nguyên giao diện vào binary dưới dạng byte array, cần thiết cho
build Windows có feature inline. Quy trình này được ghi thành tài liệu rõ
ràng để tránh trình trạng chỉnh CSS nhưng quên re-inline, khiến giao diện
trong binary và trong thư mục src/ui/ bị lệch nhau.

## Kết quả đạt được

Pipeline CI/CD hoạt động ổn định trên cả ba nền tảng: Windows xuất
rustdesk-{version}-win7-install.exe tại thư mục gốc repo, Linux xuất .deb
và .AppImage, macOS xuất .dmg -- tất cả đều là artifact có thể tải trực tiếp
từ GitHub Actions mà không cần can thiệp thủ công. Nhóm có khả năng thực
hiện đầy đủ vòng lặp sửa đổi giao diện (edit TIS/CSS → re-inline → build →
kiểm tra) ngay trên máy phát triển mà không phụ thuộc vào CI. Toàn bộ
nguyên nhân gốc của từng lỗi build được ghi lại trong docs/ci-windows-build.md
và docs/ci-linux-macos-build.md, tạo thành tài liệu tham khảo cho người tiếp
quản dự án sau này -- một điều kiện tiên quyết để bảo đảm tính bền vững lâu
dài của ROCKY.

Tóm lại, tám đóng góp trong chương này hình thành một hệ thống mạch lạc
và có chiều sâu kỹ thuật. Từ việc giải quyết bài toán tích hợp xác thực
vào môi trường desktop phi trình duyệt, xây dựng trải nghiệm người dùng
mượt mà trong quá trình đăng nhập, đến thiết lập mô hình phân quyền hai
tầng tách biệt giữa quyền truy cập máy trạm và quyền quản trị hệ thống,
quản lý vòng đời người dùng chuyên nghiệp, siết chặt xác thực bằng
introspection và 2FA cho admin tối cao, đồng bộ nhận diện thương hiệu
xuyên suốt từ desktop client đến trang đăng nhập Keycloak, chiến lược kỹ
thuật bảo đảm tính bền vững của dự án trong dài hạn, và cuối cùng là việc
làm chủ hoàn toàn chuỗi build-modify-đóng gói trên đa nền tảng --
mỗi giải pháp đều xuất phát từ bài toán thực tế và được kiểm chứng qua
quá trình triển khai.
