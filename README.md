# 😈 BrightWeb — Nền tảng học chui trực tuyến

> **Tự động đồng bộ cấu trúc khóa học từ Google Drive + video từ YouTube → hiển thị thành web học tập đầy đủ tính năng, với lớp override thủ công mạnh mẽ không phá vỡ dữ liệu gốc.**

---

## 📋 Mục lục

- [Tổng quan](#tổng-quan)
- [Tính năng chính](#tính-năng-chính)
- [Tính năng nổi bật](#tính-năng-nổi-bật)
- [Kiến trúc hệ thống](#kiến-trúc-hệ-thống)
- [Tech stack](#tech-stack)
- [Cài đặt & Cấu hình](#cài-đặt--cấu-hình)
- [Cách hoạt động](#cách-hoạt-động)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)

---

## Tổng quan

BrightWeb là một web app học tập **hoàn toàn static** (không cần server), được thiết kế để:

1. **Tự động crawl** cấu trúc thư mục Google Drive → sinh cây khóa học/chương/bài
2. **Tự động ánh xạ** video YouTube vào đúng bài học dựa theo **prefix số** trong tên (`020301 ~ Tên bài`)
3. **Hiển thị** thành giao diện học tập đầy đủ: sidebar cây bài học, video player, tài liệu, theo dõi tiến độ
4. Cho phép admin **chỉnh sửa thủ công** bất kỳ thứ gì mà **không đụng đến dữ liệu gốc** — toàn bộ override được lưu riêng và merge tại runtime

Pipeline chạy hoàn toàn tự động mỗi 6 tiếng qua **GitHub Actions**, không cần backend riêng.

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

### 🔐 Xác thực & Phân quyền

- Đăng nhập Google OAuth qua Firebase Auth
- **Whitelist-based**: chỉ email được thêm vào Firestore `whitelist` collection mới truy cập được
- **Admin check**: kiểm tra collection `admins` riêng — admin thấy thêm panel chỉnh sửa
- Log tất cả truy cập trái phép vào `security_logs` với timestamp và User-Agent

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

- Lưu `watchedTime` và `duration` vào **localStorage** sau mỗi 5 giây
- Sync lên Firestore khi: pause, ended, chuyển bài, đóng tab (visibilitychange / pagehide)
- **Auto-resume**: tự seek đến vị trí đã xem lần trước khi mở lại bài
- Hiển thị % tiến độ theo từng bài (minibar), từng chương (arc tròn SVG), từng khóa học
- Đánh dấu hoàn thành tự động khi video kết thúc (nếu đã xem gần hết)
- Firestore ↔ localStorage 2-chiều: lấy về dữ liệu mới hơn khi đăng nhập thiết bị khác

### 🎬 Video Player (Plyr.js + YouTube)

- Ẩn toàn bộ UI YouTube gốc (nocookie + `pointer-events: none` trên iframe)
- Custom poster với thumbnail HD, tên video tự fetch qua **YouTube oEmbed API** (không cần API key)
- Poster fade out khi video bắt đầu phát (trigger `playing`, không phải `play` — tránh flash)

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

### 🎨 Theme System (color-settings.js)

- **Hue slider** thay đổi toàn bộ color scheme (HSL-based, 17+ design token)
- **Blob color picker**: chọn màu nền động riêng biệt
- Per-token override: chỉnh từng màu CSS variable riêng lẻ trong tab "Nâng cao"
- Bật/tắt animation nền (tiết kiệm CPU) + điều chỉnh tốc độ blob
- Bật/tắt glassmorphism effect
- Lưu vào `localStorage`, restore khi load lại trang

---

## Tính năng nổi bật

### 🌊 Animated Blob Background (bg.js)

Hệ thống nền động viết thuần JavaScript + Canvas 2D, không dùng thư viện:

- 11 blob với vòng đời độc lập: fade-in → hold → fade-out → rebirth ở rìa màn hình
- Noise-based movement (sin nhiều tần số) cho chuyển động tự nhiên, không lặp
- `BlobController` API public: `setPalette(hue)`, `setSpeed(mul)`, `toggle(bool)`, `setBgColor(color)`
- Palette sinh động: 8 màu tối dần từ màu người dùng chọn, scale tuyến tính theo lightness
- Dừng RAF loop khi toggle off → không tốn CPU

### 🔮 WebGL Glassmorphism (container.js + button.js)

Glass effect thực sự bằng **WebGL** — không chỉ là `backdrop-filter`:

- Chụp snapshot trang bằng `html2canvas` làm texture nền
- Fragment shader tính toán **refraction** (khúc xạ ánh sáng) tại rìa và góc
- Hỗ trợ 3 hình dạng: `rounded`, `pill`, `circle` — detect tự động trong shader
- Nested glass: nút bên trong container dùng canvas của container cha làm texture
- Render loop riêng cho từng instance, cập nhật vị trí theo scroll

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

Merge chạy lại sau **mỗi** thao tác save, đảm bảo UI luôn nhất quán với state.

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
- Cut/Copy/Paste node qua toolbar hoặc phím tắt Ctrl+X/C
- Paste vào chương đích (hoặc root khóa học)
- Keyboard: `Del` ẩn node được chọn, `Esc` hủy selection/clipboard

### 💾 Backup / Restore

- Xuất file JSON chứa: `mergedCourses` + `rawAutoData` + `overrides`
- Restore bằng cách upload lại — ghi đè toàn bộ override hiện tại
- Nút "Reset về gốc" cho từng khóa học: backup các chỉnh sửa thủ công thành node `modified_*` rồi restore cấu trúc Drive gốc

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
│               GitHub Actions (mỗi 6h)                       │
│  sync_drive.py                                              │
│    read_drive() → build_drive_tree_fast()                   │
│    read_youtube() → fetch_playlist_items() ──────────────┐  │
│    assign_videos(prefix match) ◄─────────────────────────┘  │
│    build_output() → push_to_firestore()                     │
└─────────────────────────────────────────────────────────────┘
                              │
                    Firestore: app_data/courses
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                   index.html (Browser)                      │
│                                                             │
│  Firebase Auth ──► checkAccess (whitelist + admins)         │
│                                                             │
│  loadData()                                                 │
│    ├── Firestore: app_data/courses  (rawAutoData)           │
│    └── Firestore: app_data/overrides (_overrides)           │
│                              │                              │
│              getMergedCourses(rawAutoData, overrides)       │
│                              │                              │
│              appData.courses  ──►  renderHome/Course/Lesson │
│                                                             │
│  Admin Edit ──► patchNode() ──► saveOverrides()             │
│              ──► _recomputeMerged() ──► re-render           │
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
| Background FX | Canvas 2D (blob animation) |
| Glass FX | WebGL (custom GLSL shaders) |
| Particle | particles.js 2.0.0 |
| Screenshot | html2canvas 1.4.1 |
| Auto-Sync | Python 3.11, GitHub Actions |
| Drive API | google-api-python-client |
| Sync Trigger | Cloudflare Worker (proxy GitHub REST API) |
| Hosting | GitHub Pages (static) |

---

## Cài đặt & Cấu hình

### GitHub Secrets cần thiết

| Secret | Mô tả |
|---|---|
| `GOOGLE_CREDENTIALS_JSON` | Service Account JSON có quyền Drive read |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key |
| `YOUTUBE_OAUTH_JSON` | OAuth2 token JSON (để đọc video Unlisted) |
| `YOUTUBE_CHANNEL_ID` | Channel ID dạng `UCxxxxxxxx` |
| `DRIVE_ROOT_FOLDER_ID` | ID folder gốc trên Google Drive |
| `FIRESTORE_PROJECT_ID` | Firebase project ID |

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
whitelist/        {email}  → { addedAt }
admins/           {email}  → {}
app_data/courses           → { json: string, updatedAt }
app_data/overrides         → { v, patches, manualNodes, ... }
progress/         {uid_lid} → { userId, lessonId, watched, watchedTime, duration }
security_logs/             → { email, name, time, ua }
```

---

## Cách hoạt động

### Sync tự động

1. GitHub Actions chạy `sync_drive.py` mỗi 6 tiếng (hoặc trigger thủ công)
2. Script đọc toàn bộ cấu trúc Drive, lọc thư mục có prefix `NN ~`
3. Đọc tất cả video từ `uploads` playlist của channel, lọc video có prefix 6 số
4. Ghép video vào đúng bài học theo prefix
5. Push JSON lên Firestore — **không commit vào repo**

### Trigger thủ công từ web

Nút "Sync ngay" trong Admin Panel → gọi Cloudflare Worker → Worker xác thực Firebase ID Token → gửi `repository_dispatch` lên GitHub API → GitHub Actions chạy ngay.

### Merge override tại runtime

Khi tải trang, browser fetch cả `courses` và `overrides` từ Firestore, sau đó `getMergedCourses()` merge theo thứ tự ưu tiên: override luôn thắng data gốc, nhưng data gốc không bị mất — khi xóa override thì data gốc tự phục hồi.

---

## Cấu trúc thư mục

```
brightweb/
├── index.html          # App chính — toàn bộ UI + logic
├── overrides.js        # Override engine: merge, patch, undo/redo, backup
├── bg.js               # Animated blob background (Canvas 2D)
├── container.js        # WebGL glass container
├── button.js           # WebGL nested glass button
├── glass.css           # CSS cho WebGL glass elements
├── style.css           # Design system: tokens, layout, components
├── color-settings.css  # Theme editor UI
├── color-settings.js   # Theme editor logic + BlobController bridge
├── admin-check.html    # Tool đối chiếu 3 nguồn dữ liệu video
├── admin-check.js      # Logic check & report
├── admin-check.css     # Styles cho tool
├── sync_drive.py       # Script sync Drive + YouTube → Firestore
├── requirements.txt    # Python deps
└── .github/
    └── workflows/
        └── sync.yml    # GitHub Actions pipeline
```

---

## Một số chi tiết kỹ thuật thú vị

- **Không có `innerHTML` cho data từ Firestore**: toàn bộ render dùng DOM API (`createElement`, `textContent`) để tránh XSS, ngay cả khi render hàng trăm node trong tree
- **CSP nghiêm ngặt**: Content-Security-Policy header giới hạn script/style/connect chỉ từ domain whitelist
- **Firebase API key public là intentional**: bảo mật thực sự nằm ở Firestore Security Rules và server-side whitelist check, không phải ở việc giấu API key
- **Plyr iframe `pointer-events: none`**: overlay div trong suốt nhận keyboard event, iframe YouTube không nhận — tránh YouTube steal focus
- **Progress flush nhiều cơ chế**: `pause`, `ended`, `visibilitychange`, `pagehide` — đảm bảo không mất dữ liệu ngay cả khi đóng tab đột ngột
- **Undo stack serialize toàn bộ `_overrides`**: đơn giản nhưng hiệu quả — JSON.stringify/parse đủ nhanh cho object kích thước này
