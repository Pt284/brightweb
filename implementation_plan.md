# Implementation Plan: HocMai Calendar Crawler & Live Integration

---

## KIỂM TRA LỖI CÁC FILE HIỆN TẠI

### `crawl_calendar.py` — Vấn đề cần sửa:
1. **[LỖI BẢO MẬT]** Dòng 19-21 hardcode URL:
   ```
   CALENDAR_URL = "https://hocmai.vn/study/calendar"
   LOGIN_URL    = "https://hocmai.vn/users/login"
   LOGOUT_URL   = "https://hocmai.vn/users/logout"
   ```
   → Phải xóa hoàn toàn, đọc từ env var.

2. **[THIẾU]** Không có logic phát hiện và trích xuất link m3u8.

3. **[THIẾU]** Không có logic kiểm tra giờ để quyết định crawl nhanh hay chậm (smart cron).

4. **[THIẾU]** Không có trường `m3u8`, `liveStartEpoch`, `courseId`, `lessonId` trong output JSON gửi Firestore.

5. **[LỖI NHỎ]** `parse_events_from_page()` dùng JS evaluate để lấy DOM — logic đúng, nhưng cần thêm xử lý parse thời gian "21 giờ" → "21:00" để chuẩn hóa.

### `.github/workflows/crawl_calendar.yml` — Vấn đề cần sửa:
1. **[THIẾU]** Không có `HOCMAI_BASE_URL` trong env secrets.
2. **[THIẾU]** Chỉ có 1 schedule (mỗi 6 tiếng). Cần thêm schedule chạy mỗi 5 phút vào khung giờ cao điểm buổi tối.
3. **[THIẾU]** Không có input `mode` để phân biệt "full crawl" vs "pre-class watch mode".

### `app.js` — Vấn đề cần sửa:
1. **[THIẾU]** `renderCalDay()` tạo `.cal-event` dạng `div` tĩnh, không có `onclick` để navigate.
2. **[THIẾU]** Không có thuật toán fuzzy match tên bài calendar → lesson trong appData.
3. **[THIẾU]** Không có logic live: không phát m3u8, không có HLS player, không auto-open live.
4. **[THIẾU]** Không có header banner thông báo live hôm nay.
5. **[THIẾU]** Không có flash animation khi bấm nút "Hôm nay".
6. **[THIẾU]** `_calEvents` cache dùng biến module-level, không force-refresh khi GitHub Actions cập nhật Firestore. Cần thêm TTL (ví dụ cache 3 phút, sau đó refetch).
7. **[THIẾU]** Không xử lý hash `#calendar` trong `handleHash()`.
8. **[LỖI]** `loadCalendarData()` cache `_calEvents` vĩnh viễn (không refetch). Cần invalidate sau N phút.

### `index.html` — Vấn đề cần sửa:
1. **[THIẾU]** Không có `hls.js` CDN script (cần để phát m3u8).
2. **[THIẾU]** Không có `<div id="live-modal">` cho player toàn màn hình.
3. **[THIẾU]** Không có `<div id="live-banner">` trên header.

### `style.css` — Bổ sung cần thêm:
1. **[THIẾU]** Style cho `#live-banner` trên header.
2. **[THIẾU]** Style cho `#live-modal` (overlay toàn màn hình).
3. **[THIẾU]** CSS animation `@keyframes flash-today` để nhấp nháy ô hôm nay.

---

## GITHUB SECRETS CẦN TẠO

| Tên Secret | Giá trị mẫu | Mục đích |
|---|---|---|
| `HMUSERNAME` | (tài khoản HocMai) | Đăng nhập |
| `HMPASSWORD` | (mật khẩu HocMai) | Đăng nhập |
| `HOCMAI_BASE_URL` | `https://hocmai.vn` | Tên miền gốc (ẩn khỏi mã nguồn) |
| `HOCMAI_CAL_PATH` | `/study/calendar` | Đường dẫn calendar (ẩn khỏi mã nguồn) |
| `HOCMAI_LOGIN_PATH` | `/users/login` | Đường dẫn login |
| `HOCMAI_LOGOUT_PATH` | `/users/logout` | Đường dẫn logout | COMMENT: PHẢI VÀO https://hocmai.vn/loginv2/logout.php VÀ ẤN NÚT CÓ HOẶC NẾU BIẾT SESSION KEY THÌ CÓ THỂ request giống "C:\Users\pt29\3D Objects\brightweb\LOGOUT.HAR"
| `GOOGLE_CREDENTIALS_JSON` | (Service Account JSON) | Đã có |
| `FIRESTORE_PROJECT_ID` | (Project ID) | Đã có |

---

## PHẦN 1: PYTHON SCRIPT (`crawl_calendar.py`)

### 1.1 Cấu hình ENV (thay thế hardcode URL)

```
HOCMAI_BASE     = os.environ.get("HOCMAI_BASE_URL", "")
HOCMAI_CAL_PATH = os.environ.get("HOCMAI_CAL_PATH", "")
CALENDAR_URL    = HOCMAI_BASE + HOCMAI_CAL_PATH
LOGIN_URL       = HOCMAI_BASE + os.environ.get("HOCMAI_LOGIN_PATH", "")
LOGOUT_URL      = HOCMAI_BASE + os.environ.get("HOCMAI_LOGOUT_PATH", "")
```
Nếu `HOCMAI_BASE` là chuỗi rỗng → script thoát luôn với error rõ ràng.

### 1.2 Chuẩn hóa giờ từ DOM

Hàm `normalize_time(raw: str) -> str`:
- Input: "21 giờ", "21:30", "9h tối", "9h30"
- Output: "21:00", "21:30", "21:00", "09:30" (định dạng HH:MM 24h)
- Logic: tìm số đầu tiên = giờ, số thứ hai (nếu có) = phút; nếu chuỗi có từ "giờ" và không có phút, phút = 0; chuyển sang int, trả về f"{h:02d}:{m:02d}".

### 1.3 Schema event đầy đủ trong Firestore

Mỗi event lưu vào `app_data/schedule.json` có cấu trúc:
```json
{
  "date": "2026-06-25",
  "time": "21:00",
  "subject": "Toán",
  "title": "Tên bài học từ lịch",
  "color": "rgba(19, 91, 236, 1)",
  "status": "upcoming",
  "m3u8": null,
  "liveStartEpoch": null
}
```
- `m3u8`: null cho đến khi crawl được từ trang live; sau đó là URL chuỗi đầy đủ.
- `liveStartEpoch`: Unix timestamp (ms) lúc phát hiện m3u8 lần đầu, dùng để tính thời lượng đã live.
- `status`: "past" / "upcoming" / "live" (live = đang diễn ra, tức là m3u8 đã có và thời gian chưa qua 3 tiếng).

### 1.4 Logic crawl m3u8

Playwright có thể dùng network interception để bắt request. Logic:

**Bước A — Phát hiện event hôm nay đang live:**
1. Sau khi load trang calendar, lấy danh sách tất cả `.fc-event` trong ngày hôm nay (date == today).
2. Với mỗi event có class `event-open` (nghĩa là đang trong giờ học): click vào element đó.
3. Playwright sẽ theo dõi `page.on("response", handler)` — handler kiểm tra `response.url()` xem có kết thúc bằng `.m3u8` không.
4. Nếu click mở ra popup (window mới): dùng `context.expect_page()` để bắt page mới, set response listener trên page mới đó.
5. Nếu click mở player trên cùng trang: response listener trên `page` hiện tại sẽ bắt được.
6. Chờ tối đa 15 giây sau khi click.

**Bước B — Pattern regex dự phòng:**
Nếu không bắt được qua network: sau khi click và trang load xong, lấy `page.content()` và dùng regex:
```
pattern = r"https://[a-zA-Z0-9\-\.]+/live/[a-f0-9]+/playlist\.m3u8"
```
Match đầu tiên tìm được = link m3u8.

**Bước C — Giờ bắt đầu live:**
Khi tìm được m3u8 lần đầu tiên, lưu `liveStartEpoch = int(time.time() * 1000)`. Nếu event đã có m3u8 trong Firestore từ lần crawl trước, **giữ nguyên** `liveStartEpoch` cũ (không ghi đè).

### 1.5 Chiến lược Cron — "Smart Crawl"

GitHub Actions không cho phép cron dưới 5 phút. Giải pháp:

**Workflow chạy 5 phút/lần trong khung giờ buổi tối (19h-22h30 VN = 12h-15h30 UTC).**

Script Python nhận biến `CRAWL_MODE` từ env:

**Mode 1: `full`** (chạy hàng ngày 1-2 lần):
- Đăng nhập (nếu cần), crawl lịch 6 tháng, lưu tất cả events lên Firestore `app_data/schedule`.
- Không cần check giờ, không cần tìm m3u8.
- Mục đích: cập nhật danh sách buổi học (tiêu đề, thời gian, màu sắc).

**Mode 2: `watch`** (chạy 5 phút/lần trong khung giờ):
- Đọc `app_data/schedule` hiện tại từ Firestore.
- Lấy danh sách events **hôm nay** (theo giờ VN = UTC+7).
- Phân tích: có event nào trong vòng 40 phút tới không (so sánh giờ event với giờ hiện tại)?
  - **KHÔNG**: thoát ngay. (Tiết kiệm tài nguyên, toàn bộ job chỉ tốn ~10 giây).
  - **CÓ**: tiến vào "watch loop".

**Watch Loop trong một lần chạy duy nhất:**
1. Đăng nhập vào HocMai (dùng cookie từ Firestore, nếu hết thì login lại).
2. Mở trang calendar, tìm event hôm nay.
3. Kiểm tra xem event hôm nay đã có class `event-open` chưa.
   - Nếu chưa: cập nhật thời gian bắt đầu live trong Firestore (nếu thời gian thay đổi so với lần crawl trước → đây là trường hợp "lùi lịch") rồi thoát.
   - Nếu rồi: thực hiện Bước A để lấy m3u8, push lên Firestore với `status: "live"`, rồi thoát.
4. Sau khi xử lý xong, đăng xuất nếu đã login bằng mật khẩu.

**Logic phát hiện "lùi lịch":**
- Lần crawl trước ghi vào Firestore: `event.time = "21:00"`.
- Lần crawl hiện tại đọc DOM và thấy `event.time = "21:30"`.
- Nếu thời gian khác nhau → cập nhật Firestore với thời gian mới.
- Client (app.js) sẽ đọc lại Firestore và thấy thời gian đã thay đổi, cập nhật banner.

---

## PHẦN 2: GITHUB ACTIONS WORKFLOW

### Schedule:

```yaml
on:
  schedule:
    # Full crawl: 1 lần/ngày lúc 3h sáng VN (20:00 UTC ngày hôm trước)
    - cron: "0 20 * * *"
    # Watch mode: mỗi 5 phút trong khung 19h-22h30 VN (12:00-15:30 UTC)
    - cron: "*/5 12-15 * * *"
    # Watch mode thêm: 15h30-16h UTC = 22h30-23h VN (phòng hờ bài muộn)
    - cron: "*/5 15 * * *"
  workflow_dispatch:
    inputs:
      mode:
        description: "full | watch"
        default: "full"
      months:
        description: "Số tháng crawl (chỉ dùng khi mode=full)"
        default: "6"
```

### Logic trong workflow xác định mode:
- Nếu cron trigger và giờ UTC là 20:xx → mode = "full".
- Nếu cron trigger và giờ UTC là 12:xx-15:xx → mode = "watch".
- Nếu `workflow_dispatch` → dùng input.

Truyền vào script:
```yaml
env:
  HOCMAI_BASE_URL:    ${{ secrets.HOCMAI_BASE_URL }}
  HOCMAI_CAL_PATH:    ${{ secrets.HOCMAI_CAL_PATH }}
  HOCMAI_LOGIN_PATH:  ${{ secrets.HOCMAI_LOGIN_PATH }}
  HOCMAI_LOGOUT_PATH: ${{ secrets.HOCMAI_LOGOUT_PATH }}
  CRAWL_MODE:         ${{ ... }}  # full hoặc watch
  MONTHS_TO_CRAWL:    ${{ ... }}
  HMUSERNAME:         ${{ secrets.HMUSERNAME }}
  HMPASSWORD:         ${{ secrets.HMPASSWORD }}
  GOOGLE_CREDENTIALS_JSON: ${{ secrets.GOOGLE_CREDENTIALS_JSON }}
  FIRESTORE_PROJECT_ID:    ${{ secrets.FIRESTORE_PROJECT_ID }}
```

---

## PHẦN 3: APP.JS — CALENDAR MODULE (LOGIC CHI TIẾT)

### 3.1 Firestore Data — Cache với TTL

Thay vì cache vĩnh viễn, thêm biến `_calEventsLoadedAt = null` (timestamp).
`loadCalendarData()` logic:
- Nếu `_calEvents` là null → fetch.
- Nếu `_calEvents` không null nhưng `Date.now() - _calEventsLoadedAt > 3 * 60 * 1000` (3 phút) → refetch.
- Sau khi fetch thành công: ghi `_calEventsLoadedAt = Date.now()`.

### 3.2 Hash Routing cho Calendar

Trong `handleHash()`, thêm:
```
if (p[0] === 'calendar') { renderCalendar(); return; }
```

### 3.3 Click Event trên Lịch — Navigate hoặc mở Live

Sau khi `renderCalendar()` inject HTML vào DOM, dùng **event delegation** (không thêm onclick vào từng div):
```
document.getElementById('cal-content').addEventListener('click', function(e) {
  const eventEl = e.target.closest('.cal-event');
  if (!eventEl) return;
  const dateStr = eventEl.closest('.cal-day, .cal-list-event')?.dataset.date
               || eventEl.dataset.date; // fallback
  const subjectText = eventEl.querySelector('.cal-event-subject')?.textContent?.trim();
  const titleText   = eventEl.querySelector('.cal-event-title')?.textContent?.trim();
  handleCalendarEventClick({ date: dateStr, subject: subjectText, title: titleText });
});
```

> Quan trọng: Thêm `data-date` vào cả `.cal-event` (không chỉ `.cal-day`) để delegation hoạt động.

**Hàm `handleCalendarEventClick(ev)`:**
1. Tìm event tương ứng trong `_calEvents` theo `date + subject + title`.
2. Nếu event có `m3u8` và status là "live": gọi `openLiveModal(event)`.
3. Nếu không: gọi `navigateToMappedLesson(event)`.
4. Nếu không tìm được lesson: gọi `navigate('home')`.

### 3.4 Ánh xạ Môn Học → Course ID

Bảng mapping cứng trong `app.js`:
```javascript
const SUBJECT_TO_COURSE_ORDER = {
  "Toán": 3,
  "Tư duy toán": 3,
  "Đọc hiểu": 5,
  "Sinh học": 4,
  "Vật lí": 4,
  "Hóa học": 4,
  "Tư duy khoa học": 4,
};
```

Hàm `findCourseBySubject(subject)`:
- Lookup `SUBJECT_TO_COURSE_ORDER[subject]` → `order`.
- Duyệt qua `appData.courses`, tìm course có `order == courseOrder`.
- Trả về course object hoặc null.

### 3.5 Fuzzy Match Tên Bài

**Thuật toán Jaccard Similarity (không cần thư viện):**

Hàm `normalizeTitle(str)`:
1. Loại bỏ dấu tiếng Việt: dùng `str.normalize("NFD").replace(/[\u0300-\u036f]/g, "")`.
2. Loại bỏ ký tự đặc biệt, giữ chữ và số: `str.replace(/[^a-zA-Z0-9\s]/g, "")`.
3. Chuyển chữ thường, xóa khoảng trắng thừa, split thành mảng từ.
4. Loại bỏ stopwords ngắn: "va", "va", "cac", "mot", "cua", "trong", "la".

Hàm `jaccardSimilarity(setA, setB)`:
- `intersection = setA.filter(w => setB.includes(w)).length`
- `union = new Set([...setA, ...setB]).size`
- Trả về `intersection / union` (0.0 → 1.0).

Hàm `navigateToMappedLesson(calEvent)`:
1. `course = findCourseBySubject(calEvent.subject)` → nếu null → navigate về course tương ứng hoặc home.
2. Normalize `calEvent.title` → `calTokens`.
3. Lấy tất cả lessons từ `getAllLessons(course.tree)` (hàm đệ quy đã có trong codebase).
4. Với mỗi lesson: normalize `lesson.title` → `lessonTokens`. Tính `score = jaccardSimilarity(calTokens, lessonTokens)`.
5. Tìm lesson có `score` cao nhất.
6. Nếu `bestScore >= 0.35` → `navigate('lesson', course.id, bestLesson.id)`.
7. Nếu `bestScore < 0.35` → `navigate('course', course.id)` (vào trang khóa học mà không chọn bài cụ thể).

### 3.6 Header Live Banner

HTML thêm vào `index.html` trong `#header`:
```html
<div id="live-banner" style="display:none">
  <span id="live-banner-icon">🔴</span>
  <span id="live-banner-text"></span>
</div>
```

Hàm `updateLiveBanner()` — gọi sau `loadData()` và mỗi 60 giây:
1. Lấy events từ `_calEvents` (hoặc gọi `loadCalendarData()`).
2. Lấy events hôm nay: `todayStr = YYYY-MM-DD`.
3. Lấy giờ hiện tại (VN) = `new Date()` + offset UTC+7.
4. Ưu tiên tìm event `status === 'live'` (m3u8 đã có) hoặc event có `time` trong vòng 60 phút tới.
5. Nếu tìm được:
   - `banner.style.display = 'flex'`.
   - Nếu là "live": icon `🔴`, text `"ĐANG LIVE: [subject] — [title]"`, class `live-active`.
   - Nếu là "sắp live": icon `📅`, text `"Sắp học: [time] — [subject] — [title]"`, class `live-upcoming`.
   - Thêm `onclick` gọi `handleCalendarEventClick(event)`.
6. Nếu không có event nào phù hợp: ẩn banner.

Khởi động: gọi `updateLiveBanner()` trong `auth.onAuthStateChanged` sau `loadData()`. Sau đó `setInterval(updateLiveBanner, 60000)`.

### 3.7 Auto-open Live khi vào trang

Sau `loadData()` trong `auth.onAuthStateChanged`:
1. Gọi `loadCalendarData()`.
2. Tìm event hôm nay có `m3u8 !== null` VÀ `status === 'live'`.
3. Kiểm tra `sessionStorage.getItem('live_opened_session')`:
   - Nếu giá trị trùng với `event.date + '_' + event.time` → không auto-open (đã mở lần này rồi).
   - Nếu khác (hoặc null) → gọi `openLiveModal(event)`.
4. Sau khi mở: `sessionStorage.setItem('live_opened_session', event.date + '_' + event.time)`.

### 3.8 HLS Live Player Modal

Hàm `openLiveModal(event)`:
1. Hiển thị `<div id="live-modal">` (overlay toàn màn hình).
2. Set tiêu đề modal: `event.subject + " — " + event.title`.
3. Tạo hoặc reuse `<video id="live-video">` bên trong modal.
4. Khởi tạo `Hls`:
   ```javascript
   if (Hls.isSupported()) {
     const hls = new Hls();
     hls.loadSource(event.m3u8);
     hls.attachMedia(videoEl);
   } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
     // Safari native HLS
     videoEl.src = event.m3u8;
   }
   ```
5. Bọc video bằng Plyr: `new Plyr(videoEl, { controls: ['play', 'progress', 'current-time', 'mute', 'volume', 'fullscreen'] })`.
6. Thêm nút "Chuyển sang bài học" → gọi `navigateToMappedLesson(event)` rồi đóng modal.
7. Thêm nút đóng X → gọi `closeLiveModal()`.

**Hiển thị thời gian đã live (không phải seek bar):**
- Nếu `event.liveStartEpoch` tồn tại: `elapsed = Date.now() - event.liveStartEpoch`.
- Hiển thị dưới dạng `"Đã phát: HH:MM:SS"` bên cạnh tiêu đề, cập nhật mỗi giây bằng `setInterval`.
- Sau khi reload trang: `liveStartEpoch` vẫn còn trong Firestore → tính toán đúng.
- Plyr HLS sẽ tự động seek tới đầu live stream, không hỗ trợ tua (đây là giới hạn kỹ thuật của HLS live không có DVR).

### 3.9 Live trong Lesson View

Trong hàm `renderLesson(courseId, lessonId)` (đã có trong codebase), sau khi render xong:
1. Gọi `getActiveLiveForLesson(courseId, lessonId)`:
   - Lấy `_calEvents`, tìm event hôm nay, gọi `jaccardSimilarity()` với lesson hiện tại.
   - Nếu tìm được event có m3u8 và score >= 0.35 → trả về event đó.
2. Nếu kết quả không null: chèn vào đầu `.lesson-main` một banner:
   ```html
   <div class="live-in-lesson-banner">
     🔴 ĐANG LIVE — [title]
     <button onclick="openLiveModal(event)">▶ Xem ngay</button>
   </div>
   ```

### 3.10 Nút "Hôm nay" + Flash Animation

Trong `_initCalendarButtons()`, nút `cal-today-btn`:
```javascript
on('cal-today-btn', () => {
  _calViewDate = new Date();
  renderCalendar().then(() => {
    // Sau khi render xong, tìm ô today và thêm class flash
    const todayCell = document.querySelector('.cal-day.today');
    if (todayCell) {
      todayCell.classList.add('flash-today');
      setTimeout(() => todayCell.classList.remove('flash-today'), 2000);
    }
    // Trong list view: scroll ô today vào viewport
    const todayGroup = document.querySelector('.cal-list-date-header.is-today');
    if (todayGroup) todayGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
```

CSS animation `flash-today`:
```css
@keyframes flash-today {
  0%, 100% { background: var(--color-accent-alpha); }
  50% { background: hsla(203, 100%, 46%, 0.35); box-shadow: 0 0 12px var(--color-accent); }
}
.flash-today { animation: flash-today 0.5s ease-in-out 3; }
```

---

## PHẦN 4: HTML & CSS BỔ SUNG

### index.html — Cần thêm:
1. **hls.js CDN** (trước `app.js`):
   ```html
   <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
   ```
2. **Live Banner** trong `#header` (sau user-info, trước btn-signout):
   ```html
   <div id="live-banner" style="display:none">
     <span id="live-banner-icon">🔴</span>
     <span id="live-banner-text">Đang live...</span>
   </div>
   ```
3. **Live Modal** (trước `</body>`):
   ```html
   <div id="live-modal" style="display:none">
     <div id="live-modal-inner">
       <div id="live-modal-header">
         <span id="live-modal-title"></span>
         <span id="live-elapsed"></span>
         <button id="live-modal-close">✕</button>
       </div>
       <div id="live-modal-body">
         <video id="live-video" playsinline></video>
       </div>
       <div id="live-modal-footer">
         <button id="live-goto-lesson">Chuyển sang bài học →</button>
       </div>
     </div>
   </div>
   ```
4. **Thêm data-date cho `.cal-event`**: Xem mục 3.3. HTML được sinh ra từ `renderCalDay()` trong `app.js` phải thêm `data-date="${dateStr}"` vào mỗi `.cal-event`.

### style.css — Cần thêm:
- `#live-banner`: flex row, background gradient đỏ → cam (khi live) hoặc vàng (khi sắp live), font bold, cursor pointer, padding 4px 12px, border-radius pill.
- `.live-active` vs `.live-upcoming`: màu sắc khác nhau (đỏ vs vàng/amber), animation pulse nhẹ.
- `#live-modal`: `position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center`.
- `#live-modal-inner`: glassmorphism, `max-width: 900px; width: 95%; border-radius: 16px; overflow: hidden`.
- `.live-in-lesson-banner`: banner đỏ trong lesson view, full width, dùng màu CSS web.

---

## TÍNH NĂNG BỔ SUNG ĐỀ XUẤT (không bắt buộc)

1. **Thông báo trình duyệt (Notification API)**: Khi đến giờ học, nếu user đang mở tab khác, gửi push notification của trình duyệt.
2. **Đồng hồ đếm ngược**: Trong banner và trang calendar, hiển thị đếm ngược đến giờ học tiếp theo.
3. **Màu theo môn học**: Áp dụng `event.color` (đã crawl từ HocMai) trực tiếp vào ban live và dot trong banner để đồng nhất với màu môn học của HocMai.
4. **Lịch sử live đã qua**: Các event `status = 'past'` vẫn có thể có recording (nếu HocMai cung cấp). Có thể crawl thêm link VOD nếu có.

---

## THỨ TỰ THỰC HIỆN KHI VIẾT MÃ

1. **Sửa `crawl_calendar.py`**: xóa URL cứng, thêm normalize_time, thêm logic m3u8, thêm CRAWL_MODE.
2. **Sửa `.github/workflows/crawl_calendar.yml`**: cập nhật schedule cron, thêm env secrets mới, thêm logic xác định mode.
3. **Sửa `index.html`**: thêm hls.js CDN, live-banner, live-modal.
4. **Sửa `app.js`**:
   - Calendar module: thêm TTL cache, data-date vào cal-event, event delegation onclick.
   - Thêm SUBJECT_TO_COURSE_ORDER mapping.
   - Thêm normalizeTitle() + jaccardSimilarity() + navigateToMappedLesson().
   - Thêm updateLiveBanner() + setInterval.
   - Thêm openLiveModal() với hls.js + Plyr.
   - Thêm auto-open live sau loadData().
   - Thêm live-in-lesson banner trong renderLesson().
   - Sửa handleHash() để xử lý `#calendar`.
   - Sửa nút "Hôm nay" để flash animation.
5. **Sửa `style.css`**: thêm live-banner, live-modal, flash-today animation, live-in-lesson-banner.
