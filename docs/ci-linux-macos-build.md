# CI: Linux & macOS Sciter build (`build.yml`)

## Overview

`.github/workflows/build.yml` có 3 job độc lập, build bản Sciter (không Flutter) của
RustDesk: `build-windows` (xem `docs/ci-windows-build.md`), `build-linux`, `build-macos`.
Job `build-linux` trước đây chỉ apt-get vài dev package rồi gọi `build.py` — **không thể
build được** vì thiếu `VCPKG_ROOT` (xem Flow). Job `build-macos` không tồn tại, đã được
thêm mới.

## Key Files

| File | Vai trò |
|---|---|
| `.github/workflows/build.yml` | Job `build-linux`, `build-macos` |
| `build.py` | Driver build chính; nhánh Linux/macOS không-Flutter ở cuối `main()` (~dòng 604-635 cho deb, ~564-603 cho dmg) |
| `libs/scrap/build.rs` | `find_package()` quyết định lấy `libvpx`/`libyuv`/`opus`/`aom` từ đâu — vcpkg (`VCPKG_ROOT`) trừ khi feature `linux-pkg-config` được bật, nếu không có cả hai thì rơi vào fallback homebrew (panic trên Linux) |
| `res/DEBIAN/` | Scriptlet cài đặt deb (`preinst`/`postinst`/`prerm`/`postrm`), không có `control` (control file do `cargo-bundle` sinh từ `[package.metadata.bundle]` trong `Cargo.toml`) |
| `res/pam.d/rustdesk.debian` | PAM config copy vào deb |
| `appimage/AppImageBuilder-x86_64.yml` | Recipe cho `appimage-builder`, đọc trực tiếp file `rustdesk.deb` đã build |

## Flow

### Linux (`build-linux`)
1. Cài toolchain Rust **pin 1.75.0** (giống Windows — cùng giới hạn ABI Sciter, xem
   `docs/ci-windows-build.md`).
2. Cài hệ thống deps qua apt (build tool, X11/GTK/PAM/gstreamer dev headers).
3. Setup vcpkg + `vcpkg install --triplet x64-linux` — cấp `libvpx`/`libyuv`/`opus`/`aom`/`ffmpeg`
   qua `VCPKG_ROOT`, **bắt buộc** vì `build.rs` panic nếu thiếu (xem Key Files).
4. `cargo install cargo-bundle` — `build.py`'s nhánh Linux gọi `cargo bundle` để tạo
   `target/release/bundle/deb/rustdesk*.deb` ban đầu (control file tự sinh từ `Cargo.toml`).
5. Tải `libsciter-gtk.so` (runtime engine UI, không có trên Linux qua apt) về thư mục gốc repo.
6. `python3 build.py --hwcodec` — build.py mở deb từ bước 4 (`dpkg-deb -R`), ghép thêm
   icon/desktop file/systemd unit/scriptlet PAM, strip binary, đóng `libsciter-gtk.so` vào
   `tmpdeb/usr/share/rustdesk/`, repack thành `rustdesk-{version}.deb`.
7. Đóng gói thêm `.AppImage` qua `appimage-builder` (cài từ fork `rustdesk-org/appimage-builder`),
   dùng `appimage/AppImageBuilder-x86_64.yml` — recipe này tự giải nén `rustdesk.deb` đã build
   ở bước 6 thành `AppDir`, không cần thao tác gì thêm.

### macOS (`build-macos`, mới thêm)
1. Cài toolchain Rust **pin 1.75.0** — cùng giới hạn ABI Sciter như Windows/Linux (i128 layout
   đổi từ Rust 1.78+ làm vỡ `sciter-rs` đã pin).
2. `brew install nasm yasm ninja create-dmg` — cần cho build native lib qua vcpkg (`aom`/`ffmpeg`)
   và đóng gói `.dmg`.
3. Setup vcpkg + `vcpkg install` (không cần `--triplet`, `libs/scrap/build.rs` tự suy ra
   `x64-osx`/`arm64-osx` theo kiến trúc runner).
4. Cài `cargo-bundle` bằng toolchain `stable` riêng (`rustup run stable cargo install ...`,
   xem Change Log), tải `libsciter.dylib`.
5. `python3 build.py` — nhánh macOS không-Flutter của `build.py` (đã có sẵn, không sửa):
   `cargo bundle` → `target/release/bundle/osx/RustDesk.app`, copy `libsciter.dylib` vào
   `Contents/MacOS/`, `create-dmg` ra `rustdesk-{version}.dmg`. Không ký code (biến môi trường
   `P` — cert pass — không được set trong CI nên `build.py` tự bỏ qua bước codesign).

## Change Log

- **2026-06-20 — Thêm packaging Linux + macOS vào `build.yml`.**
  - Sửa 2 bug đường dẫn sai trong `build.py` (nhánh Linux deb, ~dòng 626-628): code đọc
    `DEBIAN/` và `pam.d/` ở **repo root** nhưng các file này chỉ tồn tại dưới `res/DEBIAN/`
    và `res/pam.d/` → packaging deb luôn fail thiếu scriptlet trước khi sửa.
  - `build-linux` job cũ: dùng `actions-rs/toolchain@v1` với `toolchain: stable` (vỡ ABI
    Sciter từ Rust 1.78+, xem `docs/ci-windows-build.md`), không setup vcpkg (code Rust
    `panic!` ngay khi thiếu `VCPKG_ROOT` trên Linux), không tải `libsciter-gtk.so`, và
    artifact path `target/debian/*.deb`/`*.AppImage` không khớp với output thật của
    `build.py` (`./rustdesk-{version}.deb` ở repo root, không có AppImage nào được build).
    Tất cả các điểm trên đã được sửa.
  - `actions/upload-artifact@v3` (đã bị GitHub sunset) → nâng lên `@v4`.
  - `build-macos` job hoàn toàn mới — upstream RustDesk **không có CI job build Sciter cho
    macOS** (chỉ có Flutter macOS, xem `build-for-macOS` trong `flutter-build.yml`), nên job
    này được viết dựa trên nhánh `build.py` osx không-Flutter sẵn có (chưa từng chạy qua CI).

- **2026-06-20 — Fix `cargo install cargo-bundle`: lỗi `feature edition2024 is required`.**
  `cargo install` chạy bằng cargo của toolchain **1.75.0** (pin cho Sciter ABI). Bản mới nhất
  của `cargo-bundle` trên crates.io (0.11.0) khai báo `edition = "2024"` trong `Cargo.toml` —
  cargo 1.75 không parse được edition này (cần cargo ≥1.85, ổn định ở Rust 1.85). Lỗi xảy ra ở
  cả `build-linux` và `build-macos` vì cả hai đều pin `1.75.0` làm toolchain mặc định. → Cài
  thêm toolchain `stable` riêng (`rustup toolchain install stable --profile minimal`) chỉ để
  build/install binary `cargo-bundle` (`rustup run stable cargo install cargo-bundle --locked`);
  binary này không phụ thuộc ABI Sciter — nó chỉ là tool đóng gói, khi chạy `cargo bundle ...`
  sau đó nó vẫn shell-out gọi `cargo build` bằng toolchain **mặc định đang active lúc đó**
  (vẫn là 1.75.0, vì `rustup run stable` chỉ override cho đúng 1 lệnh `install`, không đổi
  default của job).

- **2026-06-20 — Fix AppImage step: `tar: ./data.tar.xz: Cannot open: No such file or directory`.**
  Lỗi nằm ở job **`build-linux`** (bước "Build AppImage"), không liên quan `build-macos` —
  job macOS không build `.deb`/AppImage, chỉ ra `.dmg`. Nguyên nhân: `appimage/AppImageBuilder-
  x86_64.yml` và `-aarch64.yml` hardcode `bsdtar -zxvf rustdesk.deb` rồi `tar -xvf
  ./data.tar.xz`, nhưng lệnh đóng deb ở `build.py:634` (`dpkg-deb -b tmpdeb rustdesk.deb`) không
  chỉ định `-Z<type>` nên dùng compression **mặc định** của `dpkg-deb` trên runner — mặc định
  này đã đổi thành **zstd** (`control.tar.zst`/`data.tar.zst`) trên Ubuntu runner hiện tại, lệch
  với phần mở rộng `.xz` mà recipe AppImageBuilder giả định cứng. → Pin compression về xz tại
  đúng 1 điểm build deb đang dùng (`build.py:634`, nhánh Sciter Linux không-Flutter — 2 lệnh
  `dpkg-deb -b` còn lại ở `build.py:360`/`397` là Flutter-only, ngoài scope):
  `dpkg-deb -Zxz -b tmpdeb rustdesk.deb`. Không cần sửa các file recipe `AppImageBuilder-*.yml`.
