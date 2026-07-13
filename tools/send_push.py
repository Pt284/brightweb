"""
tools/send_push.py — Gửi Web Push "🆕 Link học mới" cho tất cả subscriber.

Chạy sau bước crawl_calendar.py trong cùng GitHub Actions job.
Logic:
  1. Đọc app_data/schedule từ Firestore
  2. Lọc event có m3u8 (đang live) VÀ có sessionId
  3. Với mỗi session: kiểm tra session_clicks/{sid} đã tồn tại chưa
     → nếu đã có → skip (tránh gửi trùng khi watch-mode chạy lại)
  4. Lấy toàn bộ push_subscriptions active=true
  5. Gửi Web Push bằng pywebpush
  6. Tạo session_clicks/{sid} + users/{uid} sau khi gửi xong

Env vars cần:
  GOOGLE_CREDENTIALS_JSON, FIRESTORE_PROJECT_ID  (giống crawl_calendar.py)
  VAPID_PRIVATE_KEY  — base64url encoded private key
  VAPID_SUBJECT      — 'mailto:...'
  SITE_URL           — 'https://pt284.github.io/brightweb' (không có / cuối)
"""

import os
import sys
import json
from urllib.parse import quote

# Thêm thư mục cha vào path để import firestore_rest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from firestore_rest import (
    read_fs,
    write_fs,
    delete_doc,
    list_active_subscriptions,
    firestore_now_iso,
)

# ── ENV ────────────────────────────────────────────────────────────────────────
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT     = os.environ.get("VAPID_SUBJECT", "")
SITE_URL          = os.environ.get("SITE_URL", "").rstrip("/")

WORKER_BASE = "https://brightweb-sync.mcdg5444.workers.dev"
SCHEDULE_DOC = "app_data/schedule"


def check_env():
    missing = [k for k in ["VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "SITE_URL",
                            "GOOGLE_CREDENTIALS_JSON", "FIRESTORE_PROJECT_ID"]
               if not os.environ.get(k)]
    if missing:
        raise EnvironmentError(f"Thiếu env vars: {', '.join(missing)}")


def send_one(sub: dict, payload_str: str) -> bool:
    """
    Gửi 1 Web Push tới 1 subscription.
    Trả về True nếu thành công, False nếu subscription không còn valid.
    """
    from pywebpush import webpush, WebPushException

    try:
        webpush(
            subscription_info={
                "endpoint": sub["endpoint"],
                "keys": sub["keys"],
            },
            data=payload_str,
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=86400,   # notification sống 24h nếu device offline
        )
        print(f"    ✓ → {sub.get('email', sub.get('uid', '?'))}")
        return True
    except WebPushException as e:
        code = getattr(e.response, "status_code", None) if e.response else None
        print(f"    ✗ → {sub.get('email', '?')} [HTTP {code}]")
        # 404/410 = subscription đã hết hạn → xoá khỏi Firestore
        if code in (404, 410):
            try:
                delete_doc(f"push_subscriptions/{sub['id']}")
                print(f"      🗑 Đã xoá subscription hỏng: {sub['id']}")
            except Exception as del_e:
                print(f"      ⚠ Không xoá được: {del_e}")
        return False
    except Exception as e:
        print(f"    ✗ → {sub.get('email', '?')} [lỗi không xác định: {e}]")
        return False


def main():
    check_env()

    # ── 1. Đọc schedule ──────────────────────────────────────────────────────
    print("📅 Đọc schedule từ Firestore...")
    fields = read_fs(SCHEDULE_DOC)
    if not fields:
        print("Không có schedule → kết thúc.")
        return

    try:
        data   = json.loads(fields["json"]["stringValue"])
        events = data.get("events", [])
    except Exception as e:
        print(f"Lỗi parse schedule JSON: {e}")
        return

    # ── 2. Lọc event có m3u8 ─────────────────────────────────────────────────
    live_events = [
        e for e in events
        if e.get("m3u8") and e.get("sessionId")
    ]
    print(f"  → {len(live_events)} session đang có m3u8 / {len(events)} tổng")

    if not live_events:
        print("Không có session nào đang live → kết thúc.")
        return

    # ── 3. Lấy tất cả subscriber ─────────────────────────────────────────────
    print("👥 Lấy danh sách subscribers...")
    try:
        subs = list_active_subscriptions()
    except Exception as e:
        print(f"Lỗi lấy subscribers: {e}")
        return

    print(f"  → {len(subs)} subscriber active")
    if not subs:
        print("Chưa có ai subscribe → kết thúc.")
        return

    # ── 4. Gửi push cho từng session chưa được thông báo ─────────────────────
    sent_count = 0
    for ev in live_events:
        sid     = ev["sessionId"]
        subject = ev.get("subject", "Link học mới")
        title   = ev.get("title", "")
        date    = ev.get("date", "")
        time_s  = ev.get("time", "")
        m3u8    = ev.get("m3u8", "")
        start_at = ev.get("startAt") or ""

        # Kiểm tra đã thông báo chưa (document tồn tại = đã gửi)
        print(f"\n🔍 Kiểm tra session {sid} ({subject} — {date} {time_s})...")
        existing = read_fs(f"session_clicks/{sid}")
        if existing is not None:
            print(f"  ↩ Đã thông báo trước đó → skip")
            continue

        print(f"  📣 Gửi thông báo tới {len(subs)} subscriber...")
        now_iso = firestore_now_iso()

        # Tạo session_clicks doc TRƯỚC KHI gửi push
        # → "chốt" để tránh gửi trùng nếu job bị retry hoặc crash giữa chừng
        write_fs(f"session_clicks/{sid}", {
            "sessionId":    {"stringValue": sid},
            "subject":      {"stringValue": subject},
            "title":        {"stringValue": title},
            "date":         {"stringValue": date},
            "time":         {"stringValue": time_s},
            "startAt":      {"stringValue": start_at},
            "realLink":     {"stringValue": m3u8},
            "notified":     {"booleanValue": True},
            "reminderSent": {"booleanValue": False},
            "createdAt":    {"stringValue": now_iso},
        })

        # Tạo users sub-docs
        for s in subs:
            try:
                write_fs(f"session_clicks/{sid}/users/{s['uid']}", {
                    "clicked":    {"booleanValue": False},
                    "clickedAt":  {"nullValue": None},
                    "remindedAt": {"nullValue": None},
                    "createdAt":  {"stringValue": now_iso},
                })
            except Exception as e:
                print(f"  ⚠ Không tạo user doc {s.get('uid')}: {e}")

        # Gửi push cá nhân hoá cho từng subscriber
        ok_count = 0
        for s in subs:
            # URL cá nhân hoá: khi click → Worker ghi clicked=true rồi redirect
            go_url = (
                f"{WORKER_BASE}/go"
                f"?session={sid}"
                f"&user={s['uid']}"
                f"&to={quote(m3u8, safe='')}"
            )
            payload = json.dumps({
                "title":     f"🆕 {subject}",
                "body":      f"{title} — {date} {time_s}",
                "url":       go_url,
                "tag":       f"new-{sid}",
                "sessionId": sid,
            })
            if send_one(s, payload):
                ok_count += 1

        print(f"  ✅ Đã gửi: {ok_count}/{len(subs)}")
        sent_count += 1

    print(f"\n🎉 Xong! Đã thông báo {sent_count} session mới.")


if __name__ == "__main__":
    main()
