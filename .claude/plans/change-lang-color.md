# Kế hoạch: Đổi ngôn ngữ tiếng Việt + UI hồng cute

## Context
Hai yêu cầu độc lập:
1. **Ngôn ngữ tiếng Việt** — File `vi.rs` đã tồn tại và dịch 100% (762 dòng, không entry nào bỏ trống). Chỉ cần ép RustDesk dùng `"vi"` làm default thay vì auto-detect theo hệ điều hành.
2. **Tông màu hồng cute** — Toàn bộ màu accent/button đang dùng xanh `#0071ff` / `#2C8CFF`. CSS variable được định nghĩa tập trung tại `common.css`; một số màu inline rải rác trong các file TIS.

---

## Phần 1 — Đổi ngôn ngữ mặc định sang tiếng Việt

### File cần sửa: `src/lang.rs`

**Cơ chế hiện tại:**
```rust
// src/lang.rs (khoảng dòng 112-135)
pub fn translate_locale(name: String, locale: &str) -> String {
    let mut lang = LocalConfig::get_option("lang").to_lowercase();
    if lang.is_empty() {
        // detect từ system locale → thường ra "en" trên máy không cài tiếng Việt
        lang = detect_system_lang();
    }
    let m = match lang.as_str() {
        "vi" => vi::T.deref(),
        _    => en::T.deref(),   // ← fallback mặc định là en
    };
}
```

**Thay đổi:** Khi config `"lang"` chưa được đặt, set thẳng về `"vi"` thay vì detect hệ thống:

```rust
if lang.is_empty() {
    lang = "vi".to_owned();   // mặc định tiếng Việt
}
```

> Nếu user muốn đổi lại ngôn ngữ khác, họ vẫn dùng được dropdown Language trong Settings — config `"lang"` sẽ ghi đè giá trị này.

---

## Phần 2 — UI tông màu hồng cute

### Palette màu hồng

| Vai trò | Màu cũ (xanh) | Màu mới (hồng) |
|---------|--------------|----------------|
| Accent chính (`var(accent)`) | `#0071ff` | `#e91e63` |
| Button (`var(button)`) | `#2C8CFF` | `#f06292` |
| Menu hover (`var(menu-hover)`) | `#D7E4F2` | `#fce4ec` |
| Progress bar (ab.tis) | `#0071ff` inline | `#e91e63` |
| SVG icon fills (header, file_transfer) | `#2C8CFF` inline | `#f06292` |
| Msgbox default (msgbox.tis) | `#2C8CFF` | `#f06292` |
| Dialog purple (msgbox.tis) | `#AD448E` | `#e91e63` |
| Banner gradient (index.css) | `#e242bc → #f4727c` | `#e91e63 → #f48fb1` |
| Copyright bg (index.tis) | `#2c8cff` | `#f06292` |

### File 1: `src/ui/common.css` (3 dòng)

```css
var(accent): #e91e63;      /* was #0071ff */
var(button): #f06292;      /* was #2C8CFF */
var(menu-hover): #fce4ec;  /* was #D7E4F2 */
```

### File 2: `src/ui/ab.tis` — 2 progress bar inline

```tis
<progress style="color: #e91e63" />   /* was #0071ff */
```

### File 3: `src/ui/msgbox.tis` — 2 màu dialog

```
#2C8CFF → #f06292   (default msgbox)
#AD448E → #e91e63   (password/login dialog)
```

### File 4: `src/ui/index.css`

- Gradient banner: `#e242bc, #f4727c` → `#e91e63, #f48fb1`
- Các `#2C8CFF` inline (hover border, focus) → `#f06292`

### File 5: `src/ui/index.tis` — copyright bg

```tis
background: #f06292   /* was #2c8cff */
```

### File 6: `src/ui/header.tis` + `src/ui/file_transfer.tis`

```tis
fill="#f06292"   /* was #2C8CFF */
```

---

## Tóm tắt file cần sửa

| File | Thay đổi | Số chỗ |
|------|----------|--------|
| `src/lang.rs` | Fallback language = "vi" | 1 |
| `src/ui/common.css` | CSS variables accent/button/hover | 3 |
| `src/ui/ab.tis` | Inline progress color | 2 |
| `src/ui/msgbox.tis` | Dialog title colors | 2 |
| `src/ui/index.css` | Gradient + inline blue | ~3 |
| `src/ui/index.tis` | Copyright bg color | 1 |
| `src/ui/header.tis` | SVG fill | 1 |
| `src/ui/file_transfer.tis` | SVG fill | 1 |

---

## Kiểm tra

```bash
cargo run
```

1. Khởi động RustDesk → toàn bộ text tiếng Việt ngay (không cần vào Settings)
2. Settings → Language → "Tiếng Việt (vi)" đang được chọn
3. Màu accent/button/progress bar hồng (`#e91e63` / `#f06292`)
4. Hover menu item → nền hồng nhạt (`#fce4ec`)
5. Mở msgbox → header hồng thay vì xanh/tím
6. Dark mode → accent vẫn hồng (dark section không override 2 biến này)

**Revert:** Khôi phục 3 dòng `common.css` và 1 dòng `lang.rs`.
