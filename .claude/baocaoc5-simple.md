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

# Tích hợp xác thực Keycloak vào ứng dụng desktop

## Bài toán

Khi tích hợp xác thực Keycloak vào hệ thống ROCKY, thách thức cốt lõi
không nằm ở giao thức xác thực, mà ở sự khác biệt căn bản giữa ứng dụng
desktop và ứng dụng web. Luồng đăng nhập theo chuẩn hiện đại yêu cầu
người dùng được chuyển đến trang đăng nhập của Keycloak trên trình duyệt,
hoàn thành đăng nhập, rồi hệ thống nhận lại kết quả. Đối với ứng dụng
web, bước chuyển tiếp đó diễn ra tự nhiên giữa các trang trong trình
duyệt. Đối với ứng dụng desktop, không có cơ chế mặc định nào để nhận
kết quả từ trình duyệt trở về ứng dụng -- ứng dụng chỉ có thể mở trình
duyệt hệ thống với một địa chỉ cho trước, nhưng không thể lắng nghe
phản hồi từ đó.

## Giải pháp

Đồ án giải quyết bài toán bằng mô hình lai: thay vì yêu cầu ứng dụng
desktop tự nhận kết quả từ trình duyệt -- điều mà kiến trúc Sciter không
cho phép -- toàn bộ phần nhận và xử lý kết quả đăng nhập được ủy quyền
cho gateway (máy chủ trung gian đang chạy sẵn trên nền). Luồng được
chia thành hai giai đoạn độc lập được kết nối qua một mã phiên tạm thời.

Giai đoạn đầu: ứng dụng ROCKY yêu cầu gateway tạo một phiên đăng nhập
và nhận lại địa chỉ trang đăng nhập Keycloak, sau đó mở địa chỉ đó
trong trình duyệt hệ thống. Người dùng thực hiện đăng nhập hoàn toàn
trong trình duyệt.

Giai đoạn hai: sau khi người dùng đăng nhập thành công, Keycloak
chuyển kết quả về gateway (không phải về ứng dụng desktop). Gateway
lưu trữ kết quả đó gắn với mã phiên. Trong khi đó, ứng dụng ROCKY
định kỳ hỏi gateway "phiên này đã xong chưa?" -- khi gateway xác nhận
đã có kết quả, ứng dụng nhận token và hoàn tất đăng nhập.

Điểm quan trọng của thiết kế này là toàn bộ logic xác thực nằm ở
gateway, còn ứng dụng desktop chỉ đóng vai trò điều phối đơn giản.

*Biểu đồ luồng OIDC lai - trình duyệt hệ thống + gateway callback
receiver*

## Kết quả đạt được

Giải pháp cho phép tích hợp xác thực Keycloak vào ứng dụng desktop mà
không cần sửa đổi bất kỳ thành phần lõi nào của RustDesk. Mô hình này
cũng có tính tổng quát: có thể áp dụng cho bất kỳ ứng dụng desktop nào
không có trình duyệt nhúng nhưng cần tích hợp đăng nhập qua web, miễn là
ứng dụng có thể mở trình duyệt hệ thống và có một máy chủ trung gian
đang chạy trên nền.

# Cơ chế kiểm tra định kỳ để phát hiện hoàn tất đăng nhập

## Bài toán

Khi luồng đăng nhập được phân tách thành hai giai đoạn xảy ra ở hai nơi
khác nhau (ứng dụng desktop và trình duyệt), phát sinh bài toán thực tế:
làm thế nào để ứng dụng biết chính xác thời điểm người dùng đã hoàn
thành đăng nhập trên trình duyệt?

Ứng dụng desktop không thể đứng chờ vô thời hạn vì điều đó sẽ làm giao
diện đóng băng, không thể tương tác được. Người dùng cũng có thể mất
nhiều phút để nhập thông tin, hoặc có thể đóng trình duyệt giữa chừng mà
không hoàn thành -- cả hai trường hợp đều cần được xử lý đúng cách mà
không ảnh hưởng đến trải nghiệm.

## Giải pháp

Đồ án thiết kế cơ chế kiểm tra định kỳ có trạng thái: sau khi mở trình
duyệt, ứng dụng ROCKY tự động hỏi gateway mỗi 2 giây một lần -- "đăng
nhập đã xong chưa?" -- mà không làm giao diện bị đóng băng hay chặn
tương tác của người dùng. Cơ chế này tự dừng khi xảy ra một trong ba
tình huống: người dùng đăng nhập thành công và token đã có mặt, người
dùng nhấn nút Hủy, hoặc đã chờ quá 2 phút mà chưa có kết quả.

Khi đăng nhập thành công, token được lưu bền vững vào bộ nhớ cục bộ
của ứng dụng để không cần đăng nhập lại trong các lần sử dụng tiếp theo.
Phía máy chủ, các phiên chờ bị bỏ ngang (người dùng đóng trình duyệt
giữa chừng) được tự động dọn dẹp sau 10 phút để không tiêu tốn tài nguyên.

## Kết quả đạt được

Giao diện hoàn toàn phản hồi trong suốt quá trình chờ đăng nhập -- người
dùng vẫn thao tác bình thường với ứng dụng trong lúc trình duyệt đang mở.
Độ trễ từ khi đăng nhập thành công đến khi ứng dụng cập nhật trung bình
dưới 2 giây. Tất cả tình huống ngoại lệ -- hủy, timeout, mất kết nối
giữa chừng -- đều được xử lý đúng, không để lại trạng thái dở dang.

# Mô hình phân quyền hai tầng độc lập

## Bài toán

Sau khi tích hợp xác thực tập trung, câu hỏi tiếp theo là: làm thế nào
để mỗi người dùng chỉ thấy đúng những máy trạm họ được phép điều khiển,
và đồng thời làm thế nào để nhiều nhân viên IT có thể cùng vận hành trang
quản trị mà không phải ai đăng nhập được cũng có toàn quyền? Thiết kế
ban đầu gộp chung cả hai mục đích này vào một cơ chế phân quyền duy nhất
với ba mức: admin, viewer, guest.

Cách gộp này bộc lộ hai hạn chế khi đồ án mở rộng quy mô. Thứ nhất,
mỗi khi tổ chức cần thêm một nhóm máy mới -- ví dụ, nhóm máy dành riêng
cho phòng kế toán -- lại phải tạo thêm một mức quyền mới trong cấu hình
hệ thống, thay vì chỉ tạo một nhóm. Thứ hai, trang quản trị chỉ có một
cấp admin duy nhất gánh hết mọi quyền, trong khi thực tế tổ chức cần
nhiều người vận hành với các phạm vi trách nhiệm khác nhau: người quản lý
tài khoản người dùng, người quản lý máy trạm, và admin tối cao.

## Giải pháp

Đồ án tách bài toán thành hai hệ phân quyền hoàn toàn độc lập, chỉ
dùng chung một hệ thống quản lý danh tính (Keycloak) nhưng không chia
sẻ dữ liệu với nhau:

1. **Quyền truy cập máy trạm theo nhóm/phòng ban**: thay vì gán quyền
   theo từng người, máy trạm được tổ chức thành các nhóm phản ánh cơ
   cấu tổ chức (ví dụ: nhóm máy kế toán, nhóm máy kỹ thuật). Người
   dùng được gán vào nhóm tương ứng, và sau khi đăng nhập sẽ tự động
   thấy đúng những máy mà nhóm họ được phép truy cập. Thêm nhóm máy
   mới không cần thay đổi cấu hình hệ thống, chỉ cần tạo nhóm mới và
   gán máy/người dùng vào.

2. **Phân quyền trang quản trị theo 3 cấp**: admin tối cao (toàn quyền,
   là cấp duy nhất được tạo/xóa nhóm và phân quyền cho người khác),
   quản trị viên người dùng (tạo/sửa/xóa tài khoản và gán người dùng
   vào nhóm), và quản trị viên máy trạm (tạo/sửa/xóa máy và gán máy
   vào nhóm). Ranh giới giữa các cấp được xác định rõ ràng: cấp thấp
   hơn không thể tự nâng cấp quyền của mình.

Hai hệ phân quyền này hoàn toàn tách biệt: một nhân viên IT có thể
đồng thời thuộc nhóm máy kỹ thuật (để truy cập máy) và là quản trị viên
máy trạm (để quản lý máy), hai vai trò này không ảnh hưởng nhau.

## Kết quả đạt được

Thêm một nhóm/phòng ban máy mới chỉ mất vài thao tác trên giao diện quản
trị, không cần chỉnh sửa cấu hình hệ thống. Thu hồi quyền truy cập máy
của một người có hiệu lực ngay lập tức khi gỡ họ khỏi nhóm. Trang quản
trị có thể được vận hành bởi nhiều nhân viên IT ở các mức trách nhiệm
khác nhau mà không ai có thể tự cấp thêm quyền cho mình hoặc cho người
khác. Hạn chế còn ghi nhận trung thực: xác thực hai lớp (trình bày ở mục
sau) hiện chỉ bắt buộc với admin tối cao, chưa mở rộng cho hai cấp còn
lại -- đây là khoảng trống đã được ghi nhận, dành cho hướng phát triển
tiếp theo.

# Quản lý vòng đời người dùng qua giao diện quản trị tập trung

## Bài toán

RustDesk bản gốc không có khái niệm tài khoản người dùng -- mọi máy đều
có thể kết nối nếu biết mã định danh và mật khẩu. Khi đưa Keycloak vào
làm hệ thống quản lý danh tính trung tâm, một bài toán vận hành mới xuất
hiện: quản trị viên cần có khả năng quản lý toàn bộ vòng đời của người
dùng trong tổ chức -- từ khi nhân viên gia nhập đến khi rời đi -- mà không
phải thao tác trực tiếp trên giao diện quản trị của Keycloak vốn phức tạp
và không thân thiện với người dùng phổ thông.

Vòng đời một người dùng trong hệ thống điều khiển từ xa bao gồm nhiều sự
kiện quan trọng: được cấp tài khoản khi gia nhập, được giao quyền truy
cập vào nhóm máy phù hợp với vai trò, cần được điều chỉnh quyền khi
chuyển bộ phận, cần bị tạm khóa nhanh khi có sự cố bảo mật, và cần xóa
sạch khi rời tổ chức. Mỗi bước đều cần được thực hiện kịp thời để đảm
bảo an toàn thông tin.

## Giải pháp

Đồ án xây dựng một lớp giao diện quản trị web đóng vai trò trung gian,
cho phép quản trị viên thực hiện mọi thao tác quản lý người dùng từ một
trang web quen thuộc mà không cần biết đến cơ chế kỹ thuật bên dưới.
Mỗi sự kiện trong vòng đời người dùng được ánh xạ thành một thao tác
đơn giản trên giao diện: tạo tài khoản, gán hoặc thu hồi quyền truy cập
máy theo nhóm, điều chỉnh cấp quản trị, tạm khóa khẩn cấp bằng một nút
bật/tắt, và xóa tài khoản.

Một cải tiến thực tế đáng kể: bước gán nhóm và cấp quyền quản trị được
gộp trực tiếp vào form tạo tài khoản, để toàn bộ quy trình "tạo người
dùng mới và phân quyền ban đầu" hoàn thành trong một lượt thay vì phải
tạo xong rồi mở thêm các hộp thoại riêng như trước.

## Kết quả đạt được

Quản trị viên có thể thực hiện toàn bộ vòng đời người dùng từ một giao
diện web quen thuộc, không cần tiếp cận hay hiểu về hệ thống Keycloak
bên dưới. Thời gian thực hiện mỗi thao tác giảm đáng kể, đặc biệt với
quy trình tạo người dùng kèm phân quyền nay được gộp vào một lượt. Quan
trọng hơn, các thao tác nhạy cảm như khóa tài khoản khẩn cấp có thể thực
hiện ngay lập tức mà không cần kiến thức chuyên sâu, giảm nguy cơ chậm
trễ trong xử lý sự cố bảo mật.

# Đăng nhập bằng Google và xác thực hai lớp cho admin tối cao

## Bài toán

Hai vấn đề thực tế phát sinh khi vận hành xác thực tập trung. Thứ nhất,
yêu cầu người dùng tạo và nhớ thêm một tài khoản riêng cho hệ thống ROCKY
-- tách biệt với tài khoản Google Workspace hoặc Gmail họ đã dùng hàng
ngày -- làm tăng rào cản khi tiếp nhận người dùng mới và dễ dẫn đến thói
quen đặt mật khẩu yếu hoặc dùng lại mật khẩu cũ.

Thứ hai, tài khoản admin tối cao nắm toàn quyền quản lý hệ thống -- từ
người dùng, máy trạm, đến phân quyền -- nên chỉ bảo vệ bằng một lớp mật
khẩu là không đủ an toàn. Cần thêm một lớp xác minh riêng dành cho cấp
quyền cao nhất này.

## Giải pháp

1. **Đăng nhập bằng Google**: cấu hình Google làm nhà cung cấp danh tính
   bổ sung trên Keycloak. Vì toàn bộ luồng đăng nhập của ROCKY đều dẫn
   đến trang đăng nhập do Keycloak host, tùy chọn "Đăng nhập bằng Google"
   xuất hiện tự động trên trang đó ngay sau khi cấu hình xong -- không
   cần sửa đổi code ở phía gateway hay ứng dụng desktop. Người dùng có
   thể chọn đăng nhập bằng tài khoản Google hoặc tài khoản nội bộ, tuỳ
   nhu cầu.

2. **Xác thực hai lớp bắt buộc cho admin tối cao**: cấu hình một luồng
   xác thực riêng trên Keycloak chỉ áp dụng cho tài khoản có cấp quyền
   cao nhất. Người dùng ở cấp này, sau khi nhập đúng mật khẩu, bắt buộc
   phải nhập thêm mã xác thực từ ứng dụng trên điện thoại (Google
   Authenticator hoặc tương đương). Luồng này chỉ áp dụng cho trang quản
   trị, không ảnh hưởng đến luồng đăng nhập của người dùng thông thường
   trên ứng dụng desktop.

## Kết quả đạt được

Người dùng có thể đăng nhập bằng tài khoản Google sẵn có, không cần tạo
và nhớ thêm mật khẩu riêng, giảm rào cản khi tiếp nhận thành viên mới
mà vẫn giữ song song lựa chọn đăng nhập bằng tài khoản nội bộ. Trang
quản trị có thêm một lớp bảo vệ cho tài khoản quyền cao nhất mà không
cần triển khai thêm hạ tầng phức tạp như tin nhắn SMS hay email xác thực.
Hạn chế còn ghi nhận trung thực: xác thực hai lớp hiện chỉ bắt buộc với
admin tối cao, hai cấp quản trị còn lại -- vốn cũng có quyền thực sự
trên hệ thống -- vẫn đăng nhập được mà không qua bước xác thực thứ hai.

# Đồng bộ nhận diện thương hiệu xuyên suốt ba thành phần hệ thống

## Bài toán

Hệ thống ROCKY bao gồm ba thành phần giao diện người dùng: ứng dụng
desktop ROCKY Client, trang quản trị web Admin UI, và trang đăng nhập do
Keycloak cung cấp. Người dùng di chuyển qua cả ba trong một luồng làm
việc điển hình -- nhân viên: mở ứng dụng → chuyển sang trang đăng nhập
Keycloak → quay lại ứng dụng sau khi xác thực; quản trị viên: mở Admin
UI → chuyển sang Keycloak → vào trang quản trị. Nếu màu sắc, logo và
tổng thể hình ảnh khác nhau giữa các bước, người dùng cảm nhận đang dùng
ba sản phẩm khác nhau thay vì một hệ thống thống nhất.

Thách thức thực tế là ba thành phần này được xây dựng trên ba nền tảng
công nghệ khác nhau, mỗi nền tảng có cách khai báo giao diện riêng và
không tương thích nhau. Bên cạnh đó, trang đăng nhập Keycloak không thể
bị sửa đổi trực tiếp -- nếu sửa thẳng vào mã nguồn gốc của Keycloak,
mỗi lần nâng cấp phiên bản mới sẽ làm mất toàn bộ thay đổi.

## Giải pháp

Đồ án thiết lập một bảng màu thương hiệu duy nhất làm nguồn sự thật với
sáu màu cốt lõi: teal nhận diện chính, xanh nhạt làm điểm nhấn phụ,
navy đậm làm nền, cùng ba sắc độ chữ và viền phân cấp. Bảng màu này sau
đó được áp dụng lên cả ba thành phần, mỗi thành phần theo đúng cách thức
mà nền tảng của mình yêu cầu.

**Ứng dụng desktop ROCKY Client**: tên ứng dụng được đổi thành ROCKY tại
một điểm duy nhất trong cấu hình, toàn bộ giao diện tự động đọc từ đó
mà không cần sửa từng màn hình riêng lẻ. Bảng màu thương hiệu được khai
báo tập trung tại một file duy nhất, các thành phần giao diện khác đều
tham chiếu vào đó -- từ màu nút bấm, màu spinner khi tải danh sách máy,
màu viền dialog đăng nhập, đến màu nền banner trong cửa sổ Giới thiệu.
Logo lục giác được nhúng trực tiếp vào ứng dụng và hiển thị trong cửa sổ
chính thay cho logo mũi tên gốc của RustDesk.

**Trang quản trị web Admin UI**: cùng bảng màu thương hiệu được áp dụng
lên toàn bộ giao diện -- màu nhấn teal xuất hiện ở nút bấm chính, tiêu
đề, liên kết và các thành phần tương tác. Logo lục giác hiển thị nhất
quán ở thanh điều hướng. Tuy nhiên, sau phản hồi thực tế về khả năng đọc
khi theo dõi bảng dữ liệu dài, Admin UI chủ động chọn nền sáng thay vì
nền navy đậm như ứng dụng desktop -- đây là sự khác biệt có chủ đích,
được ghi nhận rõ để tránh nhầm lẫn khi bảo trì sau này.

**Trang đăng nhập Keycloak**: vì không thể sửa trực tiếp mã nguồn gốc
của Keycloak, đồ án tạo một gói giao diện con kế thừa từ giao diện gốc
theo đúng cơ chế chuẩn mà Keycloak hỗ trợ. Nguyên tắc áp dụng là chỉ
thay đổi đúng phần cần thay đổi -- logo lục giác, tiêu đề "ROCKY Admin",
tagline, và bảng màu teal/navy -- trong khi kế thừa nguyên bản phần còn
lại như layout, form nhập liệu, và xử lý lỗi. Nhờ đó, nâng cấp Keycloak
lên phiên bản mới không làm mất giao diện đã tùy biến. Một điểm thực tế
phát sinh khi triển khai: toàn bộ nhãn tiếng Việt phải được đưa vào file
ngôn ngữ mặc định thay vì file tiếng Việt riêng, vì khi chưa bật tính
năng đa ngôn ngữ, file tiếng Việt bị bỏ qua hoàn toàn bất kể có tồn tại
hay không.

## Kết quả đạt được

Người dùng trải qua một luồng thị giác liền mạch: logo lục giác sáu chấm,
màu teal làm màu nhấn xuyên suốt từ ứng dụng desktop, qua trang đăng
nhập Keycloak, đến trang quản trị -- không còn điểm đứt gãy nhận diện
thương hiệu khi chuyển qua lại giữa các thành phần. Việc nâng cấp Keycloak
lên phiên bản mới không làm mất giao diện đã tùy biến. Về mặt bảo trì,
khi cần điều chỉnh màu sắc trong tương lai, chỉ cần cập nhật tại ba vị
trí khai báo tương ứng thay vì tìm kiếm rải rác khắp mã nguồn.

# Tùy biến mã nguồn mở RustDesk bảo toàn khả năng cập nhật lâu dài

## Bài toán

Xây dựng ROCKY trên nền mã nguồn mở RustDesk mang lại lợi thế lớn về
thời gian và chất lượng kỹ thuật, nhưng đặt ra bài toán bảo trì dài hạn:
nếu sửa đổi tràn lan vào mã nguồn gốc để thay logo, màu sắc, và tên ứng
dụng, việc tích hợp bản vá bảo mật từ RustDesk trong tương lai sẽ trở
nên cực kỳ khó khăn. Phần thay đổi giữa ROCKY và RustDesk phải được giữ
nhỏ và có tổ chức.

## Giải pháp

Đồ án áp dụng nguyên tắc tập trung hóa điểm can thiệp: thay vì sửa đổi
phân tán nhiều nơi, toàn bộ tùy biến được dẫn về số lượng tối thiểu các
vị trí chiến lược. Tên ứng dụng được định nghĩa tại một điểm duy nhất
trong file cấu hình, và toàn bộ giao diện đọc từ đó. Màu sắc thương hiệu
được khai báo tập trung, cho phép thay đổi toàn bộ giao diện bằng cách
sửa một chỗ. Tính năng Keycloak được bổ sung hoàn toàn vào các file giao
diện hiện có mà không sửa đổi bất kỳ hàm nào đã tồn tại. Các thành phần
hoàn toàn mới -- máy chủ trung gian và giao diện quản trị -- là các file
tách biệt, không tạo phụ thuộc vào mã nguồn gốc của RustDesk.

## Kết quả đạt được

Tổng số điểm bị sửa đổi so với bản gốc RustDesk là rất nhỏ và có tổ
chức rõ ràng. Khi RustDesk phát hành bản vá mới, phần lớn mã lõi có thể
hợp nhất mà không có xung đột. Phần giao diện tùy biến được tách biệt
hoàn toàn nên dễ dàng xác định và giải quyết xung đột nếu có. Mô hình
này có thể tái sử dụng như một hướng dẫn thực hành tốt cho bất kỳ tổ
chức nào muốn xây dựng phiên bản có thương hiệu riêng của RustDesk.

# Làm chủ toàn bộ chuỗi biên dịch và đóng gói đa nền tảng

## Bài toán

Xây dựng ROCKY trên nền mã nguồn mở RustDesk đòi hỏi nhiều hơn việc đọc
hiểu kiến trúc -- nhóm phát triển phải thực sự làm chủ được toàn bộ chuỗi
từ biên dịch mã nguồn, sửa đổi giao diện, đến xuất ra gói cài đặt chạy
được trên từng hệ điều hành. RustDesk là một hệ thống đa tầng kết hợp
nhiều công nghệ và công cụ xây dựng, trong đó mỗi tầng có thể thất bại
âm thầm nếu một thành phần phụ thuộc bị thiếu hoặc phiên bản không khớp.

Các bẫy kỹ thuật không được tài liệu chính thức ghi rõ bao gồm: phiên bản
ngôn ngữ lập trình Rust bị giới hạn cứng không được nâng quá một mốc nhất
định do tương thích ngược với thư viện giao diện; các tham số cấu hình
thư viện đồ họa native phải khớp chính xác với những gì script biên dịch
mong đợi; script đóng gói chứa nhiều lỗi đường dẫn khiến giai đoạn xuất
gói thất bại dù bước biên dịch đã thành công; và công cụ nhúng giao diện
vào file thực thi không xử lý đúng văn bản tiếng Việt trên môi trường
Windows.

## Giải pháp

Nhóm phân tích toàn bộ chuỗi biên dịch từ đầu đến cuối, ghi nhận từng
điểm thất bại, tìm nguyên nhân gốc rễ, và triển khai sửa chữa theo nguyên
tắc can thiệp tối thiểu -- chỉ chỉnh đúng chỗ gây lỗi, không làm thay
đổi phần không liên quan.

Về phía biên dịch: ghim cứng phiên bản Rust tại một mốc tương thích,
đảm bảo mọi môi trường -- máy phát triển lẫn hệ thống tự động trên
đám mây -- dùng cùng một phiên bản. Cấu hình đúng các thư viện phụ thuộc
native cho từng hệ điều hành.

Về phía đóng gói: sửa các lỗi đường dẫn trong script đóng gói, đảm bảo
thư mục kết quả luôn được tạo trước khi sao chép file vào. Sửa công cụ
nhúng giao diện để xử lý đúng mã hóa UTF-8, giải quyết lỗi gặp phải khi
văn bản tiếng Việt xuất hiện trong giao diện ROCKY.

Về phía hệ thống tự động CI/CD: xây dựng ba luồng tự động cho Windows
(file cài đặt `.exe`), Linux (gói `.deb` và `.AppImage`), và macOS (file
`.dmg`). Luồng cho macOS là hoàn toàn mới vì phiên bản gốc RustDesk không
có luồng tự động nào build ứng dụng Sciter cho macOS. Mỗi luồng đều tự
động tải thư viện giao diện Sciter cần thiết trước khi biên dịch.

## Kết quả đạt được

Hệ thống tự động CI/CD hoạt động ổn định trên cả ba nền tảng: mỗi lần có
thay đổi mã nguồn, ba gói cài đặt tương ứng được tạo ra tự động và có thể
tải về ngay từ GitHub Actions mà không cần can thiệp thủ công. Nhóm có
khả năng thực hiện đầy đủ vòng lặp sửa đổi giao diện -- chỉnh sửa, biên
dịch, kiểm tra -- ngay trên máy phát triển mà không phụ thuộc vào hệ thống
CI/CD. Toàn bộ nguyên nhân gốc của từng lỗi biên dịch được ghi lại thành
tài liệu tham khảo, tạo nền tảng cho người tiếp quản dự án trong tương lai.

Tóm lại, tám đóng góp trong chương này hình thành một hệ thống mạch lạc
và có chiều sâu kỹ thuật. Từ việc giải quyết bài toán tích hợp xác thực
vào môi trường desktop phi trình duyệt, xây dựng trải nghiệm người dùng
mượt mà trong quá trình đăng nhập, đến thiết lập mô hình phân quyền hai
tầng tách biệt giữa quyền truy cập máy trạm và quyền quản trị hệ thống,
quản lý vòng đời người dùng chuyên nghiệp, siết chặt xác thực bằng
xác thực hai lớp cho admin tối cao, đồng bộ nhận diện thương hiệu
xuyên suốt từ desktop client đến trang đăng nhập Keycloak, chiến lược kỹ
thuật bảo đảm tính bền vững của dự án trong dài hạn, và cuối cùng là việc
làm chủ hoàn toàn chuỗi biên dịch và đóng gói trên đa nền tảng --
mỗi giải pháp đều xuất phát từ bài toán thực tế và được kiểm chứng qua
quá trình triển khai.
