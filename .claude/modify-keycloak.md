# Theme `rocky` — Hướng dẫn tùy biến giao diện login

Theme này branding lại trang **login** của Keycloak (đang áp cho realm `master` /
Admin Console) theo phong cách ROCKY: logo lục giác teal/cyan, tiêu đề
"ROCKY Admin", tagline "Think Like Hustler.", và toàn bộ label hiển thị bằng
tiếng Việt. Tài liệu này tóm lại **cách đã làm**, để bạn lặp lại quy trình khi
muốn đổi tiếp (màu khác, logo khác, branding cho realm thứ 2, v.v.).

Xem `CHANGELOG.md` ở thư mục gốc Keycloak để biết log chi tiết theo ngày,
bug đã gặp và cách đã sửa.

## 1. Cấu trúc theme

```
themes/rocky/login/
├── theme.properties              # khai báo parent, styles, locales
├── template.ftl                  # override layout chung (header: logo+title+tagline)
├── messages/
│   ├── messages_en.properties    # label tiếng Việt (locale mặc định khi i18n tắt)
│   └── messages_vi.properties    # giữ phòng khi i18n bật, hiện trùng nội dung
└── resources/
    ├── css/rocky.css             # toàn bộ màu sắc + style override
    └── img/rocky-logo.svg        # logo hexagon (nền trong suốt)
```

`theme.properties`:
```properties
parent=keycloak
import=common/keycloak
styles=css/login.css css/rocky.css
locales=en,vi
```
- `parent=keycloak` → kế thừa theme `keycloak` built-in (PatternFly v3/v4),
  rồi `base`. Chỉ cần tạo file cho đúng phần muốn đổi, phần còn lại tự kế
  thừa nguyên bản.
- `styles=...rocky.css` đặt **sau** `login.css` → CSS của mình thắng khi
  cùng độ ưu tiên (selector giống nhau).

## 2. Đổi logo / tiêu đề / tagline

Sửa trong `template.ftl`, khối `#kc-header` (xem dòng ~89-96):
```ftl
<div id="kc-header" class="${properties.kcHeaderClass!}">
    <div class="rocky-logo">
        <img src="${url.resourcesPath}/img/rocky-logo.svg" alt="ROCKY" />
    </div>
    <div id="kc-header-wrapper" class="${properties.kcHeaderWrapperClass!}">
        ${kcSanitize(msg("loginTitleHtml",(realm.displayNameHtml!'')))?no_esc}
    </div>
    <div class="rocky-tagline">${msg("rockyTagline")}</div>
</div>
```
- Đổi logo: thay file `resources/img/rocky-logo.svg` (giữ tên file hoặc sửa
  luôn đường dẫn `src` ở trên).
- Đổi tiêu đề/tagline: sửa giá trị `loginTitleHtml` / `rockyTagline` trong
  `messages/messages_en.properties` — **không** sửa cứng trong `.ftl`, để
  còn đổi theo locale nếu cần sau này.
- **Lưu ý**: `loginTitleHtml`/`rockyTagline` là chuỗi cứng, không lấy từ
  `realm.displayName`. Nếu áp theme này cho realm khác, mọi realm sẽ hiện
  y chang "ROCKY Admin" / "Think Like Hustler." — muốn branding riêng thì
  copy nguyên thư mục `themes/rocky` sang theme mới, không parameterize
  theme này.

## 3. Đổi màu / bo góc / style nút, input

Tất cả nằm trong `resources/css/rocky.css`. Quy trình khi muốn đổi tiếp:

1. Xác định **đúng selector** mà theme gốc (`keycloak`/`base`) đang dùng —
   đừng đoán bừa class trên thẻ nào đó.
   - Cách nhanh nhất: grep CSS đã unpack từ
     `lib/lib/main/org.keycloak.keycloak-themes-26.3.2.jar`, hoặc curl trực
     tiếp CSS đã resolve qua HTTP:
     `/resources/<fingerprint>/login/keycloak/css/login.css`.
   - Ví dụ thực tế: nền tối (triangle pattern) tưởng set trên `body` nhưng
     thật ra base CSS set qua `.login-pf body { background: url(...) }`.
     Override `body.login-pf-page` (sai selector) → không có tác dụng gì.
     Phải dùng đúng `.login-pf body` + `!important` để thắng.
2. Thêm rule vào `rocky.css` với selector đúng đó.
3. Biến màu khai báo ở đầu file (`:root { --rocky-teal: ...; }`) — đổi màu
   chủ đạo thì sửa ở đây, các rule dưới đều tham chiếu qua biến.

Bảng màu hiện tại (lấy mẫu pixel từ asset brand):
| Biến | Giá trị | Dùng cho |
|---|---|---|
| `--rocky-teal` | `#01D2D3` | chữ tiêu đề, nút primary, border focus |
| `--rocky-teal-dark` | `#019B9C` | hover/active |
| `--rocky-dot` | `#58D0F8` | điểm nhấn trong logo |
| `--rocky-tagline` | `#51BDE5` | màu chữ tagline |
| `--rocky-bg` | `#ffffff` | nền trang (đè nền tối mặc định) |

## 4. Đổi/thêm label tiếng Việt

- Sửa trực tiếp trong `messages/messages_en.properties` (không phải
  `messages_vi.properties`).
- **Lý do quan trọng**: mỗi `msg("key")` resolve theo locale đang active.
  Nếu realm chưa bật *Internationalization*, locale luôn là `en` →
  `messages_vi.properties` bị bỏ qua hoàn toàn, dù file tồn tại. Vì vậy bản
  dịch tiếng Việt phải nằm thẳng trong `messages_en.properties` mới chắc
  chắn hiển thị với mọi realm, bất kể cấu hình i18n.
- `messages_vi.properties` vẫn giữ lại (nội dung trùng) — dùng tới nếu sau
  này bật i18n thật và muốn tiếng Việt chỉ hiện khi user chọn locale `vi`
  (lúc đó cần tách `messages_en.properties` về tiếng Anh gốc).
- Muốn biết key nào đang dùng ở đâu: tìm trong `.ftl` (`msg("...")`) hoặc
  trong base theme (`base/login/messages/messages_en.properties` trong jar
  ở mục 5).

## 5. Tham khảo file gốc đang bị override

Không sửa trực tiếp theme built-in. Khi cần xem nguyên bản để biết override
gì, giữ gì:
```bash
unzip -l lib/lib/main/org.keycloak.keycloak-themes-26.3.2.jar | grep theme/keycloak/login
unzip -p lib/lib/main/org.keycloak.keycloak-themes-26.3.2.jar theme/keycloak/login/template.ftl
```

## 6. Áp dụng & kiểm tra thay đổi

1. Server đang chạy ở `start-dev` → theme cache tắt, sửa file là thấy ngay,
   **không cần** `kc.sh build` hay restart (chỉ JAR theme trong `providers/`
   mới cần build).
2. Theme là cấu hình **per-realm**, không tự áp toàn server. Realm `master`
   phải có `Realm Settings → Theme → Login theme = rocky` (đã set — xem
   mục dưới). Realm mới mặc định `keycloak.v2` (theme khác hẳn cấu trúc),
   sửa file `rocky` sẽ vô hình với realm đó cho tới khi đổi theme.
3. Verify nhanh không cần mở browser:
   ```bash
   curl -s "http://localhost:8080/realms/master/protocol/openid-connect/auth?client_id=security-admin-console&redirect_uri=http://localhost:8080/admin/master/console/&response_type=code" \
     | grep -E 'loginTitleHtml|rocky|<title>'
   ```
   Kiểm tra `<title>`, đường dẫn CSS load (`.../login/rocky/css/rocky.css`),
   và nội dung label để chắc chắn đang resolve qua theme `rocky` thật,
   không phải `keycloak.v2`.
4. Không có browser headless trên máy này → không tự chụp screenshot được.
   Sau mỗi lần sửa, tự chụp ảnh trang login và đối chiếu bằng mắt.

## 7. Việc cần làm thủ công qua Admin Console (không giao cho agent)

- Đặt `loginTheme = rocky` cho realm: **Realm settings → Theme → Login
  theme**.
- Bật Internationalization nếu muốn dropdown chọn `vi`/`en` thật:
  **Realm settings → Localization → Internationalization = ON**,
  `Supported locales` thêm `vi`, `Default locale = vi`. (Hiện tại không bắt
  buộc vì label tiếng Việt đã hardcode sẵn trong `messages_en.properties`.)
- Mọi thay đổi cần admin credentials đều do người dùng tự thực hiện trong
  Admin Console, agent không xử lý phần này.

## 8. Checklist khi muốn đổi tiếp (logo mới / màu mới / tên brand mới)

- [ ] Đổi `resources/img/rocky-logo.svg` (hoặc đường dẫn `src` trong
      `template.ftl`)
- [ ] Đổi biến màu `:root { --rocky-* }` trong `rocky.css`
- [ ] Đổi `loginTitleHtml` / `rockyTagline` trong `messages_en.properties`
- [ ] Đổi label còn lại nếu cần (cùng file)
- [ ] Verify bằng curl + grep (mục 6.3), rồi nhờ chụp screenshot đối chiếu
- [ ] Cập nhật `CHANGELOG.md` ở thư mục gốc với thay đổi + bug gặp (nếu có)
