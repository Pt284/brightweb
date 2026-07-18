"""
tools/test_push.py — Test script chạy LOCAL để kiểm tra toàn bộ luồng push.

Làm 4 việc:
  1. Đọc push_subscriptions → gửi test push trực tiếp bằng pywebpush
     (xác nhận VAPID key đúng, subscriber nhận được notification)
  2. Demo lỗi format ngày: so sánh Python vs JS ISO string
  3. Tạo test session_clicks document đúng format (với users subcollection)
     → để cron Worker có thể tìm thấy khi chạy
  4. In ra thời gian chính xác bạn cần đợi để nhận reminder

Dùng: pip install pywebpush
Env:  GOOGLE_CREDENTIALS_JSON, FIRESTORE_PROJECT_ID,
      VAPID_PRIVATE_KEY, VAPID_SUBJECT, SITE_URL
"""

import os
import sys
import json
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from firestore_rest import (
    read_fs, write_fs, delete_doc,
    list_active_subscriptions, firestore_now_iso
)

VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT     = os.environ.get("VAPID_SUBJECT", "")
SITE_URL          = os.environ.get("SITE_URL", "").rstrip("/")
WORKER_BASE       = "https://brightweb-sync.mcdg5444.workers.dev"

VN_TZ = timezone(timedelta(hours=7))


# ─────────────────────────────────────────────────────────────────────────────
# 1. Demo lỗi format ngày
# ─────────────────────────────────────────────────────────────────────────────
def demo_date_format_bug():
    print("\n" + "="*60)
    print("📌 DEMO: Lỗi format ngày (root cause của bug)")
    print("="*60)

    dt = datetime(2026, 7, 13, 3, 33, 0, tzinfo=timezone.utc)

    python_fmt = dt.isoformat()          # "2026-07-13T03:33:00+00:00"
    js_fmt     = dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")  # "2026-07-13T03:33:00.000Z"
    js_fixed   = dt.strftime("%Y-%m-%dT%H:%M:%S+00:00") # "2026-07-13T03:33:00+00:00"

    print(f"Python isoformat()  : '{python_fmt}'")
    print(f"JS .toISOString()   : '{js_fmt}'   ← cái Worker dùng (SAI)")
    print(f"JS fixed format     : '{js_fixed}'  ← cái sẽ sửa thành")
    print()

    # Kiểm tra lexicographic comparison như Firestore làm
    window_start_wrong = "2026-07-13T03:33:00.000Z"
    window_start_fixed = "2026-07-13T03:33:00+00:00"

    print(f"Firestore GTE với window SAI:  '{python_fmt}' >= '{window_start_wrong}' → {python_fmt >= window_start_wrong}")
    print(f"Firestore GTE với window FIX:  '{python_fmt}' >= '{window_start_fixed}' → {python_fmt >= window_start_fixed}")
    print()
    print("→ Bug: Worker dùng format SAI nên Firestore KHÔNG tìm được document!")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Gửi test push trực tiếp (không qua cron)
# ─────────────────────────────────────────────────────────────────────────────
def send_test_push_direct():
    print("\n" + "="*60)
    print("🔔 TEST 1: Gửi test push TRỰC TIẾP (bypass cron)")
    print("="*60)

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        print("❌ Cần: pip install pywebpush")
        return

    if not VAPID_PRIVATE_KEY:
        print("❌ Thiếu env VAPID_PRIVATE_KEY")
        return

    print("Đọc subscriptions từ Firestore...")
    try:
        subs = list_active_subscriptions()
    except Exception as e:
        print(f"❌ Lỗi đọc subscriptions: {e}")
        return

    if not subs:
        print("⚠ Chưa có subscriber nào. Hãy vào site và bấm nút 🔔 trước.")
        return

    print(f"  → {len(subs)} subscriber active")

    now_vn = datetime.now(VN_TZ).strftime("%H:%M:%S")
    payload = json.dumps({
        "title": "🧪 Test Push từ local script",
        "body":  f"Nếu bạn thấy cái này ({now_vn} VN) → VAPID key OK!",
        "url":   SITE_URL + "/",
        "tag":   "test-direct",
    })

    for s in subs:
        try:
            webpush(
                subscription_info={"endpoint": s["endpoint"], "keys": s["keys"]},
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=60,
            )
            print(f"  ✅ Đã gửi tới {s.get('email', s.get('uid', '?'))}")
        except WebPushException as e:
            code = getattr(e.response, "status_code", None) if e.response else None
            print(f"  ❌ {s.get('email', '?')} → HTTP {code}: {e}")
        except Exception as e:
            print(f"  ❌ {s.get('email', '?')} → {e}")


# ─────────────────────────────────────────────────────────────────────────────
# 3. Tạo test session_clicks document (đúng format, có users subcollection)
# ─────────────────────────────────────────────────────────────────────────────
def create_test_session(minutes_from_now: float = 1.5):
    """
    Tạo session_clicks document để test cron Worker.
    minutes_from_now: bao nhiêu phút nữa thì session 'bắt đầu'
    Cron sẽ nhận ra khi cửa sổ [now-30s, now+150s] bao phủ startAt.
    """
    # ── PRODUCTION GUARD ─────────────────────────────────────────────────────
    # Script này đọc TOÀN BỘ subscriber thật và tạo document khiến cron Worker
    # gửi push thật cho cả nhóm. Chặn hoàn toàn trừ khi:
    #   (a) đang chạy với Firestore Emulator  → FIRESTORE_EMULATOR_HOST được set, HOẶC
    #   (b) người dùng chủ động xác nhận      → ALLOW_PROD_PUSH=yes (hoặc ALLOW_PROD_TEST,
    #       giữ lại để tương thích ngược) được set
    # [Phase 0 fix] Trước đây guard này CHỈ nhận ALLOW_PROD_TEST, khác tên với
    # guard ở đầu main() (ALLOW_PROD_PUSH) — user làm đúng theo hướng dẫn lỗi
    # của main() thì lọt qua send_test_push_direct() (đã gửi push thật!) rồi
    # mới bị chặn ở ĐÂY bởi 1 biến môi trường khác họ chưa từng biết tới.
    _prod_ok = (
        os.environ.get("FIRESTORE_EMULATOR_HOST")
        or os.environ.get("ALLOW_PROD_PUSH") == "yes"
        or os.environ.get("ALLOW_PROD_TEST")
    )
    if not _prod_ok:
        print("❌ DỪNG: Script này sẽ gửi push THẬT cho TOÀN BỘ subscriber production!")
        print("   Cron Worker đang chạy mỗi phút và sẽ TỰ ĐỘNG tìm thấy document giả này.")
        print()
        print("   Nếu muốn test với Firestore Emulator:")
        print("     $env:FIRESTORE_EMULATOR_HOST='localhost:8080'")
        print()
        print("   Nếu CHẮC CHẮN muốn chạy trên production (hiểu rõ hậu quả):")
        print("     $env:ALLOW_PROD_PUSH='yes'")
        sys.exit(1)
    # ─────────────────────────────────────────────────────────────────────────

    print("\n" + "="*60)
    print("📋 TEST 2: Tạo test session document (đúng format)")
    print("="*60)

    subs = []
    try:
        subs = list_active_subscriptions()
        print(f"  Tìm thấy {len(subs)} subscriber để tạo users docs")
    except Exception as e:
        print(f"  ⚠ Không đọc được subscriptions: {e}")

    now_utc   = datetime.now(timezone.utc)
    start_at  = now_utc + timedelta(minutes=minutes_from_now)

    # Format khớp với Python isoformat() → không có milliseconds khi là giây tròn
    # Đây là format mà Firestore sẽ so sánh với chuỗi từ Worker (sau khi fix)
    start_at_str = start_at.replace(microsecond=0).isoformat()
    now_str       = now_utc.isoformat()

    # Tính cửa sổ Worker (sau khi fix) để confirm document sẽ được tìm thấy
    window_start = (now_utc - timedelta(seconds=30)).replace(microsecond=0).isoformat()
    window_end   = (now_utc + timedelta(seconds=150)).replace(microsecond=0).isoformat()
    trigger_at   = datetime.now(VN_TZ) + timedelta(minutes=minutes_from_now)

    print(f"\n  startAt được tạo: '{start_at_str}'")
    print(f"  Cửa sổ Worker:   [{window_start}, {window_end}]")

    if window_start <= start_at_str <= window_end:
        print(f"  ✅ Document NẰM TRONG cửa sổ → cron sẽ tìm thấy NGAY")
    else:
        mins = minutes_from_now
        print(f"  ℹ  Document nằm NGOÀI cửa sổ hiện tại (chủ ý)")
        print(f"  → Cron sẽ tìm thấy khi đồng hồ đến ~{trigger_at.strftime('%H:%M:%S')} VN")

    sid = "test_cron_" + start_at.strftime("%H%M")
    doc_path = f"session_clicks/{sid}"

    print(f"\n  Document ID: {sid}")

    # Xoá doc cũ (nếu có) để test sạch
    try:
        delete_doc(doc_path)
        print(f"  🗑 Đã xoá doc cũ (nếu có)")
    except Exception:
        pass

    # Tạo document chính
    write_fs(doc_path, {
        "sessionId":    {"stringValue": sid},
        "subject":      {"stringValue": "Test Cron Reminder"},
        "title":        {"stringValue": "Buổi học thử nghiệm (auto-created)"},
        "date":         {"stringValue": start_at.strftime("%Y-%m-%d")},
        "time":         {"stringValue": start_at.astimezone(VN_TZ).strftime("%H:%M")},
        "startAt":      {"stringValue": start_at_str},
        "realLink":     {"stringValue": "https://www.youtube.com/shorts/guGqa5X9yBU"},
        "notified":     {"booleanValue": True},
        "reminderSent": {"booleanValue": False},
        "createdAt":    {"stringValue": now_str},
    })
    print(f"  ✅ Đã tạo document session_clicks/{sid}")

    # Tạo users subcollection cho từng subscriber
    if subs:
        for s in subs:
            user_path = f"{doc_path}/users/{s['uid']}"
            write_fs(user_path, {
                "clicked":    {"booleanValue": False},
                "clickedAt":  {"nullValue": None},
                "remindedAt": {"nullValue": None},
                "createdAt":  {"stringValue": now_str},
            })
            print(f"  ✅ Đã tạo users/{s['uid']} (email: {s.get('email', '?')})")
    else:
        print("  ⚠ Không có subscriber → không tạo users docs")
        print("     Hãy subscribe trên site trước, rồi chạy lại script này")

    print(f"\n  ⏰ Cron sẽ gửi reminder vào khoảng: {trigger_at.strftime('%H:%M:%S')} VN")
    print(f"     (hoặc sớm hơn nếu startAt nằm trong cửa sổ hiện tại)")

    return sid, start_at_str


# ─────────────────────────────────────────────────────────────────────────────
# 4. Xác nhận format sau khi Worker được fix
# ─────────────────────────────────────────────────────────────────────────────
def verify_date_format_fix():
    print("\n" + "="*60)
    print("✅ Xác nhận: Format sau khi fix Worker")
    print("="*60)

    now_utc = datetime.now(timezone.utc)
    # Simulate Worker's toFirestoreIso() sau khi fix
    # JS: new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00')
    # = bỏ milliseconds, thay Z thành +00:00
    window_start = (now_utc - timedelta(seconds=30)).replace(microsecond=0).isoformat()
    window_end   = (now_utc + timedelta(seconds=150)).replace(microsecond=0).isoformat()

    print(f"  Worker window (fixed): [{window_start}]")
    print(f"                     to: [{window_end}]")
    print()
    print("  Python isoformat()  : '...+00:00' ← format sẽ được so sánh")
    print("  JS toFirestoreIso() : '...+00:00' ← format sau fix (match!)")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def main():
    # [Phase 0] Landmine guard: script này gửi push THẬT + ghi Firestore THẬT
    # (send_test_push_direct, create_test_session). Bắt buộc set env rõ ràng
    # để tránh ai chạy nhầm lúc đang debug và spam cả group.
    if os.environ.get("ALLOW_PROD_PUSH") != "yes":
        sys.exit(
            "❌ test_push blocked in prod — script này gửi push THẬT tới mọi subscriber.\n"
            "   Nếu chắc chắn muốn chạy: set ALLOW_PROD_PUSH=yes rồi chạy lại."
        )

    missing = [k for k in ["GOOGLE_CREDENTIALS_JSON", "FIRESTORE_PROJECT_ID",
                            "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]
               if not os.environ.get(k)]
    if missing:
        print(f"❌ Thiếu env vars: {', '.join(missing)}")
        print("Chạy: $env:GOOGLE_CREDENTIALS_JSON='...' (PowerShell)")
        return

    # Demo bug format
    demo_date_format_bug()

    # Xác nhận fix
    verify_date_format_fix()

    # Gửi test push trực tiếp (bypass cron)
    send_test_push_direct()

    # Tạo test session cho cron (startAt = now + 90s)
    sid, start_at_str = create_test_session(minutes_from_now=1.5)  # 90 giây

    print("\n" + "="*60)
    print("📋 TỔNG KẾT")
    print("="*60)
    print(f"  Test session ID: {sid}")
    print(f"  startAt:         {start_at_str}")
    print()
    print("  Việc cần làm tiếp theo:")
    print("  1. ✅ Paste worker.js MỚI (đã fix format) lên Cloudflare")
    print("  2. ✅ Bật Cron Trigger '* * * * *' trên Cloudflare Dashboard")
    print("  3. ⏳ Đợi ~1-2 phút → bạn sẽ nhận 3 notification liên tiếp")
    print("  4. 🔍 Kiểm tra Firestore: reminderSent phải đổi thành true")
    print()
    print("  Xem logs: Cloudflare Dashboard → Workers → brightweb-sync → Logs")


if __name__ == "__main__":
    main()
