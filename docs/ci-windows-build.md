# CI Build Windows .exe (`.github/workflows/build.yml`)

## Overview

Job `build-windows` trong `.github/workflows/build.yml` build bản Sciter (không Flutter) của RustDesk
client cho Windows x64 và đóng gói thành 1 file `.exe` tự giải nén (self-extracting installer) qua
GitHub Actions, trigger khi push/PR vào `main`/`master` hoặc chạy tay (`workflow_dispatch`).

File `.exe` cuối (`rustdesk-{version}-win7-install.exe`) chứa toàn bộ binary + `sciter.dll` + resource,
có thể copy/gửi sang máy Windows x64 khác chạy trực tiếp, không cần cài Rust/Python/vcpkg. File hiện
**chưa được ký số** (code signing) vì workflow không set biến `P`/cert.

Job `build-linux` trong cùng file **chưa được rà soát/sửa** trong quá trình này — out of scope.

## Key Files

| File | Vai trò |
|---|---|
| `.github/workflows/build.yml` | Workflow CI, job `build-windows` |
| `build.py` | Driver build chính (Python), nhánh `windows and not flutter` (~dòng 488-516) xử lý build + đóng gói Windows Sciter |
| `res/inline-sciter.py` | Nhúng (inline) toàn bộ `.tis`/`.css`/`.html` của `src/ui/` vào `src/ui/inline.rs` trước khi `cargo build` |
| `libs/portable/generate.py` | Sinh `data.bin` (metadata + dữ liệu nén brotli của thư mục `resources/`) rồi build crate `rustdesk-portable-packer` (self-extracting launcher) |
| `libs/portable/Cargo.toml` | Crate `rustdesk-portable-packer`, là **member của Cargo workspace gốc** → dùng chung `target/` ở workspace root |
| `libs/scrap/build.rs:50` | Hardcode triplet vcpkg cho Windows là `x64-windows-static` (không có `-md`) |
| `vcpkg.json` (root) | Manifest vcpkg, pin baseline commit `120deac3062162151622ca4860575a33844ba10b` |

## Flow

1. Checkout (submodules recursive) → Rust toolchain pin **1.75.0** → LLVM/Clang 15.0.6 → vcpkg
   (manifest mode, triplet `x64-windows-static`, `--x-install-root="$VCPKG_ROOT/installed"`).
2. `python build.py --portable`:
   - `res/inline-sciter.py` nhúng UI vào `src/ui/inline.rs`.
   - `external_resources()` tạo/dọn thư mục `resources/` (luôn tạo, không phụ thuộc cờ `--feature`).
   - `cargo build --release --features inline` → `target/release/rustdesk.exe` → rename thành
     `target/release/RustDesk.exe`.
   - Copy `RustDesk.exe` vào `resources/`.
   - `cd libs/portable && python3 generate.py -f ../../resources -o . -e ../../resources/RustDesk.exe`
     → ghi `data.bin`/`app_metadata.toml`, build crate `rustdesk-portable-packer` (output thật ở
     workspace-root `target/release/rustdesk-portable-packer.exe`, **không** ở trong `resources/`).
   - `mv ../../target/release/rustdesk-portable-packer.exe ../../rustdesk-{version}-win7-install.exe`
     → đặt file `.exe` cuối ở **repo root**.
3. `actions/upload-artifact@v4` upload `target/release/RustDesk.exe` và `rustdesk-*-win7-install.exe`.

## Change Log

- **2026-06-18 — Sửa job `build-windows` ban đầu (lỗi toolchain/vcpkg/artifact path).**
  File `build.yml` (thêm ở commit `95ed9b3e6`) dùng `toolchain: stable` (vỡ ABI Sciter từ Rust 1.78+,
  dự án luôn pin 1.75 cho Sciter), thiếu bước cài LLVM/Clang (cần cho `bindgen`), sai triplet vcpkg
  (`x64-windows-static-md` thay vì `x64-windows-static` mà `libs/scrap/build.rs:50` cần), cài vcpkg
  từng package thay vì manifest mode (bỏ qua baseline + 1 số package khác trong `vcpkg.json`), và
  artifact path sai hoàn toàn (`target/release/rustdesk.exe`, `target/release/rustdesk-portable.exe`
  — không khớp output thật của `build.py`). `actions/upload-artifact@v3` cũng đã bị GitHub sunset.
  → Pin Rust 1.75.0 (`dtolnay/rust-toolchain`), thêm LLVM/Clang 15.0.6, đổi sang `lukka/run-vcpkg@v11`
  + vcpkg manifest-mode install pin baseline, sửa artifact path thành
  `target/release/RustDesk.exe` + `rustdesk-*-win7-install.exe`, nâng `upload-artifact` lên `v4`.

- **2026-06-18 — Fix `res/inline-sciter.py`: `UnicodeDecodeError` trên Windows runner.**
  Mọi lệnh `open()` đọc `.tis`/`.css`/`.html` (trừ `common.tis`) không chỉ định `encoding`, nên trên
  Windows Python dùng codepage hệ thống (`cp1252`) thay vì UTF-8 → crash khi gặp byte UTF-8 (tiếng
  Việt) trong file include. → Thêm helper `read()` dùng `encoding='utf-8'` cho mọi lần đọc, và set
  `encoding='utf-8'` khi viết `src/ui/inline.rs`.

- **2026-06-18 — Fix `build.py:external_resources()`: thư mục `resources/` không được tạo.**
  Hàm chỉ tạo/dọn `res_dir` khi có cờ `--feature` (tải resource ngoài); `build.py --portable` gọi
  không kèm `--feature` nên hàm `return` sớm, không tạo `resources/`. Bước sau đó
  (`cp -rf target/release/RustDesk.exe resources`) tạo `resources` thành **1 file** (bản copy exe)
  thay vì thư mục → `generate.py` gọi `os.chdir('resources')` lỗi `NotADirectoryError`. → Chuyển
  logic tạo/dọn `res_dir` ra khỏi điều kiện `features`, luôn chạy trước.

- **2026-06-18 — Fix `build.py` dòng đóng gói installer cuối: sai tên file `-e` và sai đường dẫn `mv`.**
  `-e` truyền `rustdesk-{version}-win7-install.exe` (file không tồn tại trong `resources/`) thay vì
  file thực thi thật `RustDesk.exe`. Lệnh `mv` cuối tìm file installer trong `resources/`, nhưng
  `libs/portable` là member của Cargo workspace gốc nên output thật của crate
  `rustdesk-portable-packer` nằm ở `target/release/` tại workspace root, không phải trong
  `resources/` → `mv: cannot stat ... No such file or directory`. → Sửa `-e` thành
  `../../resources/RustDesk.exe`; sửa `mv` lấy từ `../../target/release/rustdesk-portable-packer.exe`
  và đặt tên lại thành `rustdesk-{version}-win7-install.exe` ở repo root.
  **Trạng thái: đã sửa, chưa có lần chạy CI nào xác nhận thành công hoàn toàn end-to-end** — lần chạy
  gần nhất dừng ở đúng lỗi này; cần chạy lại để verify.
