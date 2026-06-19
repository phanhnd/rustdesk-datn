# Session Log — 2026-06-19: Đồng bộ giao diện ROCKY (Sciter app + Admin UI)

## Mục tiêu

Đồng bộ bộ nhận diện thương hiệu mới (logomark lục giác 6 chấm + tone teal/navy, lấy từ
ảnh thương hiệu `7hcf9j6v.png`) trên cả 2 mặt UI của hệ thống:
- **App desktop ROCKY** (Sciter UI, `src/ui/`)
- **Admin UI** (web, `public/admin.html`)

## Tóm tắt thay đổi

### 1. Icon / Logomark
- Crop logomark (6 chấm lục giác + chấm xanh giữa) từ ảnh gốc bằng Pillow, loại bỏ chữ
  "ROCKY"/tagline, nền trong suốt.
- Sinh asset cho mọi kích thước/định dạng: `res/icon.png`, `res/icon.ico`,
  `res/tray-icon.ico`, `res/32x32.png` … `res/128x128@2x.png`, `res/mac-icon.png`,
  `res/mac-tray-*-x2.png` (bản "template" đơn sắc cho macOS), `res/scalable.svg`.
- Icon cửa sổ thật sự của app **không** đọc từ các file trên — nó là PNG base64 nhúng
  trực tiếp trong `src/ui.rs::get_icon()` (2 nhánh macOS/non-macOS). Đã encode lại và
  thay 2 chuỗi base64 đó bằng logomark mới.

### 2. App desktop (Sciter UI — `src/ui/`)
- `src/ui/common.css:1-22` — đổi toàn bộ palette từ xanh dương `#1565C0` sang teal/navy:
  `accent` `#00D2D3`, `button` `#58D0F8`, `menu-hover` `#DDF7F6`, `dark-red` (dùng làm
  navy) `#111D43`; đồng thời đổi `text`/`light-text`/`lighter-text` từ xám trung tính
  sang navy nhạt (`#16234F`/`#5C6F94`/`#8B9BC2`) và `border` sang `#D7E3F3` — khớp với
  palette cuối cùng của admin.html.
- `src/ui/index.css:344` — gradient banner đổi từ `#1565C0→#42A5F5` sang
  `#111D43→#00D2D3`.
- `common.css`: input bo góc `0 → 0.4em` (khớp `button.button` 0.5em); `button.button`/
  `button.outline` thêm `font-weight: 600`.
- `index.css` (`@mixin CARD`): thêm `box-shadow: 0 1px 6px rgba(22,35,79,.12)` cho card
  "Điều khiển Desktop Từ Xa".
- **Bỏ khung cảnh báo Wayland** (`ModifyDefaultLogin`, chỉ hiện khi
  `handler.current_is_wayland()`), thay bằng component `BrandLogo` render **không điều
  kiện** trong `.left-pane` — gồm: icon logomark, tên app (`handler.get_app_name()`, đậm,
  màu `color(accent)`), tagline (`translate('Slogan_tip')`, in nghiêng, màu
  `color(button)`). `FixWayland` (cảnh báo Wayland khác) giữ nguyên, không liên quan.
- `src/lang/en.rs:9` — `Slogan_tip`: "Made with heart in this chaotic world!" →
  "Think Like Hustler."
- Sau mỗi lần sửa CSS/TIS: chạy `python3 res/inline-sciter.py` để đồng bộ
  `src/ui/inline.rs` (bundle dùng cho build Windows feature `inline`).

### 3. Admin UI (`public/admin.html`)
Trải qua nhiều vòng lặp theo phản hồi trực tiếp của user:
1. Đổi từ theme sáng xanh dương `#1565C0` sang theme **nền navy đậm** (`#0B1530` /
   `#16234F` / `#1B2A5C`), dùng 1 bộ CSS custom property `:root{--bg, --surface, ...}`
   thay cho hex rời rạc.
2. User phản hồi "quá tối" → tăng sáng palette navy 1 lần (`#16234F`/`#1E2F66`/`#28407F`).
3. Vẫn bị phản hồi "còn tối" → **bỏ hẳn navy, chuyển sang theme sáng hoàn toàn**: nền
   `#F7FAFF`, card trắng, chữ navy đậm `#16234F`, accent teal đậm `#00B8B8` (đậm hơn
   bản app một chút để đủ tương phản trên nền trắng).
4. Phát hiện & sửa lỗi font không đồng bộ: `button`/`input`/`select`/`code` không tự kế
   thừa `font-family` của `body` trong browser → thêm `font-family: inherit` cho các
   tag này; set `body { font-family: Ubuntu, -apple-system, 'Segoe UI', Cantarell,
   'Noto Sans', system-ui, sans-serif }` (Ubuntu trước tiên vì là font OS mà Sciter app
   dùng qua `font: system;`).
5. Nhúng logomark (base64 qua biến JS `LOGO_DATA_URI`, vì `server.js` chỉ serve riêng
   `admin.html` qua `GET /admin`, không có route static file chung) vào
   `<img id="brand-logo-login">` (login card) và `<img id="brand-logo-header">` (header).
6. Theo yêu cầu: phóng to khung đăng nhập (340px → 440px) và logo (56px → 96px); in đậm
   toàn bộ chữ trong khung đăng nhập (h1 800, tagline/label 700, mô tả 600).

### 4. Tài liệu đã cập nhật trong lúc làm
- `CLAUDE.md` — mục "Rebrand: ROCKY + Navy/Teal Theme": bảng palette đầy đủ (kể cả
  text/border), ghi chú khung Wayland đã bỏ, ghi chú admin UI dùng theme riêng (sáng).
- `docs/admin-ui.md` — Change Log: theme navy → sáng, nhúng logo, lý do từng quyết định.

## Quyết định quan trọng & lý do

- **Sciter không hỗ trợ CSS custom property kiểu browser** (`:root{--x}`/`var(--x)`) —
  phải dùng cú pháp riêng `var(name): value;` trong `html { ... }` + `color(name)`. Đây
  là lý do palette của app (`common.css`) và admin UI (`admin.html`) khai báo ở 2 nơi
  riêng biệt, không share được trực tiếp.
- **BrandLogo hiển thị luôn**, không còn phụ thuộc điều kiện Wayland — đổi lại, cảnh báo
  "Wayland đang thử nghiệm" không còn hiển thị cho user. Đã xác nhận với user trước khi
  làm (user chọn phương án này thay vì giữ điều kiện cũ).
- **Admin UI dùng theme sáng, KHÁC với palette navy/teal của app** — vì navy bị phản hồi
  "quá tối" 2 lần liên tiếp; quyết định cuối: ưu tiên dễ đọc hơn là giữ đúng tone tối của
  ảnh thương hiệu gốc.
- Logo nhúng base64 trực tiếp trong cả 2 nơi (app: `src/ui.rs`, admin: `LOGO_DATA_URI`
  trong `admin.html`) — vì cả `get_icon()` và `server.js` đều không có cách trỏ ra file
  ảnh tĩnh riêng, base64-inline là cách tối thiểu thay đổi, nhất quán với pattern đã có
  sẵn trong code.

## Kiểm thử đã thực hiện

- `cargo check --lib` — pass, không lỗi (chạy lại nhiều lần sau mỗi đợt sửa).
- `cargo build --release` — pass, build thành công trong ~8 phút
  (`target/release/rustdesk`).
- `public/admin.html`: kiểm tra JS không lỗi cú pháp (`node -e "new Function(...)"`),
  kiểm tra nội dung qua `curl http://127.0.0.1:3000/admin` (server đang chạy sẵn).
- **Hạn chế**: sandbox không có headless browser/GUI cho Sciter, nên không tự chụp ảnh
  app thật hoặc admin UI thật được — toàn bộ xác nhận trực quan (màu sắc, layout, font)
  đều do user tự kiểm tra qua ảnh chụp màn hình họ cung cấp.

## Việc còn để ngỏ

- Chưa kiểm tra `build-linux` job trong CI (`.github/workflows/build.yml`) có bị ảnh
  hưởng bởi thay đổi `res/*` (icon mới) hay không — job này đã được ghi chú từ trước là
  "currently-unverified" trong `CLAUDE.md`.
- Chưa generate lại `res/gen_icon.sh` (script ImageMagick cũ, không động tới trong
  session này) — nếu sau này cần resize icon thủ công, script đó vẫn trỏ tới
  `icon.png`/`icon.svg` cũ, nên kiểm tra lại trước khi dùng.
