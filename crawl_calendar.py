"""
crawl_calendar.py — HM-LEAKBASE
Crawl lịch học, lưu cookie vào Firestore.
- Nếu cookie còn dùng được → dùng luôn, không cần đăng nhập.
- Nếu cookie hết hạn → đăng nhập bằng HM_USERNAME/HM_PASSWORD,
  lấy cookie mới, lưu lên Firestore, crawl xong đăng xuất đúng flow.
- Dữ liệu lịch push lên Firestore app_data/schedule.
- Không có hardcode URL nào — toàn bộ lấy từ GitHub Secrets.
"""

import os, re, json, time
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


def _save_login_debug(page, tag: str):
    """Lưu screenshot + HTML khi do_login thất bại — xem artifact 'login-debug'
    trên GitHub Actions để biết chính xác trang login hiện trông thế nào,
    thay vì phải đoán mù lần 2."""
    try:
        page.screenshot(path="login_failure.png", full_page=True)
        with open("login_failure.html", "w", encoding="utf-8") as f:
            f.write(page.content())
        print(f"  📸 [{tag}] Đã lưu login_failure.png + login_failure.html để debug")
    except Exception as e:
        print(f"  ⚠ Không lưu được debug artifact: {e}")


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

    Robust hơn bản cũ ở 2 điểm (sau khi gặp lỗi thật trên CI — trang load
    chậm hơn dự kiến khiến field chưa kịp hiện khi check is_visible()):
    - Chủ động wait_for_selector() thay vì chỉ networkidle + sleep cố định.
    - Thử lại 1 lần (reload) nếu lần đầu chưa thấy field, trước khi raise.
    - Tự lưu screenshot/HTML khi raise — xem _save_login_debug().
    """
    if not HM_USERNAME or not HM_PASSWORD:
        raise RuntimeError("❌ Thiếu HM_USERNAME hoặc HM_PASSWORD.")
    print("  → Đăng nhập bằng tài khoản/mật khẩu...")
    login_url = url(HM_LOGIN_PATH)  # /loginv2/index.php

    USERNAME_SELECTORS = [
        'input[name="username"]', 'input[type="text"]', 'input[type="tel"]',
        'input[autocomplete="username"]', 'input[id*="username" i]',
        'input[placeholder*="email" i]', 'input[placeholder*="điện thoại" i]',
    ]
    PASSWORD_SELECTORS = [
        'input[name="password"]', 'input[type="password"]',
        'input[autocomplete="current-password"]',
    ]
    combined_username_sel = ", ".join(USERNAME_SELECTORS)

    username_field = password_field = None
    for attempt in range(2):
        page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        # Chờ chủ động field xuất hiện (poll tới 15s) — robust hơn sleep cố định
        # cho trang render bằng JS/SPA chậm hơn dự kiến trên runner CI.
        try:
            page.wait_for_selector(combined_username_sel, timeout=15000, state="visible")
        except Exception:
            pass  # vẫn thử is_visible() bên dưới — có thể đã đủ điều kiện

        username_field = _first_visible_input(page, *USERNAME_SELECTORS)
        password_field = _first_visible_input(page, *PASSWORD_SELECTORS)
        if username_field and password_field:
            break
        print(f"  ⚠ Lần {attempt + 1}/2: chưa thấy field login đang hiển thị, thử reload...")
        time.sleep(2)

    if not username_field or not password_field:
        _save_login_debug(page, "khong-thay-field")
        missing = "username" if not username_field else "password"
        raise RuntimeError(
            f"❌ Không tìm thấy ô {missing} đang hiển thị trên trang login sau 2 lần thử. "
            f"Xem artifact 'login-debug' trên GitHub Actions để biết trang login hiện trông thế nào."
        )

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
        _save_login_debug(page, "khong-co-moodlesession")
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


def merge_partial_month(new_events: list[dict], old_data: dict) -> list[dict]:
    """
    Dùng cho watch mode (chỉ crawl THÁNG HIỆN TẠI, nhanh).
    Khác merge_events(): merge_events() chỉ trả về đúng những event có trong
    new_events — nếu dùng trực tiếp cho watch mode sẽ XÓA MẤT toàn bộ event
    của các tháng khác đã crawl trước đó (vì chúng không nằm trong new_events).
    Hàm này giữ nguyên các event ở ngày KHÁC, chỉ thay thế/merge đúng những
    ngày vừa crawl lại.
    """
    new_dates = {e["date"] for e in new_events}
    kept = [e for e in old_data.get("events", []) if e["date"] not in new_dates]
    merged_month = merge_events(new_events, old_data)
    return kept + merged_month


# ── LOPHOC API — TỰ ĐỘNG LẤY M3U8 (xem phan_tich.md cùng repo) ────────────────
LOPHOC_COOKIE_DOC = "app_data/lophoc_session"  # cache riêng, không đụng hm_cookies


def load_lophoc_cache() -> dict | None:
    try:
        fields = read_fs(LOPHOC_COOKIE_DOC)
        if not fields:
            return None
        raw = fields.get("session", {}).get("stringValue", "")
        return json.loads(raw) if raw else None
    except Exception as e:
        print(f"  ⚠ Không đọc được lophoc cache: {e}")
        return None


def save_lophoc_cache(data: dict):
    write_fs(LOPHOC_COOKIE_DOC, {
        "session":   {"stringValue": json.dumps(data, ensure_ascii=False)},
        "updatedAt": {"stringValue": datetime.now(timezone.utc).isoformat()}
    })
    print("  ✓ Đã lưu lophoc session cache lên Firestore")


def get_lophoc_client():
    """Factory tạo LophocClient với Firestore cache. Import trễ để main mode
    (không cần lophoc) không bắt buộc phải có file lophoc_api.py hợp lệ."""
    from lophoc_api import LophocClient
    return LophocClient(
        username=HM_USERNAME,
        password=HM_PASSWORD,
        cache_loader=load_lophoc_cache,
        cache_saver=save_lophoc_cache,
    )


def _is_upcoming_or_open(start_iso: str, end_iso: str, now_vn) -> bool:
    """now_vn PHẢI là datetime đã gắn tzinfo +07:00 (xem parse_lophoc_time)."""
    from lophoc_api import parse_lophoc_time
    if not start_iso or not end_iso:
        return False
    start = parse_lophoc_time(start_iso)
    end = parse_lophoc_time(end_iso)
    return start - timedelta(minutes=30) <= now_vn <= end + timedelta(minutes=30)


def enrich_with_m3u8(events: list[dict]) -> list[dict]:
    """
    Gọi sau khi merge_events()/merge_partial_month() xong (browser Playwright
    đã đóng — hàm này chỉ dùng requests qua lophoc_api, không cần Chromium).
    Với mỗi event chưa có m3u8, thử khớp với lịch lophoc + check live-status,
    nếu đang live thật thì gọi /api/livestreamlink lấy URL.

    Quy tắc vàng: m3u8 đã có trong Firestore KHÔNG BAO GIỜ bị ghi đè bởi None —
    chỉ set khi lấy được URL mới hợp lệ (xem điều kiện `if ev.get("m3u8"): continue`).
    """
    from lophoc_api import parse_lophoc_time, VN_TZ

    if not HM_USERNAME or not HM_PASSWORD:
        print("⚠ Thiếu HM_USERNAME/HM_PASSWORD — skip enrich m3u8")
        return events

    print("▶ Bắt đầu enrich m3u8 từ lophoc API...")
    try:
        client = get_lophoc_client()
        client.ensure_logged_in()
        lophoc_lessons = client.get_calendar()
    except Exception as e:
        print(f"  ⚠ Lophoc API lỗi, bỏ qua enrich lần này: {e}")
        return events

    # Match theo (subject, lesson_name) — xem phan_tich.md §4.2 về asymmetry
    # match-key giữa Python (4 field) và JS (3 field, thiếu subject)
    lophoc_idx = {}
    for l in lophoc_lessons:
        key = (l.get("subject", ""), l.get("lesson_name", ""))
        lophoc_idx[key] = l

    now_vn = datetime.now(VN_TZ)
    upcoming = [l for l in lophoc_lessons
                if _is_upcoming_or_open(l.get("start_time"), l.get("end_time"), now_vn)]
    codes_to_check = list({l["code"] for l in upcoming if l.get("code")})

    if not codes_to_check:
        print("  Không có buổi nào sắp/đang live theo lịch lophoc — skip.")
        return events

    try:
        from lophoc_api import get_live_status
        live_status = get_live_status(client.session, codes_to_check)
    except Exception as e:
        print(f"  ⚠ live-status error: {e}")
        live_status = {}

    enriched_count = 0
    for ev in events:
        if ev.get("m3u8"):
            continue  # đã có m3u8 (do anh dán tay hoặc lần crawl trước) → KHÔNG đè
        match_key = (ev.get("subject", ""), ev.get("title", ""))
        lesson = lophoc_idx.get(match_key)
        if not lesson:
            continue  # không enrolled môn này, hoặc title không khớp 100%
        code = lesson.get("code")
        learn_number = lesson.get("learn_number")
        if not code or learn_number is None:
            continue
        if not live_status.get(code, False):
            continue  # stream chưa live thật → đợi lần cron sau (5p), không spam
        try:
            m3u8 = client.get_m3u8(code, int(learn_number))
            if m3u8:
                ev["m3u8"] = m3u8
                if not ev.get("liveStartEpoch"):
                    start_dt = parse_lophoc_time(lesson["start_time"])
                    ev["liveStartEpoch"] = int(start_dt.timestamp() * 1000)
                ev["code"] = code
                ev["learn_number"] = int(learn_number)
                enriched_count += 1
                print(f"  ✓ m3u8 cho {ev['subject']} - {ev['title'][:40]}...")
                time.sleep(0.5)  # rate limit nhẹ giữa các buổi nếu có nhiều buổi live cùng lúc
        except Exception as e:
            print(f"  ⚠ Lấy m3u8 fail cho {code}-{learn_number}: {e}")

    print(f"✓ Enriched {enriched_count}/{len(events)} events với m3u8")
    return events


def run_watch_mode():
    """
    Watch mode — crawl NHANH chỉ tháng đang hiển thị (mặc định = tháng hiện tại,
    không cần lặp qua nhiều tháng), dùng để chạy lặp lại nhiều lần gần giờ học
    nhằm phát hiện LÙI LỊCH (đổi giờ) kịp thời trước khi vào học, VÀ tự động
    lấy m3u8 qua lophoc API (enrich_with_m3u8) khi buổi học thực sự đang live —
    không cần dán tay qua admin panel "Go Live" nữa.

    Không logout sau khi xong (khác full mode) — vì hàm này chạy lặp lại liên
    tục trong nhiều giờ, login/logout mỗi lần rất tốn thời gian và có thể bị
    hocmai coi là hành vi bất thường nếu lặp lại quá nhiều lần/giờ.
    """
    from playwright.sync_api import sync_playwright

    print("▶ Watch mode — crawl nhanh tháng hiện tại (phát hiện lùi lịch)...")

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

        if GOOGLE_CREDENTIALS_JSON:
            saved = load_cookies_from_firestore()
            if saved:
                context.add_cookies(saved)
                print(f"  ✓ Loaded {len(saved)} cookies")

        page = context.new_page()
        cal_url = url(HM_CAL_PATH)
        page.goto(cal_url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(1.5)

        if not check_logged_in(page):
            print("  Cookie không hợp lệ → đăng nhập bằng tài khoản...")
            do_login(page)
            page.goto(cal_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=20000)
            time.sleep(1.5)
            if not check_logged_in(page):
                raise RuntimeError("❌ Watch mode: không vào được calendar sau khi đăng nhập.")
            if GOOGLE_CREDENTIALS_JSON:
                save_cookies(context.cookies())
        else:
            print("  ✓ Cookie hợp lệ.")

        click_month_view(page)
        page.wait_for_load_state("networkidle", timeout=10000)
        time.sleep(1)

        new_events = parse_events_from_page(page)
        print(f"  Tìm thấy {len(new_events)} sự kiện trong tháng hiện tại")
        browser.close()

    if not GOOGLE_CREDENTIALS_JSON:
        print("⚠ Thiếu GOOGLE_CREDENTIALS_JSON — watch mode cần Firestore để hoạt động, bỏ qua push.")
        return

    old_data = load_existing_schedule()
    merged = merge_partial_month(new_events, old_data)
    merged = enrich_with_m3u8(merged)
    merged.sort(key=lambda e: (e["date"], e["time"]))
    output = {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "events": merged
    }
    push_schedule(output)
    print(f"✓ Watch mode xong — tổng {len(merged)} buổi học (toàn bộ các tháng).")


# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    check_config()

    if CRAWL_MODE == "watch":
        run_watch_mode()
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
        unique = enrich_with_m3u8(unique)

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