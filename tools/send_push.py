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

    sub_id = sub.get('id', '?')  # [H6] chỉ log doc ID, không log email/PII
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
            timeout=15,  # [H4] tránh treo vô hạn nếu push endpoint không phản hồi
        )
        print(f"    ✓ subscription/{sub_id}")
        return True
    except WebPushException as e:
        code = getattr(e.response, "status_code", None) if e.response else None
        print(f"    ✗ subscription/{sub_id} [HTTP {code}]")
        # 404/410 = subscription đã hết hạn → xoá khỏi Firestore
        if code in (404, 410):
            try:
                delete_doc(f"push_subscriptions/{sub_id}")
                print(f"      🗑 Đã xoá subscription hỏng: {sub_id}")
            except Exception as del_e:
                print(f"      ⚠ Không xoá được: {del_e}")
        return False
    except Exception as e:
        # Không log exception object trực tiếp — có thể chứa endpoint URL (bearer token trong path)
        print(f"    ✗ subscription/{sub_id} [lỗi: {type(e).__name__}]")
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

        print(f"\n🔍 Kiểm tra session {sid} ({subject} — {date} {time_s})...")
        existing = read_fs(f"session_clicks/{sid}")
        old_real_link = existing.get("realLink", {}).get("stringValue") if existing else None

        is_new_session = existing is None
        is_link_changed = (existing is not None) and old_real_link and (old_real_link != m3u8)

        if not is_new_session and not is_link_changed:
            print(f"  ↩ Đã thông báo đúng link này rồi → skip")
            continue

        push_title = "🗣🔥🔥🔥 ĐÃ CÓ LINK HỌC 😈" if is_new_session else "📡 LINK BỊ THAY ĐỔI ĐỘT NGỘT"

        # [BUG #7] Log rõ khi startAt rỗng thay vì âm thầm bỏ qua reminder
        if not start_at:
            print(f"  ⚠ Session {sid} không có startAt hợp lệ → vẫn gửi 'link mới' nhưng SẼ KHÔNG có reminder T-90s")

        # [BUG #5] Gửi push TRƯỚC — chỉ ghi Firestore khi có ít nhất 1 thành công
        print(f"  📣 Gửi thông báo tới {len(subs)} subscriber...")
        ok_count = 0
        sent_results = []
        for s in subs:
            uid = s.get("uid")
            if not uid:
                print(f"  ⚠ Bỏ qua subscription thiếu uid: {s.get('id', '?')}")
                continue
                
            # [C4] URL-encode sid và uid để tránh parameter injection
            # (uid do client cung cấp lúc subscribe, có thể chứa ký tự đặc biệt)
            go_url = (
                f"{WORKER_BASE}/go"
                f"?session={quote(sid, safe='')}"
                f"&user={quote(uid, safe='')}"
                f"&to={quote(m3u8, safe='')}"
            )
            payload = json.dumps({
                "title":     push_title,
                "body":      f"{subject} — {title} — {date} {time_s}",
                "url":       go_url,
                "tag":       f"new-{sid}",
                "sessionId": sid,
            })
            success = send_one(s, payload)
            if success:
                ok_count += 1
            sent_results.append((s, success))

        print(f"  ✅ Đã gửi: {ok_count}/{len(subs)}")

        if ok_count == 0:
            print(f"  ❌ Gửi thất bại toàn bộ cho session {sid} → KHÔNG tạo session_clicks, sẽ thử lại ở lần chạy kế")
            continue   # Không set notified → lần sau retry

        # [BUG #5] Chỉ tạo session_clicks + users/{uid} SAU KHI xác nhận có ít nhất 1 gửi thành công
        now_iso = firestore_now_iso()
        write_fs(f"session_clicks/{sid}", {
            "sessionId":    {"stringValue": sid},
            "subject":      {"stringValue": subject},
            "title":        {"stringValue": title},
            "date":         {"stringValue": date},
            "time":         {"stringValue": time_s},
            "startAt":      {"stringValue": start_at},
            "realLink":     {"stringValue": m3u8},
            "reminderSent": {"booleanValue": False},
            "createdAt":    {"stringValue": existing.get("createdAt",{}).get("stringValue", now_iso) if existing else now_iso},
            "updatedAt":    {"stringValue": now_iso},
        })

        # Tạo users sub-docs cho MỌI subscriber (kể cả người gửi push thất bại — vẫn cần
        # doc này để reminderJob biết mà nhắc lại sau)
        for s, success in sent_results:
            uid = s.get("uid")
            if not uid: continue
            try:
                write_fs(f"session_clicks/{sid}/users/{uid}", {
                    "clicked":    {"booleanValue": False},
                    "clickedAt":  {"nullValue": None},
                    "remindedAt": {"nullValue": None},
                    "createdAt":  {"stringValue": now_iso},
                })
            except Exception as e:
                print(f"  ⚠ Không tạo user doc {s.get('uid')}: {e}")

        sent_count += 1

    print(f"\n🎉 Xong! Đã thông báo {sent_count} session mới.")


if __name__ == "__main__":
    main()
