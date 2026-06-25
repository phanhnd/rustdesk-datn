# RustDesk — Giải thích mã nguồn: là gì, cấu trúc, vận hành, vì sao thiết kế vậy, và cách triển khai/mở rộng

> Tài liệu này giải thích **lõi RustDesk** (không phải phần ROCKY tự thêm — xem `CLAUDE.md` và
> `docs/admin-ui.md`/`docs/address-book.md`/`docs/keycloak.md` cho phần đó) để bất kỳ ai đọc
> source lần đầu cũng hiểu được: nó là gì, cấu trúc ra sao, chạy như thế nào, vì sao thiết kế như
> vậy, và làm sao để build/tự host/mở rộng. Mọi khẳng định kỹ thuật trong tài liệu đều được đối
> chiếu trực tiếp với source code thật (không suy diễn từ tài liệu marketing), trích dẫn kèm
> đường dẫn file:dòng để tự kiểm tra lại.
>
> **Phạm vi:** repo này chỉ dùng bản UI **Sciter** (`src/ui/`). Bản Flutter
> (`flutter/`, `src/flutter.rs`, `src/flutter_ffi.rs`, `src/bridge_generated.rs`) tồn tại trong
> repo (upstream RustDesk hỗ trợ cả 2) nhưng **ngoài phạm vi** làm việc của project này — tài liệu
> này nhắc tới Flutter chỉ để so sánh, không hướng dẫn sửa nó.

---

## 1. RustDesk là gì

### 1.1. Định nghĩa

RustDesk là phần mềm **điều khiển máy tính từ xa (remote desktop)** mã nguồn mở, tương tự
TeamViewer/AnyDesk, viết chủ yếu bằng **Rust**. Một máy chạy RustDesk có thể đóng 1 trong 2 vai
trò (hoặc cả hai, tùy lúc):

- **Controller** ("máy điều khiển") — người dùng ngồi ở đây, xem màn hình và gửi input tới máy
  kia.
- **Controlled peer** ("máy bị điều khiển") — máy chia sẻ màn hình, nhận input, cho phép file
  transfer/clipboard sync.

Khác với VNC (thường cần port-forward NAT tay) hay TeamViewer/AnyDesk (bắt buộc dùng server của
hãng), RustDesk **tách rõ 3 vai trò hạ tầng** và cho phép **tự host toàn bộ**:

| Vai trò | Thành phần | Có source trong repo này? |
|---|---|---|
| Client (controller + controlled peer) | binary `rustdesk` (chính repo này) | ✅ Có |
| Rendezvous server ("hbbs") — môi giới, NAT traversal | repo riêng `rustdesk/rustdesk-server` | ❌ Không — dùng image/binary chính thức |
| Relay server ("hbbr") — chuyển tiếp traffic khi không punch-hole được | cùng repo `rustdesk-server` | ❌ Không |

Vì hbbs/hbbr có thể tự host (Docker image `rustdesk/rustdesk-server` hoặc dùng server công khai
`rs-ny.rustdesk.com` của nhóm RustDesk), tổ chức có thể vận hành một hệ thống remote-desktop
**hoàn toàn nội bộ, không phụ thuộc bên thứ ba** — đây chính là tiền đề để đồ án ROCKY xây thêm
lớp SSO/RBAC riêng trên nền tảng này (xem `docs/keycloak.md`).

### 1.2. Vì sao chọn RustDesk (so với tự viết / dùng giải pháp khác)

- **Đã có sẵn toàn bộ phần khó nhất** của 1 hệ remote-desktop: NAT traversal (hole punching),
  fallback relay, mã hóa end-to-end, codec video/audio hiệu năng cao (libvpx/libyuv/opus), input
  injection đa nền tảng — tự viết lại từ đầu tốn hàng năm công.
  *Bằng chứng cụ thể, không phải ước lượng chủ quan:* riêng phần lõi Rust (loại bản dịch) đã
  **108.628 dòng**, 543 `impl` block, ~3.023 hàm (đo trực tiếp trên source, xem
  `baocao2306.md` mục 5) — phản ánh đúng độ phức tạp thật của một hệ remote-desktop hoàn chỉnh.
- **Tự host được 100%** (client + hbbs + hbbr) — không khóa vào hạ tầng của 1 hãng, phù hợp yêu
  cầu "remote desktop nội bộ, kiểm soát được" của đồ án.
- **Có 2 bộ UI** (Flutter đa nền tảng hơn, hỗ trợ mobile; Sciter nhẹ hơn, binary nhỏ, build
  nhanh, ít dependency native hơn) — đồ án chọn nhánh Sciter vì mục tiêu là desktop
  Windows/Linux/macOS, không cần mobile, và muốn binary/installer gọn.
- **Giấy phép mã nguồn mở** (AGPL-3.0, xem `LICENCE`) cho phép fork, sửa, tự host, tự đóng gói —
  đúng nhu cầu rebrand + chèn thêm logic phân quyền của đồ án.

---

## 2. Cấu trúc mã nguồn cơ bản

### 2.1. Sơ đồ thư mục cấp cao

```
rustdesk/
├── src/                  ← Rust: toàn bộ logic ứng dụng (client + server + UI glue)
│   ├── ui/                  Sciter UI (HTML/TIS/CSS) — phạm vi đồ án
│   ├── client/ , client.rs   Logic phía "máy điều khiển"
│   ├── server/ , server.rs   Logic phía "máy bị điều khiển"
│   ├── platform/             Code đặc thù OS (Windows/Linux/macOS/Android/iOS)
│   ├── ipc/ , ipc.rs          Giao tiếp giữa các tiến trình con của cùng 1 app
│   ├── lang/                 Bản dịch UI (1 file/ngôn ngữ)
│   ├── rendezvous_mediator.rs Giao tiếp với hbbs (đăng ký, punch-hole, relay)
│   ├── hbbs_http/            Gọi REST API của hbbs (không qua protocol nhị phân)
│   ├── core_main.rs           Phân giải CLI args → chọn "mode" chạy
│   ├── main.rs, service.rs, naming.rs   3 binary riêng (xem mục 3.1)
│   └── flutter*.rs, bridge_generated.rs  Bản Flutter — NGOÀI phạm vi đồ án
├── libs/
│   ├── hbb_common/           Dùng chung mọi nơi: config, protobuf, network, mã hóa
│   │   └── protos/             message.proto, rendezvous.proto — "ngôn ngữ" giao tiếp
│   ├── scrap/                 Chụp màn hình đa nền tảng (X11/Wayland/WinAPI/CoreGraphics)
│   ├── enigo/                  Giả lập bàn phím/chuột đa nền tảng
│   ├── clipboard/              Đồng bộ clipboard (kể cả file)
│   ├── virtual_display/        Tạo màn hình ảo (Windows)
│   ├── remote_printer/         In từ xa
│   └── portable/               Đóng gói installer self-extracting (Windows)
├── flutter/               UI Flutter — NGOÀI phạm vi đồ án
├── res/                   Icon, file cấu hình hệ thống (systemd, DEBIAN scriptlet, PAM)
├── build.py               Driver build/đóng gói chính (Python)
└── .github/workflows/     CI: build & đóng gói cho Windows/Linux/macOS
```

### 2.2. `libs/hbb_common` — lớp dùng chung quan trọng nhất

Mọi thành phần (client lúc là controller, client lúc là controlled peer, và cả `rendezvous_mediator.rs`)
đều phụ thuộc `hbb_common`. Các file đáng chú ý:

| File | Vai trò |
|---|---|
| `config.rs` (4.016 dòng) | Toàn bộ struct cấu hình: `Config`, `LocalConfig`, `Ab`/`AbEntry`/`AbPeer` (Address Book), `APP_NAME` |
| `protos/message.proto` | Định nghĩa **mọi message trao đổi giữa 2 peer đã kết nối** (video frame, mouse/keyboard event, clipboard, file transfer, login...) — gốc của `Message` |
| `protos/rendezvous.proto` | Định nghĩa **message trao đổi với hbbs** (đăng ký, punch hole, relay request...) — gốc của `RendezvousMessage` |
| `password_security.rs` | Mã hóa/giải mã payload bằng `secretbox` (XSalsa20-Poly1305, thư viện `sodiumoxide`) |
| `tcp.rs`, `udp.rs`, `stream.rs`, `socket_client.rs` | Wrapper transport — quyết định connect trực tiếp (TCP/UDP) hay qua relay, có hỗ trợ cả KCP và WebSocket |
| `fs.rs` | Logic file transfer (đọc/ghi theo chunk, digest) |

`message.proto`/`rendezvous.proto` được biên dịch (qua `protobuf-codegen`, gọi trong `build.rs`
của `hbb_common`) thành Rust struct lúc build — **đây chính là hợp đồng (contract) giao tiếp**:
muốn thêm 1 loại dữ liệu mới trao đổi giữa 2 máy, việc đầu tiên luôn là sửa file `.proto`.

### 2.3. `src/` — vai trò từng nhóm file

| Nhóm | File chính | Vai trò |
|---|---|---|
| Entry point | `main.rs` → `core_main.rs` | Đọc CLI args, quyết định chạy mode nào (xem mục 3.1) |
| Phía controller | `client.rs`, `client/io_loop.rs`, `client/helper.rs` | Tạo `Session`, bắt tay bảo mật, giải mã video, vòng lặp đọc/ghi message |
| Phía controlled peer | `server.rs`, `server/connection.rs`, `server/*_service.rs` | Nhận kết nối, stream video/audio, nhận input, đồng bộ clipboard |
| Rendezvous | `rendezvous_mediator.rs`, `hbbs_http/` | Đăng ký định kỳ với hbbs, xử lý punch-hole/relay, đồng bộ sysinfo |
| UI glue (Sciter) | `ui.rs`, `ui_interface.rs`, `ui_session_interface.rs`, `ui_cm_interface.rs` | Cầu nối Rust ↔ Sciter (xem `CLAUDE.md` mục "Rust ↔ Sciter Communication") |
| Nền tảng | `platform/{windows,linux,macos}.rs` | API hệ điều hành: elevation, input injection, enumerate display, session detection |
| IPC nội bộ | `ipc.rs`, `ipc/` | Giao tiếp giữa tiến trình UI và tiến trình `--server` (named pipe Windows / Unix socket Linux-macOS) |
| Tự host config | `naming.rs`, `custom_server.rs` | "Bake" cấu hình hbbs/hbbr/api tự host vào chính file thực thi (xem mục 4.4) |

---

## 3. Vận dụng / vận hành như thế nào

### 3.1. Một binary, nhiều "mode" — phân biệt bằng CLI flag

RustDesk **không** build ra nhiều binary riêng cho từng vai trò. Cùng 1 file thực thi
`rustdesk`/`RustDesk.exe` tự nhận diện vai trò qua argument đầu tiên (`src/core_main.rs:394,377,709`,
`src/common.rs:104,108`):

| Flag | Vai trò tiến trình | Khi nào được spawn |
|---|---|---|
| *(không có arg)* | Cửa sổ chính — danh sách peer, Address Book, Settings | User double-click icon |
| `--server` | **Tiến trình nền** — đăng ký với hbbs, chạy các service (video/audio/input/clipboard), nhận kết nối tới — chạy được **không cần ai đăng nhập** (Windows session 0) | Lúc cài đặt (đăng ký thành Windows Service / systemd unit `res/rustdesk.service`), hoặc tự khởi động cùng app |
| `--tray` | Icon system tray | `core_main.rs` tự `run_me(["--tray"])` nếu phát hiện có `--server` đang chạy mà chưa có tray |
| `--cm` / `--cm-no-ui` | **Connection Manager** — cửa sổ hiện ra phía máy bị điều khiển khi có người kết nối vào (cho phép chấp nhận/từ chối, xem ai đang điều khiển) | `--server` tự spawn khi có kết nối tới |
| `--connect <id>` (và `--play`/`--file-transfer`/`--view-camera`/`--port-forward`) | Cửa sổ phiên điều khiển từ xa tới 1 peer cụ thể | User bấm Connect, hoặc gọi từ dòng lệnh |

**Vì sao thiết kế 1 binary nhiều mode thay vì nhiều binary riêng** (xem mục 4.2) — tóm tắt: đơn
giản hóa phân phối/update (chỉ 1 file cần ký số, cần cài), và các mode vẫn cần dùng lại rất nhiều
code chung (transport, mã hóa, protobuf).

### 3.2. Luồng kết nối đầy đủ — từ bấm "Connect" tới hiển thị màn hình từ xa

```
[Máy A — controller]                [hbbs — rendezvous]              [Máy B — controlled, "--server"]
       │                                    │                                    │
       │  (định kỳ, mọi máy chạy --server đều làm bước này)                       │
       │                                    │◀── RegisterPeer/RegisterPk ─────── │  B tự đăng ký ID + public key
       │                                    │                                    │
User bấm Connect tới ID của B               │                                    │
       │── PunchHoleRequest(B.id) ─────────▶│                                    │
       │                                    │── PunchHole(A.addr) ──────────────▶│  B thử kết nối thẳng tới A
       │◀─────────── PunchHoleResponse ─────│ (kèm địa chỉ B + relay_server dự phòng)
       │                                    │                                    │
  ┌────┴─── Thử kết nối trực tiếp (UDP/TCP hole-punched) ─────────────────┐       │
  │ Thành công?──Có──▶ dùng kênh trực tiếp (peer-to-peer thật)            │       │
  │      │                                                                 │       │
  │      └─Không──▶ RequestRelay → cả 2 bên cùng nối tới hbbr, hbbr chỉ   │       │
  │                  forward byte thô, KHÔNG giải mã được nội dung        │       │
  └─────────────────────────────────────────────────────────────────────┘       │
       │                                                                         │
       │═══ secure_connection handshake (xem mục 3.3) — bất kể trực tiếp hay relay ═══│
       │                                                                         │
       │◀══════════ kênh đã mã hóa end-to-end bằng khóa phiên (symmetric key) ══▶│
       │── LoginRequest (password/token) ─────────────────────────────────────▶│
       │◀───────────────────────────────────── LoginResponse + PeerInfo ───────│
       │◀───────────────────────────────────── VideoFrame (H264/VP9/...) ──────│  video_service.rs capture qua libs/scrap
       │── MouseEvent / KeyEvent ──────────────────────────────────────────────▶│  input_service.rs replay qua libs/enigo
       │◀──────────────────────────────────────────────── Clipboard ──────────▶│
```

Điểm quan trọng: **hbbs chỉ tham gia ở giai đoạn môi giới** (đăng ký, tìm địa chỉ, quyết định
punch-hole hay relay) — sau khi 2 máy đã có kênh truyền (trực tiếp hoặc qua hbbr), hbbs **không
còn liên quan gì tới luồng dữ liệu thật** (video/input/clipboard/file).

### 3.3. Bắt tay bảo mật (`secure_connection`, `src/client.rs:758-829`)

Đây là phần lý giải vì sao relay (hbbr) **không đọc được nội dung phiên** dù mọi byte đi qua nó:

1. Khi đăng ký với hbbs, mỗi peer có 1 cặp khóa ký (Ed25519, `sign::PublicKey`); hbbs **ký**
   (sign) gói `id + public_key` của peer đó bằng khóa riêng của chính hbbs.
2. Khi A muốn kết nối B, A nhận về `signed_id_pk` của B (đã được hbbs ký) → A tự verify chữ ký
   bằng **public key của hbbs** (`config::RS_PUB_KEY`, hoặc khóa tùy chỉnh truyền qua `--key`) →
   nếu hợp lệ, A tin rằng "public key này đúng là của B" (không bị ai mạo danh ID).
3. A và B sau đó tự trao đổi **khóa phiên đối xứng** (`create_symmetric_key_msg`, mã hóa bằng
   asymmetric box dùng đúng public key đã verify ở bước 2) — khóa này **chỉ 2 đầu A/B biết**,
   không bao giờ gửi cho hbbs/hbbr.
4. Từ đây, mọi `Message` protobuf giữa A↔B được mã hóa bằng `secretbox` (XSalsa20-Poly1305) với
   khóa phiên đó (`conn.set_key(key)`).

⇒ **hbbs là "trust anchor"** (chỉ ký, không tham gia mã hóa dữ liệu thật); **hbbr là "ống dẫn mù"**
(chỉ forward byte đã mã hóa, không có khóa để đọc). Đây là lý do tách 2 server riêng (mục 4.1).

### 3.4. IPC nội bộ — vì sao UI process và `--server` process tách nhau

Trên Windows, tiến trình `--server` cần chạy với quyền cao (SYSTEM, để hoạt động cả khi chưa ai
đăng nhập — session 0), còn cửa sổ UI chính chạy với quyền user thường. 2 tiến trình này giao
tiếp qua **named pipe** (Windows) hoặc **Unix domain socket** (Linux/macOS) — code trong
`src/ipc.rs`/`src/ipc/`. UI gửi lệnh (đổi setting, lấy trạng thái) qua kênh này; `--server`
không bao giờ tự vẽ UI.

---

## 4. Tại sao lại thiết kế như vậy

### 4.1. Vì sao tách riêng hbbs (rendezvous) và hbbr (relay)

- **hbbs phải chịu tải đăng ký từ mọi client** (mọi máy chạy `--server` đăng ký định kỳ) nhưng
  **không** cần xử lý băng thông video/audio — tách riêng để hbbs nhẹ, scale theo *số lượng máy*,
  còn hbbr chỉ scale theo *số phiên đang relay* (ít hơn nhiều, vì phần lớn kết nối punch-hole
  thành công, không cần relay).
- **Bảo mật theo nguyên tắc tối thiểu hóa lộ diện (least exposure)**: hbbs giữ khóa ký (trust
  anchor, nhạy cảm) nhưng không bao giờ thấy dữ liệu phiên; hbbr thấy traffic (đã mã hóa) nhưng
  không giữ khóa nào quan trọng. Một bên bị compromise không tự động lộ luôn dữ liệu phiên thật.
- Cho phép **tự host độc lập từng phần** — ví dụ đặt hbbr ở nhiều vùng địa lý để giảm latency
  relay, trong khi chỉ cần 1 hbbs trung tâm.

### 4.2. Vì sao 1 binary nhiều mode (không phải nhiều file thực thi riêng)

- Các mode dùng chung rất nhiều logic (transport mã hóa, protobuf, cấu hình) — tách binary riêng
  sẽ phải duplicate code hoặc tách thêm 1 crate dùng chung phức tạp hơn.
- Đóng gói/phân phối/ký số (code signing) chỉ cần làm cho **1 file** — quan trọng với Windows vì
  mỗi binary chưa ký số đều bị cảnh báo SmartScreen/AV.
- Cập nhật (auto-update) chỉ cần thay 1 file.
- Đánh đổi: `core_main.rs` phải tự phân giải arg để biết "mình là ai" — code dispatch ban đầu hơi
  rậm, nhưng đổi lại vận hành/phân phối đơn giản hơn nhiều.

### 4.3. Vì sao dùng Protocol Buffers (protobuf) cho giao thức, không dùng JSON

- **Hiệu năng**: video/input event cần gửi liên tục với tần suất cao (30-60 lần/giây) — protobuf
  nhị phân nhỏ gọn hơn JSON nhiều lần, quan trọng khi băng thông hạn chế (mạng di động, relay).
- **Versioning có cấu trúc**: thêm field mới vào `.proto` không phá vỡ client cũ (field number
  giữ nguyên, field mới optional) — cho phép client/server nâng cấp độc lập, không cần đồng bộ
  version tuyệt đối.
- **Cross-language**: hbbs/hbbr (Rust, repo khác) và client (Rust, repo này) dùng chung định nghĩa
  `.proto`, generate code tự động, tránh lệch struct tay.

### 4.4. Vì sao có cơ chế "bake" config vào tên file (`naming.rs`/`custom_server.rs`)

Khi tự host hbbs/hbbr (không dùng server công khai của RustDesk), người dùng cuối thường không
muốn tự tay nhập IP/key server sau khi cài. RustDesk giải quyết bằng cách: binary `naming` mã hóa
4 giá trị (`key`, `host` hbbs, `api` url, `relay` host) thành 1 chuỗi, **nhúng ngay vào tên file**
thực thi (`rustdesk-custom_serverd-{chuỗi}.exe`); lúc khởi động, `custom_server.rs` tự đọc lại
tên file của chính nó (argv[0]) để biết phải kết nối server nào — **không cần file config riêng,
không cần người dùng nhập gì**. Đây là lý do tài liệu/kế hoạch đóng gói self-host của ROCKY
(`.claude/plans/optimize-and-package.md`) dự định dùng đúng cơ chế này để client cài xong tự trỏ
về gateway/hbbs nội bộ.

### 4.5. Vì sao chọn Sciter cho nhánh UI mà đồ án dùng (so với Flutter)

| | Sciter (đồ án dùng) | Flutter (ngoài phạm vi) |
|---|---|---|
| Kích thước binary/installer | Nhỏ hơn nhiều (không nhúng engine Dart/Skia) | Lớn hơn |
| Cross-platform mobile | Không | Có (Android/iOS) |
| Ngôn ngữ UI | HTML/CSS + TIS (JS-like riêng của Sciter) | Dart |
| Tích hợp Rust | `dispatch_script_call!` macro, gọi hàm trực tiếp | FFI qua `flutter_rust_bridge` (sinh code phức tạp hơn) |
| Phù hợp khi | Chỉ cần desktop, muốn build/đóng gói gọn, không cần ecosystem Flutter | Cần đa nền tảng kể cả mobile |

Đồ án chỉ cần desktop nội bộ (Windows/Linux/macOS), nên chọn Sciter để: build nhanh hơn, installer
nhỏ hơn, và lớp cầu nối Rust↔UI đơn giản hơn để chèn thêm hàm tùy biến (`check_access_blocking`,
xem `docs/address-book.md`).

### 4.6. Vì sao pin Rust 1.75.0 (không dùng `stable` mới nhất) — đánh đổi đã chấp nhận

Crate `sciter-rs` (binding Rust cho Sciter) được build/pin từ thời Rust 1.75 trở về trước. Từ Rust
1.78, layout ABI của kiểu `i128` thay đổi, làm vỡ tương thích binary với `sciter-rs` đã pin —
**đây là cái giá phải trả để dùng Sciter**: không thể tận dụng tính năng/tối ưu của Rust bản mới
nhất cho riêng phần build Sciter (Flutter build không bị giới hạn này). Toàn bộ CI (`build.yml`)
3 job Windows/Linux/macOS đều pin đúng `1.75.0` vì lý do này (xem `docs/ci-windows-build.md`).

### 4.7. Vì sao dùng vcpkg cho codec (libvpx/libyuv/opus/aom) thay vì pure-Rust

Codec video/audio hiệu năng cao (encode/decode H264/VP9/AV1, resample audio) chủ yếu chỉ có
implementation chất lượng production ở dạng thư viện C/C++ lâu năm (libvpx của Google, libyuv,
aom). Viết lại bằng Rust thuần sẽ tốn công lớn và khó đạt hiệu năng tương đương phần cứng-tối-ưu
đã có. vcpkg được dùng để quản lý build các thư viện C/C++ này nhất quán trên cả 3 OS, thay vì
mỗi máy dev tự cài theo cách khác nhau.

---

## 5. Hướng dẫn: hiểu, triển khai và mở rộng

### 5.1. Build nhanh (môi trường phát triển)

```sh
# Cài Rust 1.75 + dependency hệ thống (xem CLAUDE.md mục "Linux system dependencies")
cargo build               # debug build
cargo run --release       # release build, tự link sciter runtime tải sẵn trong target/
cargo test                # chạy test
cargo clippy              # lint
```

Build ra `librustdesk` (cdylib/staticlib/rlib) + binary `rustdesk` (bin chính), `naming`,
`service` (2 bin phụ — xem `Cargo.toml` mục `[[bin]]`).

### 5.2. Tự host hbbs/hbbr (không phụ thuộc server công khai)

```sh
docker run --name hbbs -p 21115:21115 -p 21116:21116 -p 21116:21116/udp -p 21117:21117 \
  -v $(pwd)/hbbs-data:/root rustdesk/rustdesk-server hbbs

docker run --name hbbr -p 21117:21117 -p 21119:21119 \
  -v $(pwd)/hbbr-data:/root rustdesk/rustdesk-server hbbr
```

Sau khi chạy, hbbs sinh ra 1 cặp khóa (`id_ed25519.pub`) — chuỗi public key này chính là giá trị
`--key` mà client cần biết để verify chữ ký ở bước 2 mục 3.3. Có 2 cách trỏ client về server tự
host:
1. **Tay**: Settings → Network → ID/Relay Server, điền host hbbs/hbbr + key.
2. **Bake sẵn vào installer** (khuyến nghị khi phân phối cho nhiều máy): dùng binary `naming`
   (mục 4.4) để sinh file thực thi đã nhúng cấu hình, người dùng chỉ cần chạy, không cần nhập gì.

### 5.3. Build/đóng gói qua CI cho 3 nền tảng

Repo đã có sẵn `.github/workflows/build.yml` với 3 job độc lập (xem chi tiết từng job ở
`docs/ci-windows-build.md` và `docs/ci-linux-macos-build.md`):

| Nền tảng | Output | Trigger |
|---|---|---|
| Windows | `rustdesk-{version}-win7-install.exe` (installer tự giải nén) | push/PR vào `main`, hoặc `workflow_dispatch` |
| Linux | `.deb` + `.AppImage` | nt |
| macOS | `.dmg` | nt |

### 5.4. Các điểm mở rộng (extension point) thường dùng khi modify

| Muốn làm gì | Sửa ở đâu |
|---|---|
| Thêm 1 hàm mới gọi được từ Sciter UI | Thêm method vào `impl UI` (`src/ui.rs`), đăng ký tên hàm vào block `sciter::dispatch_script_call! { ... }` cùng file, gọi từ TIS qua `handler.tenHam(...)` |
| Thêm 1 loại dữ liệu mới trao đổi giữa 2 peer đã kết nối | Sửa `libs/hbb_common/protos/message.proto` (thêm `message`/field), build lại — `build.rs` của `hbb_common` tự gọi `protobuf-codegen` sinh Rust struct |
| Thêm 1 loại dữ liệu mới trao đổi với hbbs (signaling) | Sửa `libs/hbb_common/protos/rendezvous.proto` tương tự |
| Thêm 1 service nền mới phía controlled-peer (ví dụ: thêm 1 kênh dữ liệu định kỳ) | Thêm file `src/server/<ten>_service.rs`, theo mẫu `audio_service.rs`/`video_service.rs` (mỗi service là 1 task async riêng, đăng ký vào `server.rs`) |
| Thêm logic đặc thù 1 OS | `src/platform/{windows,linux,macos}.rs` — giữ cùng tên hàm ở cả 3 file để code gọi chung không cần `#[cfg(...)]` rải khắp nơi |
| Thêm bước kiểm tra/chặn trước khi kết nối (như `check_access_blocking` của ROCKY) | Thêm hàm đồng bộ (blocking) trong `impl UI` (`src/ui.rs`), gọi từ `index.tis::createNewConnect()` **trước** khi gọi `new_remote()` — xem `docs/address-book.md` làm ví dụ thật đã triển khai |
| Thêm logic ngoài Rust (auth, quản trị, tích hợp hệ thống khác) | Viết service riêng (như `server.js` của ROCKY), giao tiếp với Rust qua HTTP — **không** nhúng logic nghiệp vụ ngoài vào core Rust, giữ core sạch để dễ rebase/nâng cấp lên upstream sau này |

### 5.5. Lưu ý quan trọng khi modify (tránh phá vỡ tương thích)

1. **Không đổi field number đã tồn tại trong `.proto`** — phá wire compatibility với mọi client
   cũ đang chạy ngoài kia (nếu có) và với hbbs/hbbr (định nghĩa proto phải khớp 2 phía).
2. **Không nâng Rust toolchain vượt 1.77** cho nhánh Sciter (xem mục 4.6) — `sciter-rs` sẽ vỡ ABI.
3. **`--server` process không được block lâu** (I/O đồng bộ, sleep dài) — nó phải tiếp tục phục vụ
   các service khác (video/input) song song; logic chặn-đồng-bộ kiểu `check_access_blocking` của
   ROCKY cố tình đặt **timeout ngắn (800ms)** chính vì lý do này.
4. **Giữ tách lớp UI (TIS) ↔ Rust ↔ network** — đừng gọi HTTP/network trực tiếp từ TIS cho mọi
   việc; những thứ cần *chặn* hành vi (như xác thực trước khi connect) phải nằm ở tầng Rust vì TIS
   `httpRequest()` là bất đồng bộ, không thể dùng để ngăn 1 hành động xảy ra ngay sau nó.
5. **Tài liệu hóa lại** mọi luồng mới theo đúng quy ước đã có của project (`CLAUDE.md` mục
   "Documentation After Every Task") — cập nhật `docs/<module>.md` kèm sequence diagram, đồng bộ
   vào `docs/sequenceDiagram.md`/`docs/classDiagram.md` nếu có struct/diagram mới.

---

## 6. Tài liệu liên quan trong repo này

| Tài liệu | Nội dung |
|---|---|
| `CLAUDE.md` | Quy ước làm việc, kiến trúc tổng quan, build command, rebrand theme |
| `docs/admin-ui.md` | Gateway + Admin UI tự viết (ngoài lõi RustDesk) |
| `docs/address-book.md` | Luồng Address Book/Auth — ví dụ thật về cách mở rộng lõi RustDesk (mục 5.4 ở trên) |
| `docs/keycloak.md` | Toàn bộ cấu hình/luồng Keycloak (SSO, 2FA, phân quyền) |
| `docs/classDiagram.md` / `docs/sequenceDiagram.md` | Class/sequence diagram tổng hợp toàn project |
| `docs/ci-windows-build.md` / `docs/ci-linux-macos-build.md` | Chi tiết pipeline CI build từng nền tảng |
| `baocao2306.md` | Báo cáo tổng quan toàn đồ án (mục tiêu, công việc đã làm, kết quả) |
