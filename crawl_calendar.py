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
# QUAN TRỌNG: server_only/* bị chặn hoàn toàn pha client (được khai báo trong firebase.rule).
# KHÔNG đưa bất kỳ dữ liệu nhạy cảm nào sang app_data (read: if request.auth != null).
COOKIE_DOC = "server_only/hm_cookies"
SCHEDULE_DOC = "app_data/schedule"
LOPHOC_SESSION_DOC = "server_only/lophoc_session"


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


# ── HTTP CRAWL HELPERS ───────────────────────────────────────────────────────
import requests

def do_login(session: requests.Session):
    if not HM_USERNAME or not HM_PASSWORD:
        raise RuntimeError("❌ Thiếu HM_USERNAME hoặc HM_PASSWORD.")
    print("  → Đăng nhập bằng HTTP POST...")
    login_url = url(HM_LOGIN_PATH)

    # Xoá cookie cũ để tránh Moodle nhận nhầm session cũ hết hạn
    session.cookies.clear()

    # GET trang login trước để lấy CSRF token (logintoken) — Moodle yêu cầu field này
    login_page = session.get(login_url, timeout=15)
    m_token = re.search(r'name=["\']logintoken["\']\s+value=["\']([^"\']+)["\']', login_page.text)
    logintoken = m_token.group(1) if m_token else ""
    if logintoken:
        print(f"  ℹ logintoken: {logintoken[:12]}...")
    else:
        print("  ⚠ Không tìm thấy logintoken trong trang login — thử POST không có token.")

    payload = {"username": HM_USERNAME, "password": HM_PASSWORD, "a": "", "logintoken": logintoken}
    r = session.post(login_url, data=payload, allow_redirects=False, timeout=15)

    # Verify thật: gọi thử endpoint cần đăng nhập — nếu bị redirect về trang login là sai mật khẩu/bị chặn
    test = session.get(url(HM_CAL_PATH), timeout=15, allow_redirects=False)
    is_redirected_to_login = (
        test.status_code in (301, 302, 303)
        and "login" in test.headers.get("location", "").lower()
    )
    if is_redirected_to_login or not session.cookies.get("MoodleSession"):
        raise RuntimeError(
            f"❌ Đăng nhập thất bại — sai tài khoản/mật khẩu hoặc bị chặn. "
            f"HTTP POST: {r.status_code}, HTTP verify: {test.status_code}"
        )
    print("  ✓ Đăng nhập thành công (đã verify bằng cách gọi thử trang cần login)!")


def do_logout(session: requests.Session):
    if not HM_LOGOUT_V2_PATH:
        return
    try:
        logout_v2 = url(HM_LOGOUT_V2_PATH)
        r = session.get(logout_v2, timeout=15)
        
        sesskey = None
        m_key = re.search(r'sesskey[=:]\s*["\']?([A-Za-z0-9]+)', r.text)
        if m_key:
            sesskey = m_key.group(1)
            
        if sesskey and HM_LOGOUT_FINAL:
            logout_final = url(HM_LOGOUT_FINAL)
            session.get(f"{logout_final}?sesskey={sesskey}", timeout=15)
            
            # Kiểm tra xem đã logout thật chưa
            test = session.get(url(HM_CAL_PATH), timeout=15, allow_redirects=False)
            if test.status_code in (301, 302, 303) and "login" in test.headers.get("location", "").lower():
                print("  ✓ Đã đăng xuất thành công (HTTP).")
            else:
                print("  ⚠ Logout có thể chưa thành công — session vẫn còn hiệu lực tạm thời.")
    except Exception as e:
        print(f"  ⚠ Đăng xuất lỗi (bỏ qua): {e}")


def fetch_calendar_api(session: requests.Session, months: int) -> list[dict]:
    """Gọi API JSON trực tiếp thay vì cào DOM."""
    now = datetime.now(timezone(timedelta(hours=7)))
    start_date = now.replace(day=1)
    
    end_month = start_date.month + months
    end_year = start_date.year + (end_month - 1) // 12
    end_month = (end_month - 1) % 12 + 1
    
    # Check edge case if day is 31 and end_month has 30 days, just use day=1 for safe end_date
    end_date = datetime(end_year, end_month, 1, tzinfo=VN_TZ)
    
    api_url = f"{HM_BASE.rstrip('/')}/study/calendar/event"
    params = {
        "debug": "1",
        "exam": "",
        "subject": "",
        "start": start_date.strftime("%Y-%m-%dT00:00:00+07:00"),
        "end": end_date.strftime("%Y-%m-%dT00:00:00+07:00")
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": url(HM_CAL_PATH)
    }
    
    print(f"  → Đang tải API từ {params['start']} đến {params['end']}...")
    r = session.get(api_url, params=params, headers=headers, timeout=20)
    r.raise_for_status()
    raw_events = r.json()
    if not isinstance(raw_events, list):
        raise RuntimeError(f"API trả về không phải list (có thể lỗi auth/rate-limit): {str(raw_events)[:200]}")
    
    events = []
    for ev in raw_events:
        start_iso = ev.get("start")
        if not start_iso: continue
        
        try:
            dt = datetime.fromisoformat(start_iso)
            # Make timezone aware if naive
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=VN_TZ)
        except Exception:
            continue
            
        date_str = dt.strftime("%Y-%m-%d")
        time_str = dt.strftime("%H:%M")
        title = ev.get("title", "")
        
        props = ev.get("extendedProps", {})
        subject = props.get("subject", "")
        color = props.get("color", "")
        
        if dt < now:
            status = "past"
        elif dt <= now + timedelta(minutes=30):
            status = "open"
        else:
            status = "upcoming"
            
        events.append({
            "date": date_str,
            "time": time_str,
            "subject": subject,
            "title": title,
            "color": color,
            "status": status,
            "m3u8": None,
            "liveStartEpoch": None,
            "sessionId": session_id(date_str, time_str, title),
            "startAt": compute_start_at(date_str, time_str)
        })
    return events


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
                if old_ev.get("m3u8") and old_ev.get("title") == ev.get("title"):
                    # Lùi lịch: giữ m3u8 nhưng dùng giờ mới
                    ev["m3u8"] = old_ev["m3u8"]
                    ev["liveStartEpoch"] = old_ev.get("liveStartEpoch")
                    print(f"  ⚠ Phát hiện lùi lịch: {ev['subject']} — {ev['title']} ngày {ev['date']} từ {old_ev['time']} → {ev['time']}")
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

    target_events = [ev for ev in events if _is_soon(ev)]

    if not target_events:
        print(f"  ℹ Không có buổi học nào trong cửa sổ kiểm tra hôm nay ({today_str}).")
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

        old_m3u8 = ev.get("m3u8")
        link_changed = bool(old_m3u8) and (m3u8_url != old_m3u8)

        # Check trực tiếp CDN xem có trả 200 không (m3u8 cần Referer/Origin)
        cdn_note = "?"
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
                
            cdn_note = f"HTTP {r_cdn.status_code}"
        except Exception as e:
            cdn_note = f"lỗi check: {e}"

        if not old_m3u8 or link_changed:
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
                    if link_changed:
                        print(f"    🔄 LINK ĐÃ ĐỔI ({cdn_note}): ...{old_m3u8[-30:]} → ...{m3u8_url[-30:]}")
                    else:
                        print(f"    🔴 Có link ({cdn_note}): {m3u8_url[:60]}...")
                    break
        else:
            print(f"    = Không đổi ({cdn_note})")

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

    print(f"▶ Bắt đầu crawl lịch qua API (mode={CRAWL_MODE}, months={MONTHS_TO_CRAWL})...")
    
    session = requests.Session()
    did_login = False

    # Bước 1: Load cookie từ Firestore
    if GOOGLE_CREDENTIALS_JSON:
        print("▶ Đọc cookie từ Firestore...")
        saved = load_cookies_from_firestore()
        if saved:
            for c in saved:
                session.cookies.set(c.get("name"), c.get("value"), domain=c.get("domain", ".hocmai.vn"))
            print(f"  ✓ Loaded {len(saved)} cookies")

    # Bước 2: Kiểm tra đăng nhập (bằng cách lấy thử 1 api rỗng)
    if not session.cookies.get("MoodleSession"):
        print("  Cookie không có MoodleSession → đăng nhập bằng tài khoản...")
        do_login(session)
        did_login = True
        if GOOGLE_CREDENTIALS_JSON:
            save_cookies([{"name": c.name, "value": c.value, "domain": c.domain} for c in session.cookies])

    # Bước 3: Fetch API
    try:
        all_events = fetch_calendar_api(session, MONTHS_TO_CRAWL)
        print(f"  ✓ API trả về {len(all_events)} sự kiện")
    except Exception as e:
        print(f"  ❌ Lấy lịch qua API thất bại: {e}")
        # Thử đăng nhập lại 1 lần nếu lỗi 401/403/500
        print("  → Thử đăng nhập lại...")
        try:
            do_login(session)
            did_login = True
            if GOOGLE_CREDENTIALS_JSON:
                save_cookies([{"name": c.name, "value": c.value, "domain": c.domain} for c in session.cookies])
            all_events = fetch_calendar_api(session, MONTHS_TO_CRAWL)
            print(f"  ✓ API trả về {len(all_events)} sự kiện")
        except Exception as retry_e:
            print(f"  ❌ Retry thất bại: {retry_e}")
            raise SystemExit(1)

    # Bước 4: Đăng xuất
    if did_login:
        print("▶ Đăng xuất...")
        do_logout(session)

    # Bước 5: Dedup + sort
    seen = set()
    unique: list[dict] = []
    for ev in all_events:
        key = (ev["date"], ev["time"], ev["subject"], ev["title"])
        if key not in seen:
            seen.add(key)
            unique.append(ev)
    unique.sort(key=lambda e: (e["date"], e["time"]))

    # Bước 6: Merge với data cũ (giữ m3u8 đã có)
    had_old_data = False
    if GOOGLE_CREDENTIALS_JSON:
        print("▶ Đọc schedule cũ để merge...")
        old_data = load_existing_schedule()
        had_old_data = True
        unique = merge_events(unique, old_data)

    output = {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "events": unique
    }

    print(f"✓ Tổng số buổi học sau khi merge: {len(unique)}")

    # Bước 7: Guard — không ghi đè nếu dữ liệu bất thường (auth fail / rate-limit / lỗi API)
    if len(unique) == 0:
        print("⚠ API trả về 0 sự kiện sau merge — có thể lỗi auth/rate-limit. KHÔNG ghi đè schedule, giữ nguyên dữ liệu cũ.")
        return
    if GOOGLE_CREDENTIALS_JSON:
        old_count = len(old_data.get("events", [])) if had_old_data else 0
        if old_count > 0 and len(unique) < old_count * 0.5:
            print(f"⚠ Số sự kiện mới ({len(unique)}) giảm hơn 50% so với cũ ({old_count}) — nghi ngờ lỗi. KHÔNG ghi đè.")
            return

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