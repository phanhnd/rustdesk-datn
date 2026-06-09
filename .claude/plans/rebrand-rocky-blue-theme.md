# Plan: Rebrand to ROCKY + Blue Color Theme

## Mục tiêu
1. Đổi tên app từ "RustDesk" → "ROCKY" ở mọi nơi hiển thị với người dùng trong Sciter UI.
2. Thay toàn bộ bảng màu UI sang tông xanh (blue).

---

## Phần 1 — Đổi tên app thành ROCKY

### Vị trí cần thay đổi

| File | Dòng | Nội dung cần sửa |
|---|---|---|
| `libs/hbb_common/src/config.rs` | 72 | `RwLock::new("RustDesk".to_owned())` → `RwLock::new("ROCKY".to_owned())` |

> `APP_NAME` là nguồn duy nhất (single source of truth). Toàn bộ UI lấy tên qua `handler.get_app_name()` hoặc `get_app_name()` từ Rust, nên chỉ cần đổi ở đây.

### Các chỗ gọi `get_app_name()` trong UI (tự cập nhật, không cần sửa)
- `src/ui/index.tis:550` — menu "About ROCKY"
- `src/ui/index.tis:600` — title cửa sổ
- `src/ui/index.tis:844` — thông báo cập nhật

### Các URL hardcode (giữ nguyên, không thay đổi)
- `src/ui/index.tis` — link rustdesk.com, privacy, download → **không sửa** (URL ngoài, không thuộc phạm vi rebranding UI)

---

## Phần 2 — Đổi màu sang tông xanh (Blue Theme)

### File chính: `src/ui/common.css`

Đây là nơi khai báo tất cả CSS variables (`:root`). Chỉ cần sửa file này để áp dụng toàn bộ UI.

#### Màu hiện tại (tông hồng/đỏ) → Màu mới (tông xanh blue)

| Variable | Màu cũ | Màu mới (Blue) |
|---|---|---|
| `var(accent)` | `#e91e63` (hồng đậm) | `#1565C0` (blue đậm) |
| `var(button)` | `#f06292` (hồng nhạt) | `#42A5F5` (blue nhạt) |
| `var(menu-hover)` | `#fce4ec` (hồng rất nhạt) | `#E3F2FD` (blue rất nhạt) |
| `var(dark-red)` | `#A72145` | `#0D47A1` (navy blue) |

#### Các màu hardcode cần sửa trong `src/ui/index.css`

| Dòng | Màu cũ | Dùng cho | Màu mới |
|---|---|---|---|
| 344 | `linear-gradient(left,#e91e63,#f48fb1)` | badge/label gradient | `linear-gradient(left,#1565C0,#42A5F5)` |

#### Dark mode (trong `common.css`, block `@media (prefers-color-scheme: dark)`)
Không cần sửa nhiều — dark mode chỉ override `bg`, `gray-bg`, `border`, `text` (không phải accent).

---

## Thứ tự thực hiện

1. Sửa `libs/hbb_common/src/config.rs:72` — đổi tên ROCKY.
2. Sửa `src/ui/common.css` — đổi các CSS variable tông xanh.
3. Sửa `src/ui/index.css:344` — đổi gradient hardcode.
4. Build & kiểm tra UI: title window, menu About, màu button, màu badge.

---

## Không làm
- Không sửa URL rustdesk.com trong code.
- Không sửa `Cargo.toml` package name (internal, không hiển thị UI).
- Không động vào bất kỳ file Flutter nào.

---

## Change Log
- 2026-06-04: Tạo plan ban đầu.
