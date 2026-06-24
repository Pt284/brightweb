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
HM_LOGIN_PATH      = os.environ.get("HM_LOGIN_PATH", "")
HM_LOGOUT_V2_PATH  = os.environ.get("HM_LOGOUT_V2_PATH", "")
HM_LOGOUT_FINAL    = os.environ.get("HM_LOGOUT_FINAL_PATH", "")

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


CALENDAR_URL = property(lambda self: url(HM_CAL_PATH))


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
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
        if "login" in page.url.lower():
            return False
        return page.query_selector(".calendar-wrapper") is not None
    except Exception:
        return False


def do_login(page):
    if not HM_USERNAME or not HM_PASSWORD:
        raise RuntimeError("❌ Thiếu HM_USERNAME hoặc HM_PASSWORD.")
    print("  → Đăng nhập bằng tài khoản/mật khẩu...")
    login_url = url(HM_LOGIN_PATH)
    page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_load_state("networkidle", timeout=20000)

    # Điền username — thử nhiều selector phổ biến
    for sel in ['input[name="UserLogin[username]"]', '#UserLoginForm_username', 'input[name="username"]']:
        if page.query_selector(sel):
            page.fill(sel, HM_USERNAME)
            break

    time.sleep(0.3)

    # Điền password
    for sel in ['input[name="UserLogin[password]"]', '#UserLoginForm_password', 'input[name="password"]']:
        if page.query_selector(sel):
            page.fill(sel, HM_PASSWORD)
            break

    time.sleep(0.3)
    page.click('button[type="submit"], input[type="submit"]')
    page.wait_for_load_state("networkidle", timeout=30000)
    time.sleep(2)

    if "login" in page.url.lower():
        raise RuntimeError("❌ Đăng nhập thất bại — kiểm tra lại tài khoản/mật khẩu.")
    print("  ✓ Đăng nhập thành công!")


def do_logout(page):
    """
    Logout đúng flow theo LOGOUT.HAR:
    1. Vào /loginv2/logout.php → lấy sesskey
    2. GET /login/logout.php?sesskey=XXX → hoàn tất
    """
    if not HM_LOGOUT_V2_PATH or not HM_LOGOUT_FINAL:
        print("  ⚠ Thiếu HM_LOGOUT_V2_PATH hoặc HM_LOGOUT_FINAL_PATH — bỏ qua đăng xuất.")
        return
    try:
        logout_v2 = url(HM_LOGOUT_V2_PATH)
        logout_final = url(HM_LOGOUT_FINAL)

        page.goto(logout_v2, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_load_state("networkidle", timeout=10000)

        # Lấy sesskey từ hidden input
        sesskey = None
        el = page.query_selector('input[name="sesskey"]')
        if el:
            sesskey = el.get_attribute("value")
        else:
            # Fallback: regex trong page source
            content = page.content()
            m = re.search(r'sesskey=([A-Za-z0-9]+)', content)
            if m:
                sesskey = m.group(1)

        if not sesskey:
            print("  ⚠ Không tìm được sesskey — bỏ qua đăng xuất.")
            return

        page.goto(f"{logout_final}?sesskey={sesskey}",
                  wait_until="domcontentloaded", timeout=15000)
        page.wait_for_load_state("networkidle", timeout=10000)
        print("  ✓ Đã đăng xuất thành công.")
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
                "Chrome/125.0.0.0 Safari/537.36"
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
