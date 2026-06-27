"""
lophoc_api.py — HTTP client cho lophoc.secret.vn
Mục đích: Lấy m3u8 URL cho buổi live qua API (không cần Playwright/browser).

Toàn bộ endpoint được reverse-engineer từ file HAR thật (lophoc.secret.vn),
xem chi tiết trong phan_tich.md (cùng repo). File này CHỈ là HTTP client —
không tự chạy độc lập, được import từ crawl_calendar.py.

⚠️ FIX QUAN TRỌNG so với bản phân tích gốc — TIMEZONE:
API trả `start_time` dạng "2026-06-25T21:00:00.000Z" — có suffix "Z" (thường
nghĩa là UTC). NHƯNG đối chiếu với ảnh chụp lịch thật trên web (ngày 25/06,
21:00 - 23:25, đúng y giá trị ngày/giờ trong start_time) thì đây KHÔNG PHẢI
giờ UTC thật — nếu đúng là UTC thì buổi học phải là 04:00 sáng 26/06 giờ VN,
hoàn toàn không khớp với cái đang hiển thị "21:00 - 23:25" trên web (và cũng
vô lý cho giờ học buổi tối của học sinh). Đây là lỗi mislabel timezone phổ
biến ở backend (lưu giờ VN nhưng serialize kèm "Z" như UTC). => Toàn bộ
parse start_time/end_time trong file này dùng parse_lophoc_time(), GẮN
+07:00 (giờ VN) thay vì +00:00, KHÔNG dùng .replace("Z","+00:00") trực tiếp
như bản đặc tả gốc.

Dependencies: requests (đã có trong requirements.txt)

Cache strategy:
  - Lưu cookies (UUID sessionToken hoặc roomToken JWT) trong Firestore
    app_data/lophoc_session — cache RIÊNG, không đụng app_data/hm_cookies
  - TTL theo JWT exp claim (24h), tự refresh khi còn < 1h
  - Refresh qua /api/auth/room-token (không cần password)
  - Re-login qua /api/auth/verify-user chỉ khi room-token/livestreamlink trả 401
"""
import os
import json
import time
import base64
import logging
import urllib.parse
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests

# ── CONFIG ────────────────────────────────────────────────────────────
# Không hardcode domain trong source. lophoc.secret.vn dùng chung domain gốc
# với HM_BASE_URL (https://secret.vn) đã có sẵn trong GitHub Secrets cho
# crawl_calendar.py — suy ra bằng cách chêm subdomain "lophoc." vào, không
# cần tạo secret mới (tránh duplicate với HM_BASE_URL đã có).
_HM_BASE_URL = os.environ.get("HM_BASE_URL", "")
if _HM_BASE_URL:
    _parsed = urllib.parse.urlparse(_HM_BASE_URL)
    BASE_URL = f"{_parsed.scheme}://lophoc.{_parsed.netloc}"
    _HOST = f"lophoc.{_parsed.netloc}"
else:
    BASE_URL = ""
    _HOST = ""

DEFAULT_TIMEOUT = 10          # seconds
VERIFY_USER_TIMEOUT = 15      # password verify chậm hơn (bcrypt)
JWT_REFRESH_THRESHOLD = 3600  # refresh nếu exp còn dưới 1h
VN_TZ = timezone(timedelta(hours=7))

# ── STANDARD HEADERS (Chrome 149 / Windows — khớp fingerprint trong HAR) ──
STANDARD_HEADERS = {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Connection": "keep-alive",
    "Host": _HOST,
    "Origin": BASE_URL,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"),
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}

logger = logging.getLogger(__name__)


# ── TIME HELPER (xem ghi chú FIX QUAN TRỌNG ở đầu file) ────────────────
def parse_lophoc_time(iso_str: str) -> datetime:
    """
    Parse start_time/end_time từ lophoc API. Giá trị giờ:phút thực chất là
    giờ Việt Nam dù string có suffix "Z" — bỏ "Z", gắn +07:00 thay vì +00:00.
    """
    naive = iso_str.replace("Z", "").replace("z", "")
    return datetime.fromisoformat(naive).replace(tzinfo=VN_TZ)


# ── JWT DECODE (không verify signature — chỉ đọc payload) ─────────────
def decode_jwt_exp(token: str) -> Optional[int]:
    """Trả về Unix epoch seconds của `exp` claim, hoặc None nếu không parse được."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload_b64 = parts[1]
        padding = "=" * (-len(payload_b64) % 4)
        payload_bytes = base64.urlsafe_b64decode(payload_b64 + padding)
        payload = json.loads(payload_bytes)
        return payload.get("exp")
    except Exception as e:
        logger.warning(f"Decode JWT thất bại: {e}")
        return None


def is_jwt_expired(jwt_token: str, threshold_seconds: int = JWT_REFRESH_THRESHOLD) -> bool:
    """True nếu JWT đã hết hạn hoặc sắp hết (trong threshold_seconds)."""
    exp = decode_jwt_exp(jwt_token)
    if exp is None:
        return True
    now = int(time.time())
    return now + threshold_seconds >= exp


# ── SESSION / COOKIE BUILDERS (server không trả Set-Cookie, phải tự set) ──
def _build_session_name_user(phone: str, code: str = "", learn_number: str = "0",
                              lesson_name: str = "", subject: str = "",
                              class_id: str = "") -> str:
    payload = {
        "user": phone,
        "username": phone,
        "displayName": phone,
        "email": phone,
        "role": "student",
        "exp": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
        "current_lesson": {
            "code": code,
            "learn_number": str(learn_number),
            "name": lesson_name or phone,
            "subject": subject,
            "class_id": class_id,
        }
    }
    return base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")


def _set_post_login_cookies(session: requests.Session, phone: str, session_token: str):
    session.cookies.set("_user_session_token", session_token, domain=_HOST)
    session.cookies.set("_user_identifier", phone, domain=_HOST)
    session.cookies.set("user_login_input", phone, domain=_HOST)
    session.cookies.set("session_name_user", _build_session_name_user(phone), domain=_HOST)


def _set_post_room_token_cookies(session: requests.Session, phone: str,
                                  room_token_jwt: str, code: str, learn_number: int,
                                  lesson_name: str = "", subject: str = "", class_id: str = ""):
    session.cookies.set("_user_session_token", room_token_jwt, domain=_HOST)
    session.cookies.set("_class_room_code", code, domain=_HOST)
    session.cookies.set("_learn_number", str(learn_number), domain=_HOST)
    session.cookies.set(
        "session_name_user",
        _build_session_name_user(phone, code, str(learn_number), lesson_name, subject, class_id),
        domain=_HOST,
    )


# ── CORE API FUNCTIONS ────────────────────────────────────────────────
def login_with_password(session: requests.Session, username: str, password: str) -> dict:
    """POST /api/auth/verify-user → sessionToken UUID + user_id."""
    logger.info(f"Login với username={username[:4]}***")
    r = session.post(
        f"{BASE_URL}/api/auth/verify-user",
        json={"user": username, "password": password},
        headers={**STANDARD_HEADERS, "Content-Type": "application/json",
                 "Referer": f"{BASE_URL}/login"},
        timeout=VERIFY_USER_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"Login thất bại: {data}")

    session_token = data["sessionToken"]
    user_id = data["data"]["user_id"]
    _set_post_login_cookies(session, username, session_token)
    logger.info(f"✓ Login OK, user_id={user_id}")
    return {"sessionToken": session_token, "user_id": user_id, "phone": username}


def get_room_token(session: requests.Session, phone: str, code: str, learn_number: int) -> str:
    """POST /api/auth/room-token → JWT roomToken (24h). Bắt buộc trước khi gọi livestreamlink."""
    logger.info(f"Lấy roomToken cho code={code}, learn_number={learn_number}")
    r = session.post(
        f"{BASE_URL}/api/auth/room-token",
        json={"user": phone, "code": code, "learn_number": learn_number},
        headers={**STANDARD_HEADERS, "Content-Type": "application/json",
                 "Referer": f"{BASE_URL}/schedule"},
        timeout=DEFAULT_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"room-token thất bại: {data}")

    room_token = data["roomToken"]
    lesson = data.get("lesson", {})
    _set_post_room_token_cookies(
        session, phone, room_token, code, learn_number,
        lesson.get("lesson_name", ""), lesson.get("subject", ""),
    )
    return room_token


def get_calendar(session: requests.Session, phone: str) -> list[dict]:
    """POST /api/calendar/ → danh sách buổi học sắp tới (CHÚ Ý dấu / cuối URL)."""
    r = session.post(
        f"{BASE_URL}/api/calendar/",
        json={"user": phone},
        headers={**STANDARD_HEADERS, "Content-Type": "application/json",
                 "Referer": f"{BASE_URL}/schedule"},
        timeout=DEFAULT_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        return []
    return data.get("calendar", [])


def get_live_status(session: requests.Session, codes: list[str],
                     code_for_referer: str = "", learn_number: int = 0) -> dict:
    """GET /api/live-status?codes=<csv,csv> → {code: bool}."""
    if not codes:
        return {}
    referer = f"{BASE_URL}/schedule"
    if code_for_referer:
        room_b64 = base64.b64encode(f"{code_for_referer}-{learn_number}".encode()).decode()
        referer = f"{BASE_URL}/room/{room_b64}"

    r = session.get(
        f"{BASE_URL}/api/live-status",
        params={"codes": ",".join(codes)},
        headers={**STANDARD_HEADERS, "Referer": referer},
        timeout=DEFAULT_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        return {}
    return data.get("data", {})


def get_m3u8_url(session: requests.Session, code: str, learn_number: int) -> Optional[str]:
    """
    POST /api/livestreamlink → m3u8 URL.
    ⚠️ Field top-level là 'status' (không phải 'success'); field URL là
    'streamkey' (không gạch dưới — khác 'stream_key' của currentlessonbycode2).
    API luôn trả URL kể cả khi stream chưa live thật — CDN mới quyết định
    404 hay 200, nên vẫn cần get_live_status() trước để tránh gọi vô ích.
    """
    room_b64 = base64.b64encode(f"{code}-{learn_number}".encode()).decode()
    r = session.post(
        f"{BASE_URL}/api/livestreamlink",
        json={"code": code, "learn_number": learn_number},
        headers={**STANDARD_HEADERS, "Content-Type": "application/json",
                 "Referer": f"{BASE_URL}/room/{room_b64}"},
        timeout=DEFAULT_TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("status"):
        logger.warning(f"livestreamlink trả status=false: {data}")
        return None
    items = data.get("data", [])
    if not items:
        return None
    return items[0].get("streamkey")


def check_m3u8_live(m3u8_url: str) -> bool:
    """GET m3u8 URL trực tiếp (không cần cookie) — 200 = live, 404 = chưa live."""
    try:
        r = requests.get(
            m3u8_url,
            headers={"Origin": BASE_URL, "Referer": f"{BASE_URL}/",
                     "User-Agent": STANDARD_HEADERS["User-Agent"]},
            timeout=5,
        )
        return r.status_code == 200
    except requests.RequestException:
        return False


# ── HIGH-LEVEL ORCHESTRATION ──────────────────────────────────────────
class LophocClient:
    """
    Đóng gói toàn bộ flow auth 3 lớp (MoodleSession → sessionToken UUID →
    roomToken JWT) + quản lý cache/refresh tự động.

    Usage:
        client = LophocClient(username, password, cache_loader, cache_saver)
        client.ensure_logged_in()
        lessons = client.get_calendar()
        if client.is_stream_live(code):
            m3u8 = client.get_m3u8(code, learn_number)
    """

    def __init__(self, username: str, password: str, cache_loader=None, cache_saver=None):
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.headers.update(STANDARD_HEADERS)
        self._cache_loader = cache_loader  # callable() -> dict | None
        self._cache_saver = cache_saver    # callable(dict) -> None
        self._load_cache()

    def _load_cache(self):
        if not self._cache_loader:
            return
        cached = self._cache_loader()
        if not cached:
            return
        for name, value in cached.get("cookies", {}).items():
            self.session.cookies.set(name, value, domain=_HOST)
        logger.info(f"✓ Restored {len(cached.get('cookies', {}))} cookies từ cache")

    def _save_cache(self):
        if not self._cache_saver:
            return
        cookies = {c.name: c.value for c in self.session.cookies
                   if _HOST and _HOST in (c.domain or "")}
        self._cache_saver({"cookies": cookies, "updatedAt": datetime.now(timezone.utc).isoformat()})

    def _get_current_jwt(self) -> Optional[str]:
        for c in self.session.cookies:
            if c.name == "_user_session_token" and c.value.startswith("eyJ"):
                return c.value
        return None

    def ensure_logged_in(self):
        """Đảm bảo có JWT hợp lệ (sessionToken UUID hoặc roomToken JWT). Refresh/re-login nếu cần."""
        jwt = self._get_current_jwt()
        if jwt and not is_jwt_expired(jwt):
            logger.info("✓ JWT còn hạn — skip login")
            return

        if not jwt:
            self._do_password_login()
            return

        code = self.session.cookies.get("_class_room_code")
        learn_number_str = self.session.cookies.get("_learn_number")
        if code and learn_number_str:
            try:
                self._refresh_room_token(code, int(learn_number_str))
                return
            except requests.HTTPError as e:
                if e.response is not None and e.response.status_code == 401:
                    logger.info("room-token 401 → re-login bằng password")
                    self._do_password_login()
                else:
                    raise
        else:
            self._do_password_login()

    def _do_password_login(self):
        login_with_password(self.session, self.username, self.password)
        self._save_cache()
        # Sau login chỉ có sessionToken UUID — chưa đủ gọi livestreamlink, cần
        # get_room_token(code, learn_number) riêng cho từng buổi học.

    def _refresh_room_token(self, code: str, learn_number: int):
        get_room_token(self.session, self.username, code, learn_number)
        self._save_cache()

    def get_calendar(self) -> list[dict]:
        self.ensure_logged_in()
        return get_calendar(self.session, self.username)

    def is_stream_live(self, code: str) -> bool:
        self.ensure_logged_in()
        status = get_live_status(self.session, [code], code, 0)
        return status.get(code, False)

    def get_m3u8(self, code: str, learn_number: int, ensure_room_token: bool = True) -> Optional[str]:
        """Lấy m3u8 URL cho 1 buổi học, tự refresh roomToken nếu cần, tự retry 1 lần nếu 401."""
        self.ensure_logged_in()
        if ensure_room_token:
            jwt = self._get_current_jwt()
            jwt_code = self._extract_jwt_claim(jwt, "code") if jwt else None
            if jwt_code != code:
                self._refresh_room_token(code, learn_number)
        try:
            return get_m3u8_url(self.session, code, learn_number)
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 401:
                logger.warning("livestreamlink 401 — re-login và thử lại 1 lần")
                self._do_password_login()
                self._refresh_room_token(code, learn_number)
                return get_m3u8_url(self.session, code, learn_number)
            raise

    def _extract_jwt_claim(self, jwt: str, claim: str) -> Optional[str]:
        try:
            parts = jwt.split(".")
            payload_b64 = parts[1]
            padding = "=" * (-len(payload_b64) % 4)
            payload = json.loads(base64.urlsafe_b64decode(payload_b64 + padding))
            return payload.get(claim)
        except Exception:
            return None