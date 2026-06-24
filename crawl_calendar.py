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
from datetime import datetime, timezone

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


def _resolve_real_input(page, name_attr: str, real_id: str | None = None):
    """
    Trang login có field 'bẫy' (honeypot) trùng name với field thật, ví dụ:
      - input#password   (bẫy — class "input-icon icon-shield")
      - input#realpass   (field thật — class "edit-login")
    Cả 2 đều khớp input[name="password"] nên locator bị strict-mode violation.
    Hàm này luôn trả về field THẬT:
      1. Nếu biết sẵn id thật (real_id) và nó tồn tại trên trang → dùng luôn.
      2. Nếu không, lấy tất cả input[name=...]; nếu có nhiều hơn 1 (có bẫy),
         field thật luôn là field cuối cùng trong DOM (bẫy được chèn trước) →
         dùng .last. Nếu chỉ có 1 → dùng luôn field đó.
    """
    if real_id:
        cand = page.locator(f"#{real_id}")
        if cand.count() > 0:
            return cand.first

    loc = page.locator(f'input[name="{name_attr}"]')
    count = loc.count()
    if count == 0:
        raise RuntimeError(f"❌ Không tìm thấy field input[name=\"{name_attr}\"]")
    if count > 1:
        print(f"  ⚠ Phát hiện {count} field input[name=\"{name_attr}\"] "
              f"(có thể có honeypot chống bot) → dùng field cuối cùng trong DOM.")
        return loc.last
    return loc.first


def do_login(page):
    """
    Đăng nhập theo đúng flow trong login.har:
    - URL: POST /loginv2/index.php
    - Fields: a (rỗng), username, password
    - Content-Type: multipart/form-data
    - Success: redirect 302 → /study

    Lưu ý: trang login có field honeypot trùng name="password" (đôi khi cả
    "username") để bẫy bot — xem _resolve_real_input().
    """
    if not HM_USERNAME or not HM_PASSWORD:
        raise RuntimeError("❌ Thiếu HM_USERNAME hoặc HM_PASSWORD.")
    print("  → Đăng nhập bằng tài khoản/mật khẩu...")
    login_url = url(HM_LOGIN_PATH)  # /loginv2/index.php

    # Mở trang login trước để lấy cookie phiên
    page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_load_state("networkidle", timeout=20000)

    # Resolve field THẬT, bỏ qua field bẫy (xem docstring _resolve_real_input)
    username_field = _resolve_real_input(page, "username", real_id="realuser")
    password_field = _resolve_real_input(page, "password", real_id="realpass")

    username_field.fill(HM_USERNAME)
    time.sleep(0.2)
    password_field.fill(HM_PASSWORD)
    time.sleep(0.2)

    # Dùng press("Enter") trên password thay vì click để tránh nhầm form tìm kiếm
    password_field.press("Enter")

    # Chờ redirect hoàn tất
    page.wait_for_load_state("networkidle", timeout=20000)
    time.sleep(2)

    # Xác nhận qua cookie thay vì URL (vì có thể bị redirect linh tinh)
    cookies = page.context.cookies()
    if not any(c.get("name") == "MoodleSession" for c in cookies):
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


# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    check_config()

    if CRAWL_MODE == "watch":
        print("▶ Chế độ WATCH — sẽ implement sau khi có API m3u8")
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