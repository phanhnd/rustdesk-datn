# Kế hoạch: Chặn kết nối trái phép vào máy không được phân quyền

> Trạng thái: **Đã implement** — chờ verify sau khi build xong

---

## Vấn đề

Address book chỉ là display filter — không ngăn kết nối trực tiếp. User biết ID + password có thể kết nối dù chưa login hoặc không có quyền.

---

## Tại sao phải dùng Rust thay vì TIS httpRequest

TIS `httpRequest` là **async** — sau khi gọi nó, hàm tiếp tục chạy và kết thúc ngay, không chờ callback. Nên kết nối vẫn xảy ra trước khi nhận được kết quả check. `handler.check_access_blocking()` là **synchronous** — TIS block lại chờ Rust trả kết quả, mới chạy tiếp.

---

## Kiến trúc sau khi implement

```
createNewConnect(id, type)  [index.tis]
    │
    └── handler.check_access_blocking(id)   ← gọi Rust, BLOCK chờ kết quả
            │
            └── POST http://127.0.0.1:3000/api/check-access  [reqwest::blocking]
                    │
                    ├── Máy không trong data.json       → "" (allowed)
                    ├── Máy trong data.json, chưa login → "Bạn cần đăng nhập..."
                    ├── Máy trong data.json, đúng role  → "" (allowed)
                    ├── Máy trong data.json, sai role   → "Bạn không có quyền..."
                    └── server.js offline (timeout)     → "" (failopen)
    │
    ├── err == ""  → handler.set_remote_id + handler.new_remote  (kết nối)
    └── err != ""  → msgbox lỗi → dừng
```

---

## Files đã sửa

### `src/ui.rs`

**Thêm method `check_access_blocking`** (sau `fn new_remote`):
```rust
fn check_access_blocking(&mut self, rustdesk_id: String) -> String {
    use hbb_common::config::LocalConfig;
    let token = LocalConfig::get_option("access_token");
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(_) => return "".to_owned(),
    };
    let mut builder = client
        .post("http://127.0.0.1:3000/api/check-access")
        .json(&serde_json::json!({ "rustdesk_id": rustdesk_id }));
    if !token.is_empty() {
        builder = builder.header("Authorization", format!("Bearer {}", token));
    }
    match builder.send() {
        Ok(resp) => match resp.json::<serde_json::Value>() {
            Ok(v) => {
                if v["allowed"].as_bool().unwrap_or(true) {
                    return "".to_owned();
                }
                match v["reason"].as_str().unwrap_or("no_permission") {
                    "login_required" => "Bạn cần đăng nhập để kết nối máy này".to_owned(),
                    _ => "Bạn không có quyền truy cập máy này".to_owned(),
                }
            }
            Err(_) => "".to_owned(),
        },
        Err(_) => "".to_owned(), // server offline → failopen
    }
}
```

**Đăng ký trong `dispatch_script_call!`** (ngay sau `fn new_remote(String, String, bool);`):
```rust
fn check_access_blocking(String);
```

### `src/ui/index.tis`

**Sửa `createNewConnect()`** — thay httpRequest async bằng synchronous call:
```tis
function createNewConnect(id, type) {
    id = id.replace(/\s/g, "");
    app.remote_id.value = formatId(id);
    if (!id) return;
    var old_id = id;
    id = handler.handle_relay_id(id);
    var force_relay = old_id != id;
    if (id == my_id) {
        msgbox("custom-error", "Lỗi", "Bạn không thể kết nối đến máy tính của chính bạn");
        return;
    }
    var err = handler.check_access_blocking(id);
    if (err) {
        msgbox("custom-error", "Không có quyền truy cập", err);
        return;
    }
    handler.set_remote_id(id);
    handler.new_remote(id, type, force_relay);
}
```

### `server.js`

**Thêm endpoint `POST /api/check-access`** (trước `/api/address-books`):
- Không có token + máy trong data.json → `{ allowed: false, reason: "login_required" }`
- Có token + không có quyền → `{ allowed: false, reason: "no_permission" }`
- Máy không trong data.json → `{ allowed: true }`
- Log mỗi attempt: `[check-access] rustdesk_id=... roles=... allowed=...`

---

## Verification

| Kịch bản | Kết quả mong đợi |
|---|---|
| Chưa login → gõ ID máy trong data.json | Msgbox "Cần đăng nhập" + không kết nối |
| Chưa login → gõ ID máy KHÔNG trong data.json | Kết nối thành công |
| Đã login, có quyền → kết nối | Kết nối thành công |
| Đã login, không có quyền → gõ ID | Msgbox "Không có quyền" + không kết nối |
| server.js offline → gõ bất kỳ ID | Kết nối thành công (failopen, timeout 800ms) |

```bash
# Chạy:
node server.js &
cargo run
```

---

## Giới hạn

- **Client-side enforcement**: Người dùng dùng RustDesk client gốc (không phải ROCKY) vẫn bypass được.
- **Failopen**: Khi server.js offline, mọi kết nối đều cho qua. Đây là trade-off để không block user hợp lệ khi server restart.
- **Timeout 800ms**: Nếu server.js chậm > 800ms, sẽ failopen. Có thể tăng nếu cần strict hơn.
