"""

crawl_calendar.py — HM-LEAKBASE
Crawl lịch học, lưu cookie vào Firestore.
- Nếu cookie còn dùng được → dùng luôn, không cần đăng nhập.
- Nếu cookie hết hạn → đăng nhập bằng HM_USERNAME/HM_PASSWORD,
  lấy cookie mới, lưu lên Firestore, crawl xong đăng xuất đúng flow.
- Dữ liệu lịch push lên Firestore app_data/schedule.
- Không có hardcode URL nào — toàn bộ lấy từ GitHub Secrets.
"""

import os, re, json, time, hashlib
from datetime import datetime, timezone, timedelta

# ── CONFIG (100% từ env, không hardcode URL) ─────────────────────────────────
HM_BASE            = os.environ.get("HM_BASE_URL", "")
HM_CAL_PATH        = os.environ.get("HM_CAL_PATH", "")
# Login: POST multipart/form-data đến /loginv2/index.php
HM_LOGIN_PATH      = os.environ.get("HM_LOGIN_PATH", "")   # e.g. /loginv2/index.php
# Logout bước 1: mở trang này để lấy sesskey
HM_LOGOUT_V2_PATH  = os.environ.get("HM_LOGOUT_V2_PATH", "")  # e.g. /loginv2/logout.php
# Logout bước 2: moodle logout endpoint (action của form trong trang logout.php)
HM_LOGOUT_FINAL    = os.environ.get("HM_LOGOUT_FINAL_PATH", "")  # e.g. /login/logout.php

HM_USERNAME  = os.environ.get("HM_USERNAME", "")
HM_PASSWORD  = os.environ.get("HM_PASSWORD", "")
GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON", "")
FIRESTORE_PROJECT_ID    = os.environ.get("FIRESTORE_PROJECT_ID", "")
CRAWL_MODE   = os.environ.get("CRAWL_MODE", "full")
MONTHS_TO_CRAWL = int(os.environ.get("MONTHS_TO_CRAWL", "6"))
HEADLESS     = os.environ.get("HEADLESS", "true").lower() != "false"


# ── SESSION ID & STARTAT HELPERS (dùng cho Web Push) ─────────────────────────
VN_TZ = timezone(timedelta(hours=7))   # múi giờ Việt Nam

def session_id(date_str: str, time_str: str, title: str) -> str:
    """Tạo ID duy nhất 16 ký tự cho mỗi buổi học, dựa trên date+time+title."""
    raw = f"{date_str}|{time_str}|{title}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:16]


def compute_start_at(date_str: str, time_str: str):
    """
    Chuyển giờ học VN (naive) sang ISO-8601 UTC.
    VD: date='2026-06-15', time='19:30' → '2026-06-15T12:30:00+00:00'
    KHÔNG gắn 'Z' vào giờ VN — phải quy đổi đúng sang UTC.
    Trả về None nếu parse lỗi.
    """
    try:
        naive = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
        vn_dt = naive.replace(tzinfo=VN_TZ)
        return vn_dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return None


def check_config():
    if not HM_BASE:
        raise ValueError("❌ Thiếu HM_BASE_URL trong environment secrets.")
    if not HM_CAL_PATH:
        raise ValueError("❌ Thiếu HM_CAL_PATH trong environment secrets.")
    if not HM_LOGIN_PATH:
        raise ValueError("❌ Thiếu HM_LOGIN_PATH trong environment secrets.")


# ── URL HELPERS ───────────────────────────────────────────────────────────────
def url(path: str) -> str:
    return HM_BASE.rstrip("/") + "/" + path.lstrip("/")


# ── FIRESTORE HELPERS ────────────────────────────────────────────────────────
def _get_firestore_token():
    import google.auth.transport.requests
    from google.oauth2 import service_account
    creds_info = json.loads(GOOGLE_CREDENTIALS_JSON)
    creds = service_account.Credentials.from_service_account_info(
        creds_info, scopes=["https://www.googleapis.com/auth/datastore"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token, (FIRESTORE_PROJECT_ID or creds_info.get("project_id", ""))


def _fs_url(project: str, doc_path: str) -> str:
    return (
        f"https://firestore.googleapis.com/v1/projects/{project}"
        f"/databases/(default)/documents/{doc_path}"
    )


def read_fs(doc_path: str) -> dict | None:
    import requests as req
    token, project = _get_firestore_token()
    r = req.get(_fs_url(project, doc_path),
                headers={"Authorization": f"Bearer {token}"}, timeout=15)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json().get("fields", {})


def write_fs(doc_path: str, fields: dict):
    import requests as req
    token, project = _get_firestore_token()
    r = req.patch(_fs_url(project, doc_path), json={"fields": fields},
                  headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Firestore write failed: {r.status_code} — {r.text[:300]}")


# ── COOKIE HELPERS ───────────────────────────────────────────────────────────
COOKIE_DOC = "app_data/hm_cookies"
SCHEDULE_DOC = "app_data/schedule"
LOPHOC_SESSION_DOC = "app_data/lophoc_session"


def load_cookies_from_firestore() -> list[dict] | None:
    try:
        fields = read_fs(COOKIE_DOC)
        if not fields:
            return None
        raw = fields.get("cookies", {}).get("stringValue", "")
        return json.loads(raw) if raw else None
    except Exception as e:
        print(f"  ⚠ Không đọc được cookie từ Firestore: {e}")
        return None


def save_cookies(cookies: list[dict]):
    write_fs(COOKIE_DOC, {
        "cookies":   {"stringValue": json.dumps(cookies, ensure_ascii=False)},
        "updatedAt": {"stringValue": datetime.now(timezone.utc).isoformat()}
    })
    print(f"  ✓ Đã lưu {len(cookies)} cookies lên Firestore")


def load_lophoc_session() -> dict | None:
    """Load lophoc session cache (UUID/JWT cookies) từ Firestore."""
    try:
        fields = read_fs(LOPHOC_SESSION_DOC)
        if not fields:
            return None
        raw = fields.get("cookies", {}).get("stringValue", "")
        return json.loads(raw) if raw else None
    except Exception as e:
        print(f"  ⚠ Không đọc được lophoc_session: {e}")
        return None


def save_lophoc_session(data: dict):
    """Lưu lophoc session cookies vào Firestore."""
    try:
        write_fs(LOPHOC_SESSION_DOC, {
            "cookies":   {"stringValue": json.dumps(data.get("cookies", {}), ensure_ascii=False)},
            "updatedAt": {"stringValue": data.get("updatedAt", datetime.now(timezone.utc).isoformat())}
        })
    except Exception as e:
        print(f"  ⚠ Không lưu được lophoc_session: {e}")


def load_existing_schedule() -> dict:
    """Đọc schedule cũ từ Firestore để merge (giữ m3u8 đã có)."""
    try:
        fields = read_fs(SCHEDULE_DOC)
        if not fields:
            return {"events": []}
        raw = fields.get("json", {}).get("stringValue", "")
        return json.loads(raw) if raw else {"events": []}
    except Exception as e:
        print(f"  ⚠ Không đọc được schedule cũ: {e}")
        return {"events": []}


def push_schedule(data: dict):
    write_fs(SCHEDULE_DOC, {
        "json":      {"stringValue": json.dumps(data, ensure_ascii=False)},
        "updatedAt": {"stringValue": data.get("lastUpdated", datetime.now(timezone.utc).isoformat())}
    })
    print("✓ Đã push schedule lên Firestore")


# ── TIME HELPERS ─────────────────────────────────────────────────────────────
def normalize_time(raw: str) -> str:
    """
    Chuẩn hóa chuỗi giờ về HH:MM (24h).
    "21 giờ" → "21:00", "21:30" → "21:30", "9h tối" → "21:00", "8h55" → "08:55"
    """
    if not raw:
        return "00:00"
    nums = re.findall(r'\d+', raw)
    if not nums:
        return "00:00"
    h = int(nums[0])
    m = int(nums[1]) if len(nums) > 1 else 0
    # "tối" = buổi tối, nếu giờ < 12 thì cộng 12
    if ("tối" in raw or "pm" in raw.lower()) and h < 12:
        h += 12
    h = min(h, 23)
    m = min(m, 59)
    return f"{h:02d}:{m:02d}"


# ── PLAYWRIGHT HELPERS ───────────────────────────────────────────────────────
def check_logged_in(page) -> bool:
    """
    Kiểm tra đã đăng nhập chưa bằng cách xem có MoodleSession không
    và kiểm tra xem có lấy được calendar-wrapper không.
    """
    try:
        # Check cookie first
        cookies = page.context.cookies()
        if not any(c.get("name") == "MoodleSession" for c in cookies):
            return False

        page.wait_for_load_state("domcontentloaded", timeout=15000)
        current = page.url.lower()
        if "loginv2" in current or "/login" in current:
            return False
            
        # Kiểm tra có phần tử đặc trưng của trang lịch không
        return page.query_selector(".calendar-wrapper") is not None
    except Exception:
        return False


def _first_visible_input(page, *selectors: str):
    """
    Đăng nhập kiểu đơn giản (giống video.py): trả về input ĐẦU TIÊN đang
    HIỂN THỊ khớp 1 trong các selector truyền vào.

    Bản cũ (_resolve_real_input) đoán field thật luôn là field CUỐI cùng
    trong DOM khi có honeypot trùng name — giả định này sai khi trang đổi
    cấu trúc (honeypot lại nằm sau), dẫn tới fill() nhầm field bị ẩn rồi
    timeout. Hàm này không đoán vị trí nữa — chỉ quét tất cả field khớp
    từng selector và lấy field đầu tiên có is_visible() == True, vì honeypot
    luôn bị ẩn bằng CSS (display:none/visibility:hidden) bất kể nó nằm ở
    đâu trong DOM.
    """
    for sel in selectors:
        loc = page.locator(sel)
        for i in range(loc.count()):
            el = loc.nth(i)
            try:
                if el.is_visible():
                    return el
            except Exception:
                continue
    return None


def save_debug_artifacts(page, prefix: str = "login_failure"):
    """
    Lưu screenshot + HTML hiện tại của `page` khi có lỗi, để biết chính xác
    CI thấy gì lúc fail — không phải đoán mù qua traceback nữa.

    QUAN TRỌNG: trước đây workflow (.yml) đã có bước upload-artifact tìm
    `login_failure.png`/`login_failure.html`, nhưng KHÔNG có hàm nào trong
    crawl_calendar.py thực sự tạo ra 2 file này → artifact luôn rỗng
    ("No files were found..."). Hàm này lấp đúng lỗ hổng đó.
    """
    try:
        page.screenshot(path=f"{prefix}.png", full_page=True)
        with open(f"{prefix}.html", "w", encoding="utf-8") as f:
            f.write(page.content())
        print(f"  📸 Đã lưu {prefix}.png + .html — URL lúc lỗi: {page.url}")
    except Exception as e:
        print(f"  ⚠ Không lưu được debug artifact ({prefix}): {e}")


def _wait_for_visible_input(page, *selectors: str, timeout_ms: int = 12000, poll_ms: int = 500):
    """
    Giống _first_visible_input() nhưng CHỜ tối đa timeout_ms, poll lại mỗi
    poll_ms — để chịu được trang có refresh/redirect trung gian.

    Lý do cần hàm này: ảnh/html debug thật chụp được từ GitHub Actions cho
    thấy khi context đang mang cookie MoodleSession CŨ (hết hạn) rồi mở
    thẳng trang login, hocmai/Moodle KHÔNG trả form login ngay — mà trả 1
    trang gần như rỗng (chỉ có <head>, <body></body> trống) kèm
    `<meta http-equiv="refresh" content="5; url=.../loginv2/index.php">`,
    tự nạp lại CHÍNH trang đó sau 5 giây mới ra form thật (cách Moodle xử
    lý khi phát hiện session cũ không hợp lệ). Check 1 lần ngay sau
    networkidle + sleep(1) như cũ là quá sớm — chưa tới giây thứ 5 nên
    luôn thấy "không có field nào hiển thị", dù form thật vẫn sẽ xuất
    hiện nếu chờ thêm vài giây.
    """
    deadline = time.time() + timeout_ms / 1000
    while True:
        el = _first_visible_input(page, *selectors)
        if el:
            return el
        if time.time() >= deadline:
            return None
        page.wait_for_timeout(poll_ms)


def do_login(page):
    """
    Đăng nhập bằng tài khoản/mật khẩu — phiên bản đơn giản hoá theo video.py.

    Flow login (login.har):
    - URL: POST /loginv2/index.php
    - Fields: a (rỗng), username, password
    - Content-Type: multipart/form-data
    - Success: redirect 302 → /study

    Trang login có thể có field honeypot trùng name="username"/"password"
    để bẫy bot — xem _first_visible_input() (chọn theo trạng thái hiển thị,
    không đoán vị trí DOM).
    """
    if not HM_USERNAME or not HM_PASSWORD:
        raise RuntimeError("❌ Thiếu HM_USERNAME hoặc HM_PASSWORD.")
    print("  → Đăng nhập bằng tài khoản/mật khẩu...")
    login_url = url(HM_LOGIN_PATH)  # /loginv2/index.php

    # Xoá cookie cũ (MoodleSession hết hạn từ Firestore) TRƯỚC khi mở trang
    # login. Nếu giữ cookie cũ, Moodle có thể trả về trang trung gian rỗng
    # + meta-refresh 5s (xem _wait_for_visible_input) thay vì form login
    # ngay — xoá cookie để đảm bảo đây luôn là 1 lượt ghé trang "sạch".
    page.context.clear_cookies()

    # Mở trang login trước để lấy cookie phiên
    page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_load_state("networkidle", timeout=20000)
    time.sleep(1)
    print(f"  ℹ URL sau khi mở trang login: {page.url}")

    username_field = _wait_for_visible_input(page, 'input[name="username"]', 'input[type="text"]')
    password_field = _wait_for_visible_input(page, 'input[name="password"]', 'input[type="password"]')

    if not username_field:
        save_debug_artifacts(page)
        raise RuntimeError("❌ Không tìm thấy ô tài khoản (username) đang hiển thị trên trang login.")
    if not password_field:
        save_debug_artifacts(page)
        raise RuntimeError("❌ Không tìm thấy ô mật khẩu (password) đang hiển thị trên trang login.")

    username_field.click()
    username_field.fill(HM_USERNAME)
    time.sleep(0.3)

    password_field.click()
    password_field.fill(HM_PASSWORD)
    time.sleep(0.3)

    # Dùng press("Enter") trên password thay vì click để tránh nhầm form tìm kiếm
    password_field.press("Enter")

    # Chờ redirect hoàn tất
    page.wait_for_load_state("networkidle", timeout=20000)
    time.sleep(2)

    # Xác nhận qua cookie thay vì URL (vì có thể bị redirect linh tinh)
    cookies = page.context.cookies()
    if not any(c.get("name") == "MoodleSession" for c in cookies):
        save_debug_artifacts(page)
        raise RuntimeError("❌ Đăng nhập thất bại — Không tìm thấy MoodleSession cookie.")
    print("  ✓ Đăng nhập thành công (đã lấy được session cookie)!")


def do_logout(page):
    """
    Logout đúng flow theo LOGOUT.HAR:
    Bước 1: GET /loginv2/logout.php → trang hỏi 'Bạn có thực sự muốn đăng xuất?'
    Bước 2: Click nút 'Có' (submit form với sesskey)
            hoặc lấy sesskey rồi GET /login/logout.php?sesskey=XXX
    """
    if not HM_LOGOUT_V2_PATH:
        print("  ⚠ Thiếu HM_LOGOUT_V2_PATH — bỏ qua đăng xuất.")
        return
    try:
        logout_v2 = url(HM_LOGOUT_V2_PATH)  # /loginv2/logout.php

        page.goto(logout_v2, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_load_state("networkidle", timeout=10000)

        # Cách 1: Click nút 'Có' trong trang confirmation
        yes_btn = page.query_selector('input[type="submit"][value="Có"]')
        if yes_btn:
            yes_btn.click()
            page.wait_for_load_state("networkidle", timeout=10000)
            print("  ✓ Đã đăng xuất thành công (click Có).")
            return

        # Cách 2: Lấy sesskey và GET /login/logout.php?sesskey=XXX
        if not HM_LOGOUT_FINAL:
            print("  ⚠ Không tìm thấy nút Có và thiếu HM_LOGOUT_FINAL_PATH.")
            return

        sesskey = None
        el = page.query_selector('input[name="sesskey"]')
        if el:
            sesskey = el.get_attribute("value")
        else:
            content = page.content()
            m_key = re.search(r'sesskey[=:]\s*["\']?([A-Za-z0-9]+)', content)
            if m_key:
                sesskey = m_key.group(1)

        if not sesskey:
            print("  ⚠ Không tìm được sesskey — bỏ qua đăng xuất.")
            return

        logout_final = url(HM_LOGOUT_FINAL)  # /login/logout.php
        page.goto(f"{logout_final}?sesskey={sesskey}",
                  wait_until="domcontentloaded", timeout=15000)
        page.wait_for_load_state("networkidle", timeout=10000)
        print("  ✓ Đã đăng xuất thành công (sesskey GET).")
    except Exception as e:
        print(f"  ⚠ Đăng xuất lỗi (bỏ qua): {e}")


def click_month_view(page):
    try:
        btn = page.query_selector('button[data-view="dayGridMonth"]')
        if btn:
            btn.click()
            time.sleep(1.5)
            print("  ✓ Chuyển sang chế độ xem Tháng")
    except Exception as e:
        print(f"  ⚠ Không click được nút 'Tháng': {e}")


def navigate_to_next_month(page):
    try:
        btn = page.query_selector('#nextBtn, button#nextBtn')
        if btn:
            btn.click()
            page.wait_for_load_state("networkidle", timeout=10000)
            time.sleep(1.5)
    except Exception as e:
        print(f"  ⚠ Không chuyển tháng được: {e}")


# ── PARSE CALENDAR DOM ───────────────────────────────────────────────────────
def parse_events_from_page(page) -> list[dict]:
    """
    Trích xuất danh sách buổi học từ DOM.
    Trả về list[dict] với: date, time, subject, title, color, status, m3u8, liveStartEpoch
    """
    raw_events = page.evaluate("""
    () => {
        const results = [];
        const dayCells = document.querySelectorAll('td.fc-daygrid-day[data-date]');
        dayCells.forEach(cell => {
            const date = cell.getAttribute('data-date');
            const eventEls = cell.querySelectorAll('.fc-event');
            eventEls.forEach(evEl => {
                const timeEl    = evEl.querySelector('.time');
                const subjectEl = evEl.querySelector('.subject');
                const titleEl   = evEl.querySelector('.title');
                const dotEl     = evEl.querySelector('.dot');

                const time    = timeEl    ? timeEl.textContent.trim()    : '';
                const subject = subjectEl ? subjectEl.textContent.trim() : '';
                const title   = titleEl   ? titleEl.textContent.trim()   : '';
                const color   = dotEl     ? (dotEl.style.background || '') : '';

                const cls = Array.from(evEl.classList);
                let status = 'unknown';
                if (cls.some(c => c === 'event-past'))     status = 'past';
                else if (cls.some(c => c === 'event-too_early')) status = 'upcoming';
                else if (cls.some(c => c === 'event-open')) status = 'open';

                if (date && (subject || title)) {
                    results.push({ date, time, subject, title, color, status });
                }
            });
        });
        return results;
    }
    """)
    events = []
    for ev in (raw_events or []):
        ev["time"] = normalize_time(ev.get("time", ""))
        ev["m3u8"] = None
        ev["liveStartEpoch"] = None
        ev["sessionId"] = session_id(ev["date"], ev["time"], ev.get("title", ""))  # MỚI
        ev["startAt"] = compute_start_at(ev["date"], ev["time"])                   # MỚI
        events.append(ev)
    return events


def get_month_label(page) -> str:
    try:
        el = page.query_selector('.calendar-title .title, #calendarTitle .title')
        return el.inner_text().strip() if el else ""
    except Exception:
        return ""


# ── MERGE LOGIC ──────────────────────────────────────────────────────────────
def merge_events(new_events: list[dict], old_data: dict) -> list[dict]:
    """
    Kết hợp events mới với data cũ:
    - Nếu event cũ đã có m3u8 (do admin set hoặc crawl trước) → giữ nguyên.
    - Cập nhật status và time nếu HocMai đã thay đổi (phát hiện lùi lịch).
    """
    old_events = {
        f"{e['date']}_{e['time']}_{e['subject']}_{e['title']}": e
        for e in old_data.get("events", [])
    }
    # Thử match bằng date + subject (cho trường hợp giờ thay đổi = lùi lịch)
    old_by_date_subject = {}
    for e in old_data.get("events", []):
        key = f"{e['date']}_{e['subject']}"
        old_by_date_subject.setdefault(key, []).append(e)

    merged = []
    for ev in new_events:
        exact_key = f"{ev['date']}_{ev['time']}_{ev['subject']}_{ev['title']}"
        if exact_key in old_events and old_events[exact_key].get("m3u8"):
            # Giữ m3u8 và liveStartEpoch cũ
            ev["m3u8"] = old_events[exact_key]["m3u8"]
            ev["liveStartEpoch"] = old_events[exact_key].get("liveStartEpoch")

        # Nếu không match exact nhưng cùng ngày + môn → có thể là lùi lịch
        elif not ev.get("m3u8"):
            partial_key = f"{ev['date']}_{ev['subject']}"
            old_candidates = old_by_date_subject.get(partial_key, [])
            for old_ev in old_candidates:
                if old_ev.get("m3u8"):
                    # Lùi lịch: giữ m3u8 nhưng dùng giờ mới
                    ev["m3u8"] = old_ev["m3u8"]
                    ev["liveStartEpoch"] = old_ev.get("liveStartEpoch")
                    print(f"  ⚠ Phát hiện lùi lịch: {ev['subject']} ngày {ev['date']} từ {old_ev['time']} → {ev['time']}")
                    break

        merged.append(ev)
    return merged


# ── WATCH MODE ────────────────────────────────────────────────────────────────
def _run_watch_mode():
    """
    Watch mode: Không cần Playwright. Dùng lophoc_api.py (HTTP thuần) để:
    1. Load schedule hiện tại từ Firestore
    2. Tìm các buổi học sắp diễn ra (status='open' hoặc trong 30ph tới)
    3. Dùng LophocClient kiểm tra stream nào đang live
    4. Với stream đang live → lấy m3u8, update vào schedule + push lên Firestore
    """
    from datetime import datetime, timezone, timedelta
    from lophoc_api import LophocClient

    if not HM_USERNAME or not HM_PASSWORD:
        print("❌ WATCH mode cần HM_USERNAME và HM_PASSWORD")
        return

    print("▶ WATCH mode: kiểm tra buổi học đang live...")

    # ── 1. Load schedule từ Firestore hoặc local file ──
    if GOOGLE_CREDENTIALS_JSON:
        old_data = load_existing_schedule()
    else:
        try:
            import json as _json
            with open("schedule.json", "r", encoding="utf-8-sig") as f:
                old_data = _json.load(f)
        except Exception as e:
            print(f"  ⚠ Không đọc được schedule.json local: {e}")
            old_data = {"events": []}
    events = old_data.get("events", [])
    if not events:
        print("  ⚠ Không có dữ liệu schedule trong Firestore.")
        return

    # ── 2. Lọc các buổi học chưa có m3u8 và sắp diễn ra (trước 30 phút) ──
    now_vn = datetime.now(timezone(timedelta(hours=7)))
    today_str = now_vn.strftime("%Y-%m-%d")
    now_minutes = now_vn.hour * 60 + now_vn.minute

    def _is_soon(ev: dict) -> bool:
        if ev.get("date") != today_str:
            return False
        t = ev.get("time", "00:00")
        try:
            h, m = int(t[:2]), int(t[3:5])
            ev_min = h * 60 + m
            # Chỉ check nếu giờ hiện tại nằm trong khoảng [trước 30p, sau 60p] so với giờ học
            return -30 <= (now_minutes - ev_min) <= 60
        except Exception:
            return False

    target_events = [ev for ev in events if not ev.get("m3u8") and _is_soon(ev)]

    if not target_events:
        print(f"  ℹ Tất cả buổi học hôm nay ({today_str}) đều đã có m3u8 hoặc không có lịch.")
        return

    print(f"  Có {len(target_events)} buổi trong cửa sổ kiểm tra:")
    for ev in target_events:
        m3u8_tag = "✓ đã có m3u8" if ev.get("m3u8") else "chưa có m3u8"
        print(f"    [{ev['time']}] {ev['subject']} — {ev['title']} ({m3u8_tag})")

    # ── 3. Khởi tạo LophocClient với Firestore cache ──
    if GOOGLE_CREDENTIALS_JSON:
        cache_loader = load_lophoc_session
        cache_saver  = save_lophoc_session
    else:
        cache_loader = None
        cache_saver  = None

    client = LophocClient(HM_USERNAME, HM_PASSWORD, cache_loader, cache_saver)

    # ── 4. Lấy calendar từ lophoc API để map code + learn_number ──
    print("  → Lấy lịch từ lophoc API...")
    try:
        lophoc_lessons = client.get_calendar()
    except Exception as e:
        print(f"  ❌ Lấy lophoc calendar thất bại: {e}")
        return

    # Build index (subject, lesson_name) → lesson
    lophoc_idx: dict = {}
    for lesson in lophoc_lessons:
        key = (lesson.get("subject", ""), lesson.get("lesson_name", ""))
        lophoc_idx[key] = lesson

    print(f"  ✓ Lophoc calendar: {len(lophoc_lessons)} buổi. Index: {len(lophoc_idx)} môn.")

    # ── 5. Với từng buổi target, thử lấy m3u8 và check trực tiếp CDN ──
    changed = False
    for ev in target_events:
        if ev.get("m3u8"):
            continue  # đã có rồi → skip

        match_key = (ev.get("subject", ""), ev.get("title", ""))
        lesson = lophoc_idx.get(match_key)

        if not lesson:
            print(f"  ⚠ [{ev['time']}] {ev['subject']} — Không tìm thấy trong lophoc calendar (chưa enroll?)")
            continue

        code         = lesson.get("code", "")
        learn_number = lesson.get("learn_number", 0)

        # Bỏ qua bước kiểm tra live-status vì API hocmai thường trả False dù đã live
        print(f"  ⏳ [{ev['time']}] {ev['subject']} — Thử lấy m3u8 và check CDN...")
        try:
            m3u8_url = client.get_m3u8(code, learn_number)
        except Exception as e:
            print(f"    ❌ Lấy m3u8 thất bại: {e}")
            continue

        if not m3u8_url:
            print(f"    ⚠ API trả về m3u8 URL trống")
            continue

        # Check trực tiếp CDN xem có trả 200 không (m3u8 cần Referer/Origin)
        cdn_ok = False
        try:
            import requests
            r_cdn = requests.head(
                m3u8_url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
                    "Referer": "https://lophoc.hocmai.vn/",
                    "Origin": "https://lophoc.hocmai.vn"
                },
                timeout=5
            )
            # Dùng GET nếu HEAD bị cấm
            if r_cdn.status_code == 405:
                r_cdn = requests.get(m3u8_url, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
                    "Referer": "https://lophoc.hocmai.vn/",
                    "Origin": "https://lophoc.hocmai.vn"
                }, stream=True, timeout=5)
                r_cdn.close()
                
            if r_cdn.status_code == 200:
                cdn_ok = True
            else:
                print(f"    ⏳ Stream chưa live trên CDN (HTTP {r_cdn.status_code})")
        except Exception as e:
            print(f"    ⚠ Lỗi check CDN: {e}")

        if not cdn_ok:
            continue

        # Stream đang live → cập nhật vào event
        for main_ev in events:
            if (main_ev.get("date") == ev["date"] and
                    main_ev.get("subject") == ev["subject"] and
                    main_ev.get("title") == ev["title"]):
                main_ev["m3u8"] = m3u8_url
                main_ev["status"] = "live"
                main_ev["code"] = code
                main_ev["learn_number"] = learn_number
                if not main_ev.get("liveStartEpoch"):
                    main_ev["liveStartEpoch"] = int(datetime.now(timezone.utc).timestamp() * 1000)
                changed = True
                print(f"    🔴 ĐÃ LIVE! Ghi m3u8: {m3u8_url[:60]}...")
                break

    # ── 7. Push lên Firestore nếu có thay đổi ──
    if changed:
        old_data["events"] = events
        old_data["lastUpdated"] = datetime.now(timezone.utc).isoformat()
        if GOOGLE_CREDENTIALS_JSON:
            push_schedule(old_data)
        else:
            import json as _json
            with open("schedule_watch.json", "w", encoding="utf-8") as f:
                _json.dump(old_data, f, ensure_ascii=False, indent=2)
            print("→ Đã lưu schedule_watch.json (local mode)")
        print("✅ Watch mode: Đã cập nhật m3u8!")
    else:
        print("✅ Watch mode: Không có thay đổi.")


# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    check_config()

    if CRAWL_MODE == "watch":
        _run_watch_mode()
        return

    from playwright.sync_api import sync_playwright

    print(f"▶ Bắt đầu crawl lịch (mode={CRAWL_MODE}, months={MONTHS_TO_CRAWL})...")
    all_events: list[dict] = []
    did_login = False

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/149.0.0.0 Safari/537.36"
            ),
            locale="vi-VN",
            timezone_id="Asia/Ho_Chi_Minh"
        )

        # Bước 1: Load cookie từ Firestore
        if GOOGLE_CREDENTIALS_JSON:
            print("▶ Đọc cookie từ Firestore...")
            saved = load_cookies_from_firestore()
            if saved:
                context.add_cookies(saved)
                print(f"  ✓ Loaded {len(saved)} cookies")

        page = context.new_page()

        # Bước 2: Mở trang calendar, kiểm tra login
        cal_url = url(HM_CAL_PATH)
        print(f"▶ Mở trang calendar...")
        page.goto(cal_url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)

        if not check_logged_in(page):
            print("  Cookie không hợp lệ → đăng nhập bằng tài khoản...")
            do_login(page)
            did_login = True

            page.goto(cal_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=20000)
            time.sleep(2)

            if not check_logged_in(page):
                save_debug_artifacts(page, prefix="login_failure")
                raise RuntimeError("❌ Không vào được trang calendar sau khi đăng nhập.")

            if GOOGLE_CREDENTIALS_JSON:
                save_cookies(context.cookies())
        else:
            print("  ✓ Cookie hợp lệ.")

        # Bước 3: Chuyển sang chế độ xem Tháng
        click_month_view(page)
        page.wait_for_load_state("networkidle", timeout=10000)
        time.sleep(1)

        # Bước 4: Crawl từng tháng
        for i in range(MONTHS_TO_CRAWL):
            label = get_month_label(page)
            print(f"  → Crawling: {label or f'tháng {i+1}'}...")
            events = parse_events_from_page(page)
            print(f"     Tìm thấy {len(events)} sự kiện")
            all_events.extend(events)

            if i < MONTHS_TO_CRAWL - 1:
                navigate_to_next_month(page)

        # Bước 5: Đăng xuất
        if did_login:
            print("▶ Đăng xuất...")
            do_logout(page)

        browser.close()

    # Bước 6: Dedup + sort
    seen = set()
    unique: list[dict] = []
    for ev in all_events:
        key = (ev["date"], ev["time"], ev["subject"], ev["title"])
        if key not in seen:
            seen.add(key)
            unique.append(ev)
    unique.sort(key=lambda e: (e["date"], e["time"]))

    # Bước 7: Merge với data cũ (giữ m3u8 đã có)
    if GOOGLE_CREDENTIALS_JSON:
        print("▶ Đọc schedule cũ để merge...")
        old_data = load_existing_schedule()
        unique = merge_events(unique, old_data)

    output = {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "events": unique
    }

    print(f"✓ Tổng số buổi học: {len(unique)}")

    # Bước 8: Push lên Firestore
    if GOOGLE_CREDENTIALS_JSON:
        push_schedule(output)
    else:
        with open("schedule.json", "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print("→ Đã lưu schedule.json (local mode)")

    print("✅ Hoàn thành!")


if __name__ == "__main__":
    main()