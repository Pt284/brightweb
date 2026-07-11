"""
test_local.py — Chạy thử LOCAL trước khi deploy lên GitHub Actions.

Tạo file .env.test trong cùng thư mục với nội dung:
    HM_USERNAME=0383915621
    HM_PASSWORD=matkhaucuaban
    HM_BASE_URL=https://hocmai.vn

Chạy:
    python test_local.py            # test lophoc_api (lấy calendar + live-status + m3u8)
    python test_local.py --watch    # test watch mode (đọc schedule.json + thử live)
    python test_local.py --full     # test full crawl qua Playwright
"""
import os, sys, json
from pathlib import Path
from datetime import datetime, timezone, timedelta

# ── Load .env.test ──────────────────────────────────────────────────────────
env_file = Path(__file__).parent / ".env.test"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())
else:
    print("⚠ Không tìm thấy .env.test — tạo file với HM_USERNAME, HM_PASSWORD, HM_BASE_URL")

HM_USERNAME = os.environ.get("HM_USERNAME", "")
HM_PASSWORD = os.environ.get("HM_PASSWORD", "")
HM_BASE_URL = os.environ.get("HM_BASE_URL", "")

if not all([HM_USERNAME, HM_PASSWORD, HM_BASE_URL]):
    print("❌ Thiếu HM_USERNAME / HM_PASSWORD / HM_BASE_URL trong .env.test")
    sys.exit(1)


def sep(title):
    print(f"\n{'='*60}\n  {title}\n{'='*60}")


def test_lophoc_api():
    sep("TEST: lophoc_api — login + calendar + live-status")
    from lophoc_api import LophocClient, get_live_status

    client = LophocClient(HM_USERNAME, HM_PASSWORD)
    client.ensure_logged_in()
    print("✓ Đăng nhập lophoc thành công")

    lessons = client.get_calendar()
    print(f"✓ Calendar: {len(lessons)} buổi học sắp tới")
    for l in lessons:
        print(f"  [{l.get('start_time','?')[:16]}] {l.get('subject','?')} — {l.get('lesson_name','?')} "
              f"(code={l.get('code','?')}, learn_number={l.get('learn_number','?')})")

    if not lessons:
        print("  ⚠ Không có buổi nào — kiểm tra account đã enroll đúng lớp chưa")
        return

    codes = list({l["code"] for l in lessons if l.get("code")})
    live_status = get_live_status(client.session, codes)
    print(f"\n✓ Live-status: {live_status}")

    live_codes = [c for c, v in live_status.items() if v]
    if live_codes:
        print(f"🔴 Đang live: {live_codes}")
        lesson = next(l for l in lessons if l.get("code") == live_codes[0])
        m3u8 = client.get_m3u8(lesson["code"], lesson["learn_number"])
        print(f"✓ m3u8: {m3u8}")
    else:
        print("  ℹ Không có stream live lúc này (bình thường nếu chưa đến giờ học)")
        print("  → Test gọi m3u8 endpoint bất kể live-status...")
        lesson = lessons[0]
        try:
            m3u8 = client.get_m3u8(lesson["code"], lesson["learn_number"])
            print(f"  API trả: {m3u8} (404 từ CDN là bình thường khi chưa live)")
        except Exception as e:
            print(f"  ⚠ {e}")


def test_watch_mode():
    sep("TEST: watch mode — cần schedule.json (chạy --full trước)")
    schedule_file = Path(__file__).parent / "schedule.json"
    if not schedule_file.exists():
        print("❌ Không có schedule.json. Chạy: python test_local.py --full")
        return

    data = json.loads(schedule_file.read_text(encoding="utf-8-sig"))
    print(f"✓ schedule.json: {len(data.get('events', []))} events")

    import crawl_calendar as cc
    original_load = cc.load_existing_schedule
    cc.load_existing_schedule = lambda: data
    cc.GOOGLE_CREDENTIALS_JSON = ""

    try:
        cc._run_watch_mode()
    finally:
        cc.load_existing_schedule = original_load

    watch_file = Path(__file__).parent / "schedule_watch.json"
    if watch_file.exists():
        result = json.loads(watch_file.read_text(encoding="utf-8"))
        live_events = [e for e in result.get("events", []) if e.get("m3u8")]
        print(f"\n✓ schedule_watch.json: {len(live_events)} events có m3u8")


def test_full_crawl():
    sep("TEST: full crawl qua Playwright (30-60s, mở browser)")
    os.environ.update({"CRAWL_MODE": "full", "MONTHS_TO_CRAWL": "2",
                       "HEADLESS": "false"})
    import crawl_calendar as cc
    cc.CRAWL_MODE = "full"
    cc.MONTHS_TO_CRAWL = 2
    cc.HEADLESS = False
    cc.GOOGLE_CREDENTIALS_JSON = ""
    cc.main()
    sf = Path(__file__).parent / "schedule.json"
    if sf.exists():
        d = json.loads(sf.read_text(encoding="utf-8"))
        print(f"\n✓ schedule.json: {len(d.get('events',[]))} events")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--api"
    if mode == "--full":
        test_full_crawl()
    elif mode == "--watch":
        test_watch_mode()
    else:
        test_lophoc_api()
    print("\n✅ Done.")
