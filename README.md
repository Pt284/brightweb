# 😈 BrightWeb — Nền tảng học <details>chui<summary></details></summary> trực tuyến

> **Tự động đồng bộ cấu trúc khóa học từ Google Drive + video từ YouTube → hiển thị thành web học tập đầy đủ tính năng, với lớp override thủ công mạnh mẽ không phá vỡ dữ liệu gốc. Bổ sung pipeline crawl lịch học trực tiếp (livestream m3u8) + Web Push thông báo trước giờ học + PWA cài đặt được trên điện thoại.**

---

## 📋 Mục lục

- [Tổng quan](#tổng-quan)
- [📝 Changelog](#-changelog)
- [Tính năng chính](#tính-năng-chính)
- [Tính năng nổi bật](#tính-năng-nổi-bật)
- [Kiến trúc hệ thống](#kiến-trúc-hệ-thống)
- [Tech stack](#tech-stack)
- [Cài đặt & Cấu hình](#cài-đặt--cấu-hình)
- [Cách hoạt động](#cách-hoạt-động)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [🔒 Bảo mật](#-bảo-mật)

---

## Tổng quan

BrightWeb là web app học tập **static frontend + serverless backend** (GitHub Actions + Cloudflare Worker + Firestore), được thiết kế để:

1. **Tự động crawl** cấu trúc thư mục Google Drive → sinh cây khóa học/chương/bài
2. **Tự động ánh xạ** video YouTube vào đúng bài học dựa theo **prefix số** trong tên (`020301 ~ Tên bài`)
3. **Tự động crawl lịch học trực tiếp** (livestream HocMai) → lấy link m3u8 khi có buổi học live → hiển thị trên lịch + banner + gửi Web Push nhắc nhở trước giờ học
4. **Hiển thị** thành giao diện học tập đầy đủ: sidebar cây bài học, video player, tài liệu, theo dõi tiến độ, lịch học, live banner
5. Cho phép admin **chỉnh sửa thủ công** bất kỳ thứ gì mà **không đụng đến dữ liệu gốc** — toàn bộ override được lưu riêng và merge tại runtime
6. **PWA** — cài đặt được trên điện thoại (Add to Home Screen), nhận Web Push trên cả iOS và Android

Pipeline sync Drive+YouTube chạy tự động **mỗi 1 tiếng** qua GitHub Actions. Pipeline crawl lịch học chạy **4 lần/ngày** (full crawl) + **mỗi 2 phút** (watch mode lấy m3u8 khi live) qua Cloudflare Worker cron. Web Push reminder chạy **mỗi phút** qua Worker cron.

---

## 📝 Changelog

### v3.0 — Live Calendar + Web Push + PWA

**🆕 Tính năng mới lớn:**
- **📅 Lịch học trực tiếp** — crawl lịch HocMai qua API, hiển thị dạng lưới tháng + danh sách, click event → mở bài học tương ứng
- **🔴 Live Stream** — tự lấy m3u8 livestream từ lophoc.secret.vn khi có buổi học live, hiện banner countdown + nút "Xem live"
- **🔔 Web Push Notifications** — nhắc nhở trước giờ học (5 mốc: 15m, 10m, 5m, 150s, 60s), thông báo "Đã có link học mới", digest lịch học hôm nay (4 lần/ngày)
- **📱 PWA** — manifest.json + service worker + icons, cài đặt được trên điện thoại (iOS cần Add to Home Screen để nhận push)
- **📱 Giao diện di động** — sidebar drawer, admin panel fullscreen, calendar list view mặc định, nút home/sidebar toggle cho mobile
- **🛠️ Admin Go Live** — admin có thể set m3u8 thủ công khi watch mode fail
- **🎨 Tối động tinh** — auto-cycle hue qua RAF loop, canvas mirror nền động trong preview
- **⚡ Sync mỗi 1 tiếng** (thay vì 6 tiếng) + concurrency control

**🐛 Bug fixes quan trọng:**
- Fix critical: sync_drive.py ghi đè Firestore với data rỗng khi Drive API fail → giờ có 2 fail-safe chặn
- Fix: lastPosition tách biệt watchedTime — không còn resume từ cuối khi đã xem hết
- Fix: reminder T-90s không gửi vì GitHub Action chưa tạo doc kịp → Worker tự fallback từ app_data/schedule
- Fix: ISO timestamp format mismatch Python↔JS → Firestore query range sai
- Fix: m3u8 "live chạy mãi" sau khi buổi học kết thúc → auto-cleanup khi CDN trả non-200
- Fix: WebGL glass system cũ gây nháy màu khởi động → apply saved theme ngay từ khung đầu
- Fix: calendar màu kẹt cũ khi đổi theme (backdrop-filter không repaint)
- Fix: admin panel scrollbar lòi ra ngoài border-radius

**🔒 Bảo mật vá:**
- Cookie HocMai trả phí lưu ở `server_only/` — client KHÔNG đọc được (firebase.rule chặn)
- Web Push `/push/subscribe` yêu cầu JWT + whitelist check (trước đó không check)
- Stream URL allowlist (`isTrustedStreamUrl`) — chặn m3u8 độc hại nếu Firestore bị compromise
- `app_data.read` chặt hơn: chỉ user trong whitelist/admin (trước đó bất kỳ ai login)
- `email_verified == true` bắt buộc — chặn Google account fake email
- `editMode` protected bằng `Object.defineProperty` — không set được từ DevTools
- `.gitignore` mới — chặn secrets (*.pem, *.key, service-account*.json, vapid*.json, *.har)
- `/go` endpoint: regex validation + domain allowlist chống path traversal / open redirect

**📁 Files mới:** `crawl_calendar.py`, `lophoc_api.py`, `firestore_rest.py`, `tools/send_push.py`, `tools/test_push.py`, `push.js`, `manifest.json`, `sw.js`, `responsive.js`, `wrangler.toml`, `.gitignore`, `.github/workflows/crawl_calendar.yml`, `icons/` (3 PNG)

---

## Tính năng chính

### 🔄 Auto-Sync Pipeline (sync_drive.py)

- Đọc toàn bộ cấu trúc thư mục từ Google Drive qua Service Account
- Đọc tất cả video từ YouTube channel (hỗ trợ cả **OAuth2** để lấy video Unlisted/Private)
- Ánh xạ video vào bài học theo quy tắc prefix 6 chữ số: `CCBBLL` (Course–Chapter–Lesson)
  - Ví dụ: bài số 1, chương 3, khóa 2 → prefix `020301`
- Xuất `data.json` → push lên **Firestore** (không commit vào repo)
- Trigger thủ công từ Admin Panel qua **Cloudflare Worker → GitHub Repository Dispatch**
- Retry tự động (exponential backoff) cho các API call
- **Fail-safe**: nếu Drive API fail hoặc output rỗng → huỷ bỏ, KHÔNG ghi đè Firestore (bảo vệ data cũ)
- **Sync mỗi 1 tiếng** (cron `0 */1 * * *`) + `concurrency` xếp hàng + `timeout-minutes: 20`

### 📅 Lịch học trực tiếp (crawl_calendar.py + lophoc_api.py)

Pipeline mới hoàn toàn — crawl lịch học livestream từ HocMai:

- **Crawl lịch** qua API JSON `HM_BASE_URL/study/calendar/event` (đăng nhập Moodle-style với `logintoken` CSRF)
- **Cookie cache** trong Firestore `server_only/hm_cookies` → skip re-login khi cookie còn hiệu lực
- **Watch mode** (mỗi 2 phút qua Worker cron): tìm buổi học sắp live → lấy m3u8 từ lophoc.secret.vn → update Firestore `app_data/schedule`
- **3 lớp auth lophoc**: `sessionToken` (UUID) → `roomToken` (JWT 24h) → `livestreamlink` → m3u8 URL
- **Merge logic**: giữ m3u8 đã có khi re-crawl; phát hiện "lùi lịch" (cùng ngày + cùng môn nhưng khác giờ) → giữ link cũ
- **Safety guards**: refuse overwrite khi event count giảm >50% (phòng auth/rate-limit fail); auto-cleanup m3u8 khi CDN trả non-200 và event >60 phút sau start
- **Timezone fix**: API trả `start_time` có suffix `"Z"` nhưng thực ra là giờ VN → parse với `+07:00`
- Push kết quả lên Firestore `app_data/schedule`

### 🔔 Web Push Notifications

Hệ thống thông báo đẩy hoàn chỉnh — nhắc trước giờ học + thông báo link live mới:

- **5 mốc nhắc** trước giờ học: 15 phút (🔔), 10 phút (🔔), 5 phút (⏰), 2 phút 30 giây (⚠️ ×2 burst), 1 phút (🚨 ×3 burst)
- **"Đã có link học mới"** — khi watch mode lấy được m3u8 → push ngay cho tất cả subscriber
- **"Link bị thay đổi đột ngột"** — khi m3u8 đổi từ lần thông báo trước
- **Digest lịch học hôm nay** — 4 lần/ngày (9h/11h/14h/17h VN), không so sánh với lần trước (renotify=true để vẫn rung)
- **Web Push encryption thuần Web Crypto** (RFC 8291 + aes128gcm) — không cần `nodejs_compat`, chạy được trên Cloudflare Free plan
- **VAPID ES256 JWT** (ECDSA P-256) — import private key từ JWK
- **Auto-cleanup** subscription hết hạn (HTTP 404/410 → xóa khỏi Firestore)
- **Auto-migration VAPID key** — user subscribe bằng key cũ → push.js tự unsubscribe + resubscribe âm thầm
- **iOS handling riêng** — nếu iOS non-standalone → hiện modal "Add to Home Screen" (iOS Safari chỉ push sau khi install PWA)
- **Click tracking** qua endpoint `/go` (Worker) — redirect an toàn + ghi `clicked=true` vào `session_clicks/{sid}/users/{uid}`

### 🔴 Live Stream Integration

- **Live banner** ở header — auto-update mỗi 60s, countdown "Còn X phút", click → mở tab mới với stream link
- **Live-in-lesson-banner** — khi mở bài học đang live, hiện banner "🔴 ĐANG PHÁT TRỰC TIẾP" + nút "Xem live"
- **HLS.js** — play m3u8 livestream (Chrome/Firefox không support HLS native, Safari có)
- **Stream URL allowlist** — chỉ cho phép `*.hocmai.net`, `*.viettelcdn.vn`, `youtube.com`, `youtu.be` (chặn URL độc hại)
- **`noopener,noreferrer`** khi mở tab mới — chặn tabnabbing + không leak Referer (CDN chặn 403 nếu có Referer)
- **Admin Go Live** — admin set m3u8 thủ công qua panel (chọn date, chọn lesson, dán m3u8, bấm ▶)

### 📱 PWA (Progressive Web App)

- **manifest.json** — `display: standalone`, 3 icons (192, 512, 512 maskable), `start_url: /brightweb/?source=pwa`
- **Service Worker** (`sw.js`) — `skipWaiting()` + `clients.claim()` để active ngay khi deploy
- **iOS meta tags** — `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style: black-translucent`, `apple-mobile-web-app-title`, `apple-touch-icon`
- **theme-color** — `#0b1220` (Android Chrome address bar color)
- **Push event handler** trong SW — `showNotification` với icon, badge, vibrate, `renotify: true`
- **notificationclick** — ưu tiên focus tab đang mở + `client.navigate(targetUrl)`, chỉ `openWindow` khi không có tab; origin allowlist chặn open redirect

### 📱 Giao diện di động (responsive.js)

- **Sidebar drawer** — `transform: translateX(-100%)` ↔ `translateX(0)`, click outside đóng, auto-close khi chọn bài
- **Admin panel fullscreen** — `position: fixed; inset: 0; border-radius: 0` trên mobile
- **Calendar list view mặc định** — mobile không đủ chỗ cho grid, ép sang list (capture phase listener chạy trước app.js)
- **Resize sidebar bằng chuột** (desktop only) — handle pointerdown/move/up, min 180 / max 520 / default 400px, lưu `localStorage`
- **Mobile buttons** — `#btn-sidebar-toggle` (>>), `#btn-home-mobile` (🏠), `#btn-admin-close` (✕)
- **Video full-width** trên mobile — `margin: -16px -16px 18px; width: calc(100% + 32px); border-radius: 0` (giống YouTube mobile)

### 🔐 Xác thực & Phân quyền

- Đăng nhập Google OAuth qua Firebase Auth
- **Whitelist-based**: chỉ email được thêm vào Firestore `whitelist` collection mới truy cập được
- **`email_verified` bắt buộc** — chặn Google account tạo với email chưa verify (firebase.rule)
- **Admin check**: kiểm tra collection `admins` riêng — admin thấy thêm panel chỉnh sửa + Go Live
- Log tất cả truy cập trái phép vào `security_logs` với timestamp và User-Agent
- **`editMode` protected** — `Object.defineProperty(window, 'editMode', { set: chỉ _isAdmin })` — không set được từ DevTools console
- **`downloadBackup()` admin guard** — chỉ admin mới tải được backup JSON

### ✏️ Override System — Chỉnh sửa không phá dữ liệu gốc

Đây là tính năng cốt lõi. Mọi chỉnh sửa thủ công được lưu riêng trong Firestore (`app_data/overrides`) và **merge với data auto-sync tại runtime**. Data gốc không bao giờ bị sửa.

| Override | Chức năng |
|---|---|
| `patches[nodeId].title` | Đổi tên bất kỳ node nào |
| `patches[nodeId].hidden` | Ẩn/hiện node |
| `patches[nodeId].youtubeId` | Gắn video YouTube thủ công vào bài học |
| `patches[nodeId].extraDocs` | Thêm tài liệu Google Drive bổ sung |
| `patches[nodeId].childOrder` | Thay đổi thứ tự con |
| `patches[nodeId].flattenChildren` | Làm phẳng cấu trúc lồng nhau của 1 chương |
| `reparent[nodeId]` | Chuyển node sang chương/khóa khác |
| `manualNodes` | Thêm bài/chương hoàn toàn mới không có trong Drive |
| `manualCourses` | Thêm khóa học hoàn toàn mới |
| `courseDisplayOrder` | Sắp xếp lại thứ tự hiển thị các khóa học |
| `flattenAll` | Làm phẳng toàn bộ cấu trúc lồng nhau |

**Undo/Redo** với stack 20 bước — Ctrl+Z / Ctrl+Y hoạt động xuyên suốt toàn bộ tính năng edit.

### 📊 Theo dõi tiến độ học

- Lưu `watchedTime` (max) và `lastPosition` (vị trí gần nhất) vào **localStorage** sau mỗi 5 giây
- Sync lên Firestore khi: pause, ended, chuyển bài, đóng tab (visibilitychange / pagehide)
- **Auto-resume**: tự seek đến `lastPosition` (không phải `watchedTime`) — nếu đã xem hết (lastPosition ở cuối) thì resume từ đầu
- Hiển thị % tiến độ theo từng bài (minibar), từng chương (arc tròn SVG), từng khóa học
- Đánh dấu hoàn thành tự động khi video kết thúc (nếu đã xem gần hết)
- Firestore ↔ localStorage 2-chiều: lấy về dữ liệu mới hơn khi đăng nhập thiết bị khác
- **Plyr storage key riêng** (`plyr_lesson`) — tránh rò state muted từ modal live

### 🎬 Video Player (Plyr.js + YouTube)

- Ẩn toàn bộ UI YouTube gốc (nocookie + `pointer-events: none` trên iframe)
- Custom poster với thumbnail HD, tên video tự fetch qua **YouTube oEmbed API** (không cần API key)
- Poster fade out khi video bắt đầu phát (trigger `playing`, không phải `play` — tránh flash)
- **Caption watchdog** — interval 1.5s force disable YT captions (browser đôi khi tự bật dù `cc_load_policy: 0`)
- **Auto-unmute** trên ready — ép `muted=false` + `volume=1` nếu kẹt ở 0 (autoplay policy)

**Keyboard shortcuts đầy đủ YouTube-style:**

| Phím | Hành động |
|---|---|
| `Space` / `K` | Play/Pause |
| `J` / `←` | Tua lại 5s (+ Shift = 10s) |
| `L` / `→` | Tua tới 5s (+ Shift = 10s) |
| `↑` / `↓` | Tăng/giảm âm lượng 5% |
| `M` | Mute/Unmute |
| `F` | Fullscreen |
| `C` | Bật/tắt phụ đề |
| `0`–`9` | Nhảy đến 0%–90% |
| `<` / `>` | Giảm/tăng tốc độ 0.25x |
| `,` / `.` | Frame-by-frame (khi pause) |
| `Home` / `End` | Đầu / Cuối video |
| **Giữ Space** | Tạm thời 2x speed (thả về tốc độ cũ) |

### 🛠️ Admin Check Video Tool (`admin-check.html`)

Công cụ đối chiếu dữ liệu giữa 3 nguồn để phát hiện vấn đề:

- **Downloaded** (Local): danh sách file đã tải về máy
- **Uploaded** (YouTube): danh sách ID đã upload
- **GitHub Pages** (Web): dữ liệu đang hiển thị trên Firestore

Tự động phân loại: Hoàn thành ✅ / Thiếu trên Web / Chưa upload / ID bất thường

Xuất **lệnh PowerShell** để xóa hàng loạt file local đã upload an toàn.

### 🎨 Theme System (color-settings.js + bg.js)

- **Hue slider** thay đổi toàn bộ color scheme (HSL-based, 17+ design token)
- **Tối động tinh** — auto-cycle hue qua RAF loop (mới)
- **Blob color picker**: chọn màu nền động riêng biệt
- **Canvas mirror nền động** trong preview — thấy trước giao diện thật khi đổi theme (mới)
- Per-token override: chỉnh từng màu CSS variable riêng lẻ trong tab "Nâng cao"
- **Segmented control tabs** — pill slider với cubic-bezier transition (mới)
- Bật/tắt animation nền (tiết kiệm CPU) + điều chỉnh tốc độ blob
- Bật/tắt glassmorphism effect
- Lưu vào `localStorage`, **restore ngay từ khung đầu tiên** khi reload (fix nháy màu)
- **Calendar auto-refresh** khi đổi theme (fix backdrop-filter không repaint)

---

## Tính năng nổi bật

### 🌊 Animated Blob Background (bg.js)

Hệ thống nền động viết thuần JavaScript + Canvas 2D, không dùng thư viện:

- 11 blob với vòng đời độc lập: fade-in → hold → fade-out → rebirth ở rìa màn hình
- Noise-based movement (sin nhiều tần số) cho chuyển động tự nhiên, không lặp
- `BlobController` API public: `setPalette(hue)`, `setPaletteFromHsl(h,s,l)`, `setSpeed(mul)`, `toggle(bool)`, `setBgColor(color)`
- Palette sinh động: 8 màu tối dần từ màu người dùng chọn, scale tuyến tính theo lightness
- Dừng RAF loop khi toggle off → không tốn CPU
- **Apply saved theme ngay từ khung đầu tiên** — không còn nháy màu khởi động

### 🔮 WebGL Glassmorphism (container.js + button.js)

Glass effect thực sự bằng **WebGL** — không chỉ là `backdrop-filter`:

- Chụp snapshot trang bằng `html2canvas` làm texture nền
- Fragment shader tính toán **refraction** (khúc xạ ánh sáng) tại rìa và góc
- Hỗ trợ 3 hình dạng: `rounded`, `pill`, `circle` — detect tự động trong shader
- Nested glass: nút bên trong container dùng canvas của container cha làm texture
- Render loop riêng cho từng instance, cập nhật vị trí theo scroll

> 📝 **Lưu ý**: Các CSS class cũ (`.glass-container*`, `.glass-button*`) đã được dọn dẹp khỏi `style.css` — giờ dùng chung 1 class `.glass` với `backdrop-filter` CSS thuần cho hầu hết UI. WebGL glass system vẫn giữ để dùng cho login button và các element đặc biệt.

### 🧠 Override Merge Engine (overrides.js)

Thuật toán merge phức tạp với độ ưu tiên rõ ràng, chạy hoàn toàn client-side:

```
rawDriveData + manualCourses
    → detachReparents()       # tách node cần di chuyển
    → injectReparents()       # gắn lại vào đúng cha mới
    → injectManualNodes()     # chèn node mới tạo
    → applyPatches()          # đổi tên, ẩn, đổi video, thêm doc
    → reorderByChildOrder()   # sắp xếp
    → enforceMaxDepth()       # làm phẳng nếu cần
    → reorderCourses()        # thứ tự khóa học
```

Merge chạy lại sau **mỗi** thao tác save, đảm bảo UI luôn nhất quán với state. Nếu merge lỗi, **giữ data gốc Drive** thay vì rớt về MockData.

### 📐 Prefix Mapping System (sync_drive.py)

Quy ước đặt tên thư mục `NN ~ Tên` tự động sinh ID dạng `CCBBLL`:

```
Drive:
  01 ~ Toán/
    03 ~ Chương 3/
      01 ~ Bài 1/   →  prefix: "010301"
```

Video YouTube đặt tên `010301 ~ Tên video` → tự động ghép vào đúng bài, không cần cấu hình thêm gì.

### 🔁 Drag & Drop Tree Editor

- Kéo thả **thứ tự bài/chương** trong sidebar (cùng cấp)
- Kéo thả **thứ tự khóa học** trên trang Home
- Cut/Copy/Paste node qua toolbar hoặc phím tắt Ctrl+X/C/V
- Paste vào chương đích (hoặc root khóa học)
- Keyboard: `Del` ẩn node được chọn, `Esc` hủy selection/clipboard

### 💾 Backup / Restore

- Xuất file JSON chứa: `mergedCourses` + `rawAutoData` + `overrides`
- Restore bằng cách upload lại — ghi đè toàn bộ override hiện tại
- Nút "Reset về gốc" cho từng khóa học: backup các chỉnh sửa thủ công thành node `modified_*` rồi restore cấu trúc Drive gốc
- **Admin-only** — `downloadBackup()` có guard `if (!_isAdmin) return`

### 📅 Calendar Event Resolver (app.js)

Khi user click event lịch → tìm bài học tương ứng để mở:

1. **TSA chapter prefix resolver** — match event title với lesson trong chương "Tháng N" (sắp xếp theo tháng)
2. **Disambiguate** khi trùng title — chọn lesson có `_chapterMonth` gần nhất với tháng của event
3. **Fallback Jaccard similarity** — nếu không match exact, dùng Jaccard similarity trên token (strip dấu VN + stopwords), threshold ≥0.35
4. **Normalize NFC + separators** — `/` `:` → ` - `, strip trailing dots, để match giữa event title và lesson title dù format khác nhau
5. Nếu không tìm thấy lesson → mở trang khóa học (không đá về home)

---

## Kiến trúc hệ thống

```
┌─────────────────────────────────────────────────────────────┐
│                    Google Drive                             │
│   01 ~ Khóa A/                                              │
│     01 ~ Chương 1/                                          │
│       01 ~ Bài 1/  ──────────────────────────────────────┐  │
└──────────────────────────────────────────────────────────│──┘
                                                           │
                           prefix: "010101"                │
                                                           ▼
┌─────────────────────────────────────────────────────────────┐
│               GitHub Actions (mỗi 1h)                       │
│  sync_drive.py                                              │
│    read_drive() → build_drive_tree_fast()                   │
│    read_youtube() → fetch_playlist_items() ──────────────┐  │
│    assign_videos(prefix match) ◄─────────────────────────┘  │
│    build_output() → push_to_firestore()                     │
│  [Fail-safe: không ghi đè nếu data rỗng]                    │
└─────────────────────────────────────────────────────────────┘
                              │
                    Firestore: app_data/courses
                              │
┌─────────────────────────────────────────────────────────────┐
│               GitHub Actions (4 lần/ngày + watch 16 phút)   │
│  crawl_calendar.py                                          │
│    do_login() (Moodle CSRF) → fetch_calendar_api()          │
│    cookie cache: server_only/hm_cookies                     │
│    merge_events() → push_schedule()                         │
│  tools/send_push.py                                         │
│    "📅 Lịch học hôm nay" digest + "🆕 Link học mới"          │
│  [Fail-safe: không ghi đè nếu event giảm >50%]              │
└─────────────────────────────────────────────────────────────┘
                              │
                    Firestore: app_data/schedule
                              │
┌─────────────────────────────────────────────────────────────┐
│               Cloudflare Worker (cron mỗi phút + 2 phút)    │
│  worker.js                                                  │
│    reminderJob (mỗi phút):                                  │
│      query session_clicks by startAt range                  │
│      fallback tryFallbackFromSchedule() nếu 0 session       │
│      5 mốc nhắc (15m/10m/5m/150s/60s) × burst               │
│    watchModeJob (mỗi 2 phút, 07:00-23:58 VN):               │
│      lophocLogin → lophocRoomToken → lophocGetM3u8           │
│      handleNewM3u8 → push "Link mới" + tạo session_clicks   │
│      auto-cleanup m3u8 khi CDN non-200 + event >60ph        │
│  Routes:                                                    │
│    POST * → handleSyncDispatch (trigger GitHub sync)        │
│    GET /go → handleGo (click tracking + redirect)           │
│    POST /push/subscribe → handleSubscribe (whitelist check) │
│    POST /push/unsubscribe → handleUnsubscribe (ownership)   │
│    GET /vapid-public-key → dynamic VAPID key                │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────▼
│                   index.html (Browser / PWA)                │
│                                                             │
│  Firebase Auth ──► checkAccess (whitelist + admins)         │
│                                                             │
│  loadData()                                                 │
│    ├── Firestore: app_data/courses  (rawAutoData)           │
│    ├── Firestore: app_data/overrides (_overrides)           │
│    └── getMergedCourses(rawAutoData, overrides)             │
│  loadCalendarData()                                         │
│    └── Firestore: app_data/schedule (3 phút cache)           │
│                                                             │
│  updateLiveBanner() mỗi 60s                                 │
│    → #live-banner (countdown + click → openLiveInNewTab)    │
│                                                             │
│  Admin Edit ──► patchNode() ──► saveOverrides()             │
│  Admin Go Live ──► setLiveModeOnEvent()                     │
│                                                             │
│  push.js: nút 🔔 → /push/subscribe (Worker)                 │
│  sw.js: push event → showNotification + notificationclick   │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech stack

| Layer | Công nghệ |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JS (không framework) |
| Auth | Firebase Authentication (Google OAuth) |
| Database | Cloud Firestore |
| Video Player | Plyr.js 3.7.8 + YouTube IFrame API |
| HLS Player | HLS.js 1.5.13 (cho m3u8 livestream) |
| Background FX | Canvas 2D (blob animation) |
| Glass FX | WebGL (custom GLSL shaders) |
| Particle | particles.js 2.0.0 |
| Screenshot | html2canvas 1.4.1 |
| PWA | manifest.json + Service Worker (thuần JS, không Workbox) |
| Web Push | Thuần Web Crypto API (RFC 8291 + RFC 8188 aes128gcm) + VAPID ES256 |
| Auto-Sync (Drive+YouTube) | Python 3.11, GitHub Actions (mỗi 1h) |
| Calendar Crawl (HocMai) | Python 3.11 (HTTP thuần), GitHub Actions (4 lần/ngày + watch 16 phút) |
| Watch Mode + Reminder | Cloudflare Worker cron (mỗi 2 phút + mỗi phút) |
| Drive API | google-api-python-client |
| Web Push Sender (Python) | pywebpush 2.0.0 |
| Sync Trigger | Cloudflare Worker (proxy GitHub REST API) |
| Hosting | GitHub Pages (static) |

---

## Cài đặt & Cấu hình

### GitHub Secrets cần thiết

#### Cho sync_drive.py (Drive + YouTube)

| Secret | Mô tả |
|---|---|
| `GOOGLE_CREDENTIALS_JSON` | Service Account JSON có quyền Drive read |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key |
| `YOUTUBE_OAUTH_JSON` | OAuth2 token JSON (để đọc video Unlisted) |
| `YOUTUBE_CHANNEL_ID` | Channel ID dạng `UCxxxxxxxx` |
| `DRIVE_ROOT_FOLDER_ID` | ID folder gốc trên Google Drive |
| `FIRESTORE_PROJECT_ID` | Firebase project ID |

#### Cho crawl_calendar.py (Lịch học HocMai)

| Secret | Mô tả |
|---|---|
| `HM_USERNAME` | Tài khoản HocMai (email/SĐT) |
| `HM_PASSWORD` | Mật khẩu HocMai |
| `HM_BASE_URL` | Base URL HocMai (vd `https://secret.vn`) |
| `HM_CAL_PATH` | Path trang calendar (vd `/calendar`) |
| `HM_LOGIN_PATH` | Path login (vd `/loginv2/index.php`) |
| `HM_LOGOUT_V2_PATH` | Path logout bước 1 (vd `/loginv2/logout.php`) |
| `HM_LOGOUT_FINAL_PATH` | Path logout bước 2 (vd `/login/logout.php`) |

#### Cho Web Push

| Secret | Mô tả |
|---|---|
| `VAPID_PRIVATE_KEY` | VAPID private key (base64url, 32 bytes P-256 scalar) |
| `VAPID_PUBLIC_KEY` | VAPID public key (base64url, 65 bytes uncompressed P-256 point) |
| `VAPID_SUBJECT` | `mailto:your@email.com` hoặc URL contact |
| `SITE_URL` | `https://<owner>.github.io/<repo>` (không có / cuối) |

#### Cho Cloudflare Worker

| Worker env var | Mô tả |
|---|---|
| `GITHUB_OWNER` | GitHub username (owner repo) |
| `GITHUB_REPO` | Repository name |
| `GITHUB_TOKEN` | PAT có quyền `repo` (trigger repository_dispatch) |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Service account JSON (Worker dùng để ghi Firestore) |
| `RATE_LIMIT_KV` | KV namespace binding (rate limit sync + subscribe) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | VAPID keys (cho Web Push) |
| `HM_USERNAME` / `HM_PASSWORD` / `HM_BASE_URL` | Cho watchModeJob (Worker gọi lophoc API) |

### Quy ước đặt tên (bắt buộc)

**Google Drive:**
```
NN ~ Tên thư mục
```
- `N` là số thứ tự (01, 02, ...) — bắt buộc ở đầu, cách `~` bằng khoảng trắng

**YouTube video:**
```
CCBBLL ~ Tên video
```
hoặc
```
CCBBLL - Tên video
```
- `CC` = 2 chữ số thứ tự khóa, `BB` = thứ tự chương, `LL` = thứ tự bài
- Ví dụ: Khóa 1, Chương 2, Bài 3 → `010203`

### Firestore Collections

```
whitelist/              {email}  → { addedAt }
admins/                 {email}  → {}
app_data/courses           → { json: string, updatedAt }
app_data/overrides         → { v, patches, manualNodes, ... }
app_data/schedule          → { json: string, updatedAt }     [MỚI]
server_only/hm_cookies     → { cookies, updatedAt }           [MỚI, client KHÔNG đọc được]
server_only/lophoc_session → { cookies, updatedAt }           [MỚI, client KHÔNG đọc được]
progress/              {uid_lid} → { userId, lessonId, watched, watchedTime, lastPosition, duration }
security_logs/             → { email, name, time, ua }
push_subscriptions/    {sha1(endpoint)[:32]} → { endpoint, p256dh, auth, uid, email, active, ... }  [MỚI]
session_clicks/        {sid} → { sessionId, subject, title, date, time, startAt, realLink, reminded_* }  [MỚI]
session_clicks/{sid}/users/{uid} → { clicked, clickedAt, remindedAt }  [MỚI]
```

### Cloudflare Worker Cron Triggers

Cấu hình qua Cloudflare Dashboard (hoặc `wrangler.toml`):

| Cron | Job | Mô tả |
|---|---|---|
| `* * * * *` | `reminderJob` | Mỗi phút — tìm session sắp bắt đầu, gửi push reminder (5 mốc) |
| `*/2 0-16 * * *` | `watchModeJob` | Mỗi 2 phút, 07:00-23:58 VN — lấy m3u8 cho buổi học đang live |

---

## Cách hoạt động

### Sync tự động (Drive + YouTube)

1. GitHub Actions chạy `sync_drive.py` mỗi 1 tiếng (hoặc trigger thủ công)
2. Script đọc toàn bộ cấu trúc Drive, lọc thư mục có prefix `NN ~`
3. Đọc tất cả video từ `uploads` playlist của channel, lọc video có prefix 6 số
4. Ghép video vào đúng bài học theo prefix
5. **Fail-safe check**: nếu `courses` rỗng HOẶC `output.courses` rỗng → exit(1), KHÔNG push Firestore
6. Push JSON lên Firestore — **không commit vào repo**

### Crawl lịch học (HocMai)

1. GitHub Actions chạy `crawl_calendar.py` 4 lần/ngày (full crawl) hoặc mỗi 16 phút (watch mode backup)
2. **Full mode**: đăng nhập Moodle → fetch calendar API → merge với data cũ (giữ m3u8) → push `app_data/schedule`
3. **Watch mode**: tìm buổi học sắp live (trong 30 phút tới) → lấy m3u8 từ lophoc → update schedule
4. **Worker watch mode** (mỗi 2 phút): primary — Worker tự gọi lophoc API, không cần GitHub Actions
5. **Fail-safe**: nếu event count giảm >50% so với cũ → KHÔNG ghi đè (phòng auth/rate-limit fail)
6. Sau khi crawl xong → chạy `tools/send_push.py` gửi "📅 Lịch học hôm nay" digest + "🆕 Link học mới"

### Web Push reminder

1. Cloudflare Worker cron `* * * * *` chạy `reminderJob` mỗi phút
2. Query `session_clicks` trong window `[now-90s, now+16min]`
3. Nếu 0 session → `tryFallbackFromSchedule()` đọc `app_data/schedule` + tự tạo placeholder doc
4. Với mỗi session: tìm checkpoint khớp giờ hiện tại (15m/10m/5m/150s/60s) CHƯA gửi
5. Lọc user chưa click (`session_clicks/{sid}/users/{uid}.clicked != true`)
6. Gửi burst push (1-3 thông báo cách nhau 4 giây) cho từng user
7. Auto-xóa subscription nếu push service trả 404/410

### Trigger thủ công từ web

Nút "Sync ngay" trong Admin Panel → gọi Cloudflare Worker → Worker verify Firebase JWT + check admin + rate limit (3 sync/5phút) → gửi `repository_dispatch` lên GitHub API → GitHub Actions chạy ngay.

### Merge override tại runtime

Khi tải trang, browser fetch cả `courses` và `overrides` từ Firestore, sau đó `getMergedCourses()` merge theo thứ tự ưu tiên: override luôn thắng data gốc, nhưng data gốc không bị mất — khi xóa override thì data gốc tự phục hồi. Nếu merge lỗi, **giữ data gốc Drive** thay vì rớt về MockData.

---

## Cấu trúc thư mục

```
brightweb/
├── index.html              # App chính — toàn bộ UI + logic
├── app.js                  # Core app logic (routing, auth, render, calendar, live)
├── overrides.js            # Override engine: merge, patch, undo/redo, backup
├── bg.js                   # Animated blob background (Canvas 2D)
├── container.js            # WebGL glass container
├── button.js               # WebGL nested glass button
├── glass.css               # CSS cho WebGL glass elements
├── style.css               # Design system: tokens, layout, components
├── color-settings.css      # Theme editor UI
├── color-settings.js       # Theme editor logic + BlobController bridge
├── responsive.js           # Mobile UI (sidebar drawer, resize, calendar list)  [MỚI]
├── push.js                 # Web Push subscription client                   [MỚI]
├── sw.js                   # Service Worker (push event + notificationclick) [MỚI]
├── manifest.json           # PWA manifest                                   [MỚI]
├── admin-check.html        # Tool đối chiếu 3 nguồn dữ liệu video
├── admin-check.js          # Logic check & report
├── admin-check.css         # Styles cho tool
├── sync_drive.py           # Script sync Drive + YouTube → Firestore
├── crawl_calendar.py       # Script crawl lịch HocMai → Firestore           [MỚI]
├── lophoc_api.py           # HTTP client lophoc.secret.vn (lấy m3u8)        [MỚI]
├── firestore_rest.py       # Helper Firestore REST API (cache token, list)  [MỚI]
├── worker.js               # Cloudflare Worker (sync trigger + push + cron) [MỚI - rewrite 10x]
├── wrangler.toml           # Cloudflare Worker config + cron triggers       [MỚI]
├── requirements.txt        # Python deps (thêm pywebpush)
├── .gitignore              # Chặn secrets, *.har, *.md planning notes       [MỚI]
├── icons/                  # PWA icons (3 PNG: 192, 512, 512-maskable)      [MỚI]
│   ├── icon-192.png
│   ├── icon-512.png
│   └── icon-512-maskable.png
├── tools/                  # Scripts test/dev                              [MỚI]
│   ├── send_push.py        # Gửi Web Push từ GitHub Actions
│   └── test_push.py        # Local test script (có production guard)
└── .github/
    └── workflows/
        ├── sync.yml        # GitHub Actions pipeline (mỗi 1h)
        └── crawl_calendar.yml  # Crawl lịch (4 lần/ngày + watch 16 phút)    [MỚI]
```

---

## 🔒 Bảo mật

BrightWeb áp dụng nhiều lớp bảo vệ — client-side guards có thể bị bypass, nhưng Firestore Rules và Worker verification thì không.

### Authentication & Authorization

- **Firebase Auth** (Google OAuth) — bắt buộc đăng nhập
- **Whitelist-based** — chỉ email trong Firestore `whitelist` hoặc `admins` mới truy cập được
- **`email_verified == true`** bắt buộc (firebase.rule) — chặn Google account tạo với email chưa verify
- **Admin check** qua Firestore collection `admins` (dynamic, không hardcode email)
- **`editMode` protected** bằng `Object.defineProperty` — không set được `editMode=true` từ DevTools console
- **`downloadBackup()` admin guard** — chỉ admin mới tải được backup JSON
- **`triggerSync` client-side admin guard** — user thường không gọi được (Worker sẽ chặn 403 nhưng guard client tránh tốn fetch JWKS)

### Firestore Security Rules

| Collection | Read | Write |
|---|---|---|
| `whitelist/{email}` | `get`: tự đọc; `list`: admin | admin + `email_verified` |
| `admins/{email}` | `get`: tự đọc; `list`: admin | `false` (chỉ qua Firebase Console) |
| `app_data/{doc}` | `isWhitelistedOrAdmin()` | `create/update`: admin (chỉ `overrides` + `schedule`); `delete`: `false` |
| `progress/{uid_lid}` | owner (uid khớp) | owner (uid khớp) |
| `security_logs/{id}` | admin | `create`: auth + email khớp + validate fields; `read`: admin |
| `server_only/{doc}` | **`false`** (chỉ service account) | **`false`** (chỉ service account) |
| `push_subscriptions/{sid}` | **`false`** (chỉ service account) | `create/update`: owner + whitelist; `delete`: owner |
| `session_clicks/{sid}` | admin | `false` (chỉ service account) |
| `session_clicks/{sid}/users/{uid}` | owner (uid khớp) | `false` (chỉ service account) |

### Cloudflare Worker Security

- **JWT verification** cryptographic (RSASSA-PKCS1-v1_5 + SHA-256) — không dùng `accounts:lookup`
- **Rate limiting** — sync: 3 req/5phút/admin; subscribe: 5 req/60s/IP (qua KV)
- **CORS strict** — chỉ allow origin `<owner>.github.io`, có `Vary: Origin`, không `Allow-Credentials`
- **`/push/subscribe` whitelist check** — `checkWhitelistOrAdmin()` query cả `whitelist` + `admins`
- **`uid`/`email` từ JWT** — không tin request body (chống mạo danh)
- **`/push/unsubscribe` ownership check** — đọc doc, so `uid` với `payload.sub`
- **`/push/subscribe` SSRF allowlist** — endpoint phải `https:` + host thuộc 4 push services (googleapis, mozilla, windows, apple)
- **`/go` regex + domain allowlist** — `^[\w-]{1,128}$` cho session/user; `.hocmai.net|.hocmai.vn|.hcdn.vn|.viettelcdn.vn` cho `to`
- **Secret redaction in logs** — `redactBody()` regex replace token/password/session/cookie/jwt trước khi log

### Stream URL Allowlist (app.js)

```javascript
function isTrustedStreamUrl(u) {
  const allowedHosts = [
    /\.hocmai\.net$/, /\.viettelcdn\.vn$/,
    /^www\.youtube\.com$/, /^youtube\.com$/, /^youtu\.be$/,
  ];
  return allowedHosts.some(re => re.test(new URL(u).hostname));
}
```

→ Chặn URL độc hại nếu Firestore `app_data/schedule` bị compromise (service account leak, admin bị hack). Áp dụng cho cả `openLiveInNewTab` + `setLiveModeOnEvent` (admin Go Live).

### CSP (Content Security Policy)

```http
default-src 'self';
script-src 'self' cdn.jsdelivr.net gstatic.com apis.google.com youtube.com cdn.plyr.io;
style-src 'self' 'unsafe-inline' fonts.googleapis.com cdn.plyr.io;
connect-src 'self' *.firebaseio.com *.googleapis.com identitytoolkit.googleapis.com
            brightweb-sync.mcdg5444.workers.dev youtube.com noembed.com
            evg-stream.hocmai.net *.hocmai.net cdn.plyr.io;   ← MỚI (HLS streaming)
frame-src youtube.com brightwebaccbase.firebaseapp.com;
worker-src 'self' blob:;                                     ← MỚI (Service Worker)
object-src 'none';
```

### Một số chi tiết kỹ thuật thú vị

- **Không có `innerHTML` cho data từ Firestore**: toàn bộ render tree bài học dùng DOM API (`createElement`, `textContent`) để tránh XSS. **Ngoại lệ**: calendar render dùng `innerHTML` + `escapeHtml()` (escape `&<>"'`) vì số lượng cell lớn — đây là pattern khác với README gốc nhưng vẫn an toàn
- **Firebase API key public là intentional**: bảo mật thực sự nằm ở Firestore Security Rules và server-side whitelist check, không phải ở việc giấu API key
- **Plyr iframe `pointer-events: none`**: overlay div trong suốt nhận keyboard event, iframe YouTube không nhận — tránh YouTube steal focus
- **Progress flush nhiều cơ chế**: `pause`, `ended`, `visibilitychange`, `pagehide` — đảm bảo không mất dữ liệu ngay cả khi đóng tab đột ngột
- **Undo stack serialize toàn bộ `_overrides`**: đơn giản nhưng hiệu quả — JSON.stringify/parse đủ nhanh cho object kích thước này
- **`lastPosition` tách `watchedTime`**: `watchedTime` là max (dùng tính % hoàn thành), `lastPosition` là vị trí gần nhất (dùng resume) — không còn kẹt resume từ cuối khi đã xem hết
- **Caption watchdog 1.5s**: YouTube đôi khi tự bật captions dù `cc_load_policy: 0` (do user setting browser) — interval force `unloadModule('captions')` mỗi 1.5s + bind vào 4 events (volumechange, pause, playing, seeked)
- **`server_only/` cho cookie HocMai trả phí**: Cookie MoodleSession bị lộ = kẻ tấn công login thẳng vào tài khoản HocMai trả phí → firebase.rule `allow read, write: if false`, chỉ service account truy cập qua REST
- **Web Push encryption thuần Web Crypto**: RFC 8291 + RFC 8188 aes128gcm + VAPID ES256 — không cần `nodejs_compat`, chạy được trên Cloudflare Free plan (10ms CPU/invocation)
- **`redactBody()` trong Worker**: log error body chứa token/password/session/cookie/jwt → regex replace `$1=***` trước khi log, tránh leak secret vào Cloudflare logs

---

## 📝 Lịch sử cập nhật

### v3.0 — Live Calendar + Web Push + PWA

Xem mục [📝 Changelog](#-changelog) ở gần đầu README để biết chi tiết đầy đủ.

Tóm tắt nhanh:

- **+13 files mới**: `crawl_calendar.py`, `lophoc_api.py`, `firestore_rest.py`, `tools/send_push.py`, `tools/test_push.py`, `push.js`, `manifest.json`, `sw.js`, `responsive.js`, `wrangler.toml`, `.gitignore`, `crawl_calendar.yml`, `icons/`
- **Worker rewrite 10x**: 175 → 1766 dòng — thêm 4 route + 2 cron job + Web Push encryption thuần Web Crypto
- **`app.js` +46%**: ~2315 → ~3388 dòng — calendar subsystem (~25 functions) + live-banner + HLS integration + Go Live admin panel
- **`style.css` +96%**: ~1018 → ~1997 dòng — calendar UI + live banner/modal + mobile @media portrait
- **`firebase.rule` +76%**: ~66 → ~116 dòng — 3 collections mới (`server_only/`, `push_subscriptions/`, `session_clicks/`) + `isWhitelistedOrAdmin()` helper
- **Sync mỗi 1h** (thay vì 6h) + fail-safe không ghi đè Firestore khi data rỗng
- **~50+ bug fixes** + **~50+ security patches** (xem chi tiết trong Changelog)

### v2.0 — Major Rewrite

So với **v1.0** (bản gốc), v2.0 là một rewrite lớn trên toàn bộ stack. Dưới đây là tất cả những gì đã thay đổi:

---

#### 🔐 Bảo mật — Vá lỗ hổng nghiêm trọng

| Vấn đề v1 | Giải pháp v2 |
|---|---|
| `ADMIN_EMAIL = "mcdg5444@gmail.com"` hardcode trong JS client — ai cũng đọc được | Admin check qua Firestore collection `admins` — server-side |
| `SYNC_SECRET` (chuỗi 300+ ký tự) hardcode trong `index.html` — lộ hoàn toàn | Sync trigger xác thực bằng **Firebase ID Token** qua Cloudflare Worker |
| `renderTable()` dùng `tr.innerHTML = ...` với dữ liệu từ Firestore → **XSS** | Toàn bộ render chuyển sang DOM API (`createElement`, `textContent`) |
| `loadAdminData()` trong index.html dùng `innerHTML` với email/timestamp | DOM API, không có HTML injection |
| Không có Content Security Policy | CSP header nghiêm ngặt trên cả `index.html` và `admin-check.html` |
| `safeUrl()` không tồn tại — URL từ Firestore gắn thẳng vào `href` | Hàm `safeUrl()` validate protocol `https:`/`http:` trước khi render |

---

#### 🎬 Video Player — Thay thế hoàn toàn

**v1:** Plain `<iframe>` YouTube nhúng thẳng, không kiểm soát được gì.

**v2:** Tích hợp **Plyr.js** với toàn bộ custom layer bên trên:
- Ẩn UI YouTube gốc (`pointer-events: none` trên iframe, `youtube-nocookie.com`)
- **Custom poster** với thumbnail HD — fade out khi video phát (trigger `playing`, không phải `play` để tránh flash)
- **oEmbed title fetch** — hiện tên thật của video trước khi play, không cần API key
- **Auto-resume** — tự seek về vị trí xem dở lần trước
- **14 keyboard shortcuts** YouTube-style (Space/K, J/L, arrows, M, F, 0–9, </>)
- **Giữ Space** để tạm thời 2x speed, thả về tốc độ cũ
- Frame-by-frame bằng `,` / `.` khi pause
- Toast overlay hiện phản hồi mỗi lần nhấn phím

---

#### 📊 Progress Tracking — Từ không có gì thành dual-storage

**v1:** Chỉ có "Đánh dấu đã xem" (boolean), lưu Firestore mỗi lần bấm nút.

**v2:**
- Lưu `watchedTime` + `duration` vào **localStorage** sau mỗi 5 giây phát
- Debounce sync lên **Firestore** 30 giây sau lần ghi cuối
- Flush ngay khi: `pause`, `ended`, chuyển bài, đóng tab (`visibilitychange` / `pagehide`)
- Khi load lại: so sánh timestamp localStorage vs Firestore, lấy cái mới hơn
- Hiển thị % xem dở (0–99%) trên từng bài học trong sidebar
- **Arc tròn SVG** cho % tiến độ theo chương
- **Minibar** cho % tiến độ theo từng bài
- Auto-mark done khi video kết thúc (nếu `duration - watchedTime ≤ 600s`)

---

#### ✏️ Override System — File mới hoàn toàn (`overrides.js`)

**v1:** Không có. Dữ liệu Drive là duy nhất, không sửa được gì ngoài code.

**v2:** Toàn bộ file `overrides.js` (~350 dòng) mới, bao gồm:
- Lưu override riêng trong `app_data/overrides` — không đụng data gốc
- 9 loại patch: `title`, `hidden`, `youtubeId`, `extraDocs`, `childOrder`, `flattenChildren`, `reparent`, `manualNodes`, `manualCourses`
- **Undo/Redo** 20 bước (Ctrl+Z / Ctrl+Y)
- **Merge engine** 7 bước chạy tại runtime
- **Backup/Restore** — xuất JSON đầy đủ, restore bằng upload file
- `_recomputeMerged()` tự động re-render sau mỗi thao tác save

---

#### 🖱️ Edit Mode — Toàn bộ mới

**v1:** Không có edit mode.

**v2:**
- Toggle edit mode bằng nút ✏️ trong header
- **Drag & drop thứ tự khóa học** trên trang Home
- **Drag & drop thứ tự bài/chương** trong sidebar (cùng cấp)
- **Cut / Copy / Paste** node qua toolbar hoặc Ctrl+X/C/V
- **Checkbox multi-select** — chọn nhiều node để cắt/copy/ẩn
- Phím tắt: `Del` ẩn node được chọn, `Esc` hủy selection
- **Modal sửa bài học**: đổi tên, ẩn/hiện, xóa, đẩy bài lên cấp cha, xóa chương giữ bài
- **Modal sửa khóa học**: đổi tên, ẩn/hiện, xóa khóa thủ công
- **Lesson edit panel**: đổi YouTube ID, thêm tài liệu Google Drive bổ sung
- Nút "⚡ Làm phẳng" từng chương hoặc toàn bộ
- Nút "🔄 Reset khóa học" — backup chỉnh sửa thành node `modified_*` rồi restore gốc
- Nút "🔄 Reset tất cả khóa học" — xóa toàn bộ patch course

---

#### 🔐 Admin Check — Nâng cấp bảo mật

**v1:** `if (user.email !== ADMIN_EMAIL)` — hardcode, một email duy nhất.

**v2:**
- Check Firestore collection `admins` — thêm/xóa admin không cần deploy
- Render table dùng DOM API thay `innerHTML` — không còn XSS từ tên bài học

---

#### 🎨 Theme System — File mới (`color-settings.js` + `color-settings.css`)

**v1:** Không có. Màu hardcode trong `style.css`.

**v2:**
- **Hue slider** thay đổi toàn bộ 17+ CSS token theo HSL
- **Blob color picker** chọn màu nền động riêng
- **Per-token override** trong tab "Nâng cao" — chỉnh từng màu CSS variable
- Bật/tắt animation + speed slider cho blob
- Bật/tắt glassmorphism (`no-glass` class)
- Lưu toàn bộ vào `localStorage`, restore khi load lại
- Design token chuyển từ màu hex cứng sang **HSL dynamic** (17 biến)

---

#### 🌊 Blob Background — Nâng cấp `bg.js`

**v1:** Animation đơn giản, không có API ngoài, màu fix cứng.

**v2:**
- **`BlobController`** public API: `setPalette(hue)`, `setPaletteFromHsl(h,s,l)`, `setSpeed(mul)`, `toggle(bool)`, `setBgColor(color)`
- Palette 8 màu sinh động từ HSL người dùng chọn
- **Speed multiplier** — scale cả velocity và noise force
- **Toggle** dừng RAF loop hoàn toàn khi tắt — không tốn CPU
- Màu nền canvas đồng bộ với `--color-bg` token khi đổi theme

---

#### 🏗️ Design System — Refactor `style.css`

**v1:** ~15 biến CSS, màu hex cứng (`#17274D`, `#0091EA`...).

**v2:**
- 40+ design token phân nhóm rõ ràng: Backgrounds, Surfaces, Borders, Accents, Semantic, Text, Progress, Dimensions
- Toàn bộ chuyển sang **HSL** để color-settings.js có thể điều chỉnh động
- Thêm token cho Plyr.js (tooltip, menu, badge, controls)
- `btn` component dùng CSS custom properties (`--btn-bg`, `--btn-border`, `--btn-text`) thay vì override trực tiếp
- Glass hover states tách thành token riêng (`--color-border-glass-hover`)
- `el()` DOM helper thay thế `innerHTML` string concatenation

---

#### 🗂️ Files mới thêm trong v2

| File | Mô tả |
|---|---|
| `overrides.js` | Toàn bộ override engine (merge, patch, undo/redo, backup) |
| `color-settings.js` | Theme editor logic + BlobController bridge |
| `color-settings.css` | UI cho theme editor popup |
