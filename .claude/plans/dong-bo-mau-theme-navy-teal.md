# Đồng bộ màu hardcode còn sót lại theo theme navy/teal

## Bối cảnh

Theme ROCKY hiện hành (`src/ui/common.css`) dùng palette navy/teal:
`accent #00D2D3`, `button #58D0F8`, `dark-red(navy) #111D43`. Khi rà soát diff so với
upstream RustDesk, phát hiện 4 chỗ vẫn hardcode màu hồng cũ (`#f06292`/`#e91e63`) từ một
lần đổi theme trước đó (trước cả bản blue rồi navy/teal), chưa từng được cập nhật:

- `src/ui/msgbox.tis:120` — màu accent cho msgbox loại login (`input-password`,
  `session-login`, ...). Bản gốc RustDesk dùng `#AD448E` (màu riêng, tách biệt khỏi
  button color, để nhấn mạnh dialog đăng nhập).
- `src/ui/msgbox.tis:128` — màu mặc định cho các msgbox còn lại. Bản gốc RustDesk dùng
  `#2C8CFF`, đúng bằng giá trị `button` gốc lúc đó.
- `src/ui/header.tis:18` (`svg_recording_on` fill) — bản gốc `#2C8CFF` (= button gốc),
  biểu thị trạng thái "đang ghi hình" (active/highlight).
- `src/ui/index.tis:611` — nền banner copyright trong popup "About". Bản gốc `#2c8cff`
  (= button gốc).
- `src/ui/file_transfer.tis:25` (`svg_computer` fill) — bản gốc `#2C8CFF` (= button gốc).

Sciter KHÔNG hỗ trợ `color(name)` bên trong chuỗi JS (`.tis`) hay thuộc tính SVG inline —
chỉ dùng được trong rule CSS thật (đã xác nhận: toàn bộ usage `color(accent)`/
`color(button)` hiện có chỉ nằm trong các file `.css`). Vì vậy phải thay bằng hex literal
khớp palette hiện hành, không dùng `color()`.

## Mapping màu

| Vị trí | Vai trò gốc | Giá trị cũ (hồng) | Giá trị mới |
|---|---|---|---|
| `msgbox.tis:120` | accent riêng cho login dialog | `#e91e63` | `#00D2D3` (accent teal — màu nhận diện chính) |
| `msgbox.tis:128` | = button color gốc, dùng cho msgbox mặc định | `#f06292` | `#58D0F8` (button) |
| `header.tis:18` | = button color gốc, icon "recording on" | `#f06292` | `#58D0F8` (button) |
| `file_transfer.tis:25` | = button color gốc, icon máy tính | `#f06292` | `#58D0F8` (button) |
| `index.tis:611` | nền banner, cần tương phản với chữ trắng | `#f06292` | gradient `linear-gradient(left,#111D43,#00D2D3)` — khớp gradient banner `.install-me/.trust-me` đã dùng ở `index.css:345`, vì màu `button` (#58D0F8) quá nhạt để làm nền chữ trắng |

**Lý do tách riêng `index.tis:611`:** nền đặc màu `button` (#58D0F8, xanh nhạt) sẽ làm chữ
trắng khó đọc (tương phản thấp). Dùng lại gradient navy→teal đã có sẵn trong CSS cho banner
khác để vừa đảm bảo tương phản vừa đồng bộ hình ảnh giữa các banner trong app.

## Phạm vi

Chỉ sửa 5 vị trí hex màu trên. Không đổi logic, không đổi text, không động tới
`public/admin.html` (theme riêng, không thuộc phạm vi này).

## Documentation sau khi xong

Cập nhật mục "Rebrand: ROCKY + Navy/Teal Theme" trong `CLAUDE.md` — thêm các file vừa
sửa vào danh sách "Files đã thay đổi", ghi rõ đây là pass dọn màu hồng sót lại từ lần đổi
theme trước, không phải thay đổi theme mới.
