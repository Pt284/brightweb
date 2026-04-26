"""
sync_drive.py — BrightWeb
Đọc cấu trúc Google Drive + tất cả video YouTube channel → xuất data.json
"""

import os, re, json, time, unicodedata
from datetime import datetime, timezone
from google.oauth2 import service_account
from googleapiclient.discovery import build
import requests

# ============================================================
# ⚙ CONFIG
# ============================================================
DRIVE_ROOT_FOLDER_ID    = os.environ.get("DRIVE_ROOT_FOLDER_ID", "")
YOUTUBE_API_KEY         = os.environ.get("YOUTUBE_API_KEY", "")
YOUTUBE_OAUTH_JSON      = os.environ.get("YOUTUBE_OAUTH_JSON", "")
YOUTUBE_CHANNEL_ID      = os.environ.get("YOUTUBE_CHANNEL_ID", "")
GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON", "")
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"

SCOPES           = ["https://www.googleapis.com/auth/drive.readonly"]
FIRESTORE_SCOPES = ["https://www.googleapis.com/auth/datastore"]
OUTPUT_FILE      = "data.json"
FIRESTORE_PROJECT_ID = os.environ.get("FIRESTORE_PROJECT_ID", "")

# ============================================================
# HELPERS
# ============================================================

def slugify(text: str) -> str:
    text = unicodedata.normalize("NFD", text)
    text = text.encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)

def extract_numeric_prefix(name: str):
    """'01 ~ Tên bài' → (1, 'Tên bài')"""
    m = re.match(r"^(\d+)\s*~\s*(.*)", name)
    if m:
        return int(m.group(1)), m.group(2).strip() or name
    return None, name

def extract_video_prefix(title: str):
    """
    Nhận diện prefix số ở đầu tên video, hỗ trợ cả ~ và -
    '020101 ~ Tên video' → '020101'
    '020101 - Tên video' → '020101'
    '020101-Tên video'   → '020101'
    """
    m = re.match(r"^(\d{6,10})\s*[~\-–]", title)
    return m.group(1) if m else None

def sort_key(name: str):
    num, _ = extract_numeric_prefix(name)
    return (0, num) if num is not None else (1, name.lower())

def retry(fn, retries=4, backoff=2):
    for attempt in range(retries):
        try:
            return fn()
        except Exception as e:
            if attempt == retries - 1:
                raise
            wait = backoff ** attempt
            print(f"  ⚠ Lỗi: {e}. Thử lại sau {wait}s...")
            time.sleep(wait)

# ============================================================
# BƯỚC 1: ĐỌC GOOGLE DRIVE
# ============================================================

def build_drive_service():
    if not GOOGLE_CREDENTIALS_JSON:
        raise ValueError("❌ Thiếu GOOGLE_CREDENTIALS_JSON.")
    creds_info = json.loads(GOOGLE_CREDENTIALS_JSON)
    creds = service_account.Credentials.from_service_account_info(
        creds_info, scopes=SCOPES
    )
    return build("drive", "v3", credentials=creds)

def fetch_all_items(service):
    all_items, children_map = {}, {}
    page_token = None

    try:
        root_info = service.files().get(fileId=DRIVE_ROOT_FOLDER_ID, fields="id, name").execute()
        print(f"  🔍 Folder gốc: '{root_info.get('name')}'")
    except Exception as e:
        print(f"  ❌ LỖI TRUY CẬP FOLDER GỐC: {e}")
        print("     -> Hãy kiểm tra DRIVE_ROOT_FOLDER_ID và quyền Share cho Service Account.")
        return {}, {}

    print("  Đang tải cấu trúc Drive...")
    while True:
        # FIX: capture page_token by value để tránh closure bug
        def call(pt=page_token):
            return service.files().list(
                q="trashed=false",
                fields="nextPageToken, files(id, name, mimeType, parents)",
                pageSize=1000,
                pageToken=pt
            ).execute()

        res = retry(call)
        files = res.get("files", [])

        if not all_items and files:
            if DEBUG:
                sample_names = [f['name'] for f in files[:5]]
                print(f"  📂 Service Account thấy {len(files)} file đầu tiên, ví dụ: {sample_names}")

        for item in files:
            all_items[item["id"]] = item
            for parent in item.get("parents", []):
                children_map.setdefault(parent, []).append(item)

        page_token = res.get("nextPageToken")
        if not page_token:
            break

    print(f"  → Tổng số items quét được: {len(all_items)}")
    return all_items, children_map

def build_drive_tree_fast(folder_id, children_map):
    children = children_map.get(folder_id, [])
    folders = sorted(
        [c for c in children if c["mimeType"] == "application/vnd.google-apps.folder"],
        key=lambda c: sort_key(c["name"])
    )
    nodes = []
    for f in folders:
        num, clean_title = extract_numeric_prefix(f["name"])
        sub_folders = [
            c for c in children_map.get(f["id"], [])
            if c["mimeType"] == "application/vnd.google-apps.folder"
        ]
        if not sub_folders:
            docs = []
            for pdf in children_map.get(f["id"], []):
                if pdf["name"] == ".keep":
                    continue
                if pdf["mimeType"] == "application/pdf" or pdf["name"].lower().endswith(".pdf"):
                    docs.append({
                        "title": pdf["name"].removesuffix(".pdf").removesuffix(".PDF"),
                        "url": f"https://drive.google.com/file/d/{pdf['id']}/view"
                    })
            nodes.append({
                "_order": num, "_raw_name": f["name"],
                "title": clean_title, "type": "lesson",
                "driveId": f["id"], "youtubeId": None, "documents": docs
            })
        else:
            nodes.append({
                "_order": num, "_raw_name": f["name"],
                "title": clean_title, "type": "chapter",
                "children": build_drive_tree_fast(f["id"], children_map)
            })
    return nodes

def read_drive(service):
    all_items, children_map = fetch_all_items(service)

    immediate_children = children_map.get(DRIVE_ROOT_FOLDER_ID, [])

    if DEBUG:
        child_names = [c['name'] for c in immediate_children]
        print(f"  📝 Mục con trực tiếp của folder gốc: {child_names}")

    top_folders = sorted(
        [c for c in immediate_children
         if c["mimeType"] == "application/vnd.google-apps.folder"],
        key=lambda c: sort_key(c["name"])
    )

    courses = []
    for f in top_folders:
        num, clean_title = extract_numeric_prefix(f["name"])
        if num is None:
            if DEBUG:
                print(f"  ⚠️ Folder không khớp format: '{f['name']}'")
            continue
        courses.append({
            "order": num, "title": clean_title,
            "driveId": f["id"],
            "tree": build_drive_tree_fast(f["id"], children_map)
        })

    print(f"✓ Đã đọc {len(courses)} khóa từ Drive")
    return courses

# ============================================================
# BƯỚC 2: ĐỌC YOUTUBE
# ============================================================

def build_youtube_service():
    """
    Dùng OAuth2 nếu có YOUTUBE_OAUTH_JSON (để đọc Unlisted).
    Fallback về API key nếu không có OAuth.
    """
    if YOUTUBE_OAUTH_JSON:
        from google.oauth2.credentials import Credentials
        info = json.loads(YOUTUBE_OAUTH_JSON)
        creds = Credentials(
            token         = info["token"],
            refresh_token = info["refresh_token"],
            token_uri     = info["token_uri"],
            client_id     = info["client_id"],
            client_secret = info["client_secret"],
            scopes        = ["https://www.googleapis.com/auth/youtube.readonly"]
        )
        print("  ✓ Dùng OAuth2 (đọc được Unlisted + Private)")
        return build("youtube", "v3", credentials=creds)
    print("  ℹ Dùng API Key (chỉ đọc Public)")
    return None  # fallback về requests + API key

def fetch_playlist_items(playlist_id: str) -> list:
    """Lấy tất cả video trong 1 playlist. Ưu tiên OAuth2, fallback API key."""
    if not YOUTUBE_API_KEY and not YOUTUBE_OAUTH_JSON:
        raise ValueError("❌ Thiếu YOUTUBE_API_KEY hoặc YOUTUBE_OAUTH_JSON.")

    yt_service = build_youtube_service()
    videos, page_token = [], None

    while True:
        if yt_service:
            # FIX: capture page_token by value để tránh closure bug
            def call(pt=page_token):
                return yt_service.playlistItems().list(
                    part="snippet", playlistId=playlist_id,
                    maxResults=50, pageToken=pt or ""
                ).execute()
            try:
                data = retry(call)
            except Exception as e:
                print(f"  ⚠ OAuth2 lỗi: {e}")
                return []
        else:
            params = {
                "part": "snippet", "playlistId": playlist_id,
                "maxResults": 50, "key": YOUTUBE_API_KEY,
            }
            if page_token:
                params["pageToken"] = page_token
            r = retry(lambda: requests.get(
                "https://www.googleapis.com/youtube/v3/playlistItems",
                params=params, timeout=15
            ))
            if r.status_code == 404:
                print(f"  ⚠ Playlist {playlist_id} không tồn tại, bỏ qua.")
                return []
            if r.status_code != 200:
                print(f"  ⚠ Lỗi {r.status_code}: {r.text[:200]}")
                return []
            data = r.json()

        total = data.get("pageInfo", {}).get("totalResults", "?")
        if not videos:
            print(f"    totalResults={total}")

        for item in data.get("items", []):
            sn = item["snippet"]
            title    = sn.get("title", "")
            video_id = sn.get("resourceId", {}).get("videoId", "")
            prefix   = extract_video_prefix(title)
            if video_id and prefix:
                videos.append({"videoId": video_id, "title": title, "prefix": prefix})
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return videos

def get_uploads_playlist_id() -> str | None:
    """Lấy uploads playlist ẩn của channel (chứa tất cả video đã upload)."""
    if not YOUTUBE_CHANNEL_ID:
        return None
    r = retry(lambda: requests.get(
        "https://www.googleapis.com/youtube/v3/channels",
        params={"part": "contentDetails", "id": YOUTUBE_CHANNEL_ID, "key": YOUTUBE_API_KEY},
        timeout=15
    ))
    r.raise_for_status()
    items = r.json().get("items", [])
    if not items:
        print(f"  ⚠ Không tìm thấy channel {YOUTUBE_CHANNEL_ID}")
        return None
    return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

def read_youtube() -> dict:
    merged = {}

    # ── Nguồn 1: Toàn bộ channel ──
    uploads_id = get_uploads_playlist_id()
    if uploads_id:
        print(f"  Đọc tất cả video từ channel...")
        channel_videos = fetch_playlist_items(uploads_id)

        if DEBUG and channel_videos:
            print(f"  Ví dụ tên video đầu tiên:")
            for v in channel_videos[:5]:
                print(f"    [{v.get('title', '?')[:60]}]")

        matched = [v for v in channel_videos if v.get("prefix")]
        for v in matched:
            merged[v["prefix"]] = v["videoId"]
        print(f"  → {len(matched)}/{len(channel_videos)} video có prefix hợp lệ")
    else:
        print("  ℹ Không có YOUTUBE_CHANNEL_ID — bỏ qua đọc channel")

    print(f"✓ Tổng {len(merged)} video sau khi merge")

    # Phân loại theo course_order (2 chữ số đầu của prefix)
    playlist_map = {}
    for prefix, video_id in merged.items():
        try:
            course_order = int(prefix[:2])
            playlist_map.setdefault(course_order, {})[prefix] = video_id
        except (ValueError, IndexError):
            continue
    return playlist_map

# ============================================================
# BƯỚC 3: GHÉP VIDEO VÀO CÂY
# ============================================================

def assign_videos(nodes, playlist_map, course_order, index_path=None):
    if index_path is None:
        index_path = []
    matched = unmatched = 0
    videos = playlist_map.get(course_order, {})
    for i, node in enumerate(nodes):
        order = node.get("_order") or (i + 1)
        current_path = index_path + [order]
        if node["type"] == "lesson":
            parts  = [course_order] + current_path
            prefix = "".join(f"{p:02d}" for p in parts)
            node["_prefix"] = prefix  # Lưu lại prefix gốc để web lấy
            video_id = videos.get(prefix)
            if video_id:
                node["youtubeId"] = video_id
                matched += 1
            else:
                node["youtubeId"] = None
                unmatched += 1
                node["_missing_prefix"] = prefix
        else:
            m, u = assign_videos(
                node.get("children", []), playlist_map, course_order, current_path
            )
            matched += m; unmatched += u
    return matched, unmatched

# ============================================================
# BƯỚC 4: XUẤT SCHEMA
# ============================================================

def node_to_schema(node, course_id, id_prefix):
    title    = node["title"]
    order    = node.get("_order", 0)
    node_slug = f"{id_prefix}-{order:02d}"
    if node["type"] == "lesson":
        return {
            "id": node_slug, "title": title, "order": order,
            "type": "lesson",
            "prefix": node.get("_prefix", ""),
            "youtubeId": node.get("youtubeId") or "",
            "documents": node.get("documents", [])
        }
    return {
        "id": node_slug, "title": title, "order": order,
        "type": "chapter",
        "children": [node_to_schema(c, course_id, node_slug) for c in node.get("children", [])]
    }

def build_output(courses, playlist_map):
    output_courses = []
    total_matched = total_unmatched = 0
    missing = []

    for course in courses:
        order = course["order"]
        matched, unmatched = assign_videos(course["tree"], playlist_map, order, [])
        total_matched   += matched
        total_unmatched += unmatched

        def collect_missing(nodes):
            for n in nodes:
                if n["type"] == "lesson" and "_missing_prefix" in n:
                    missing.append(n["_missing_prefix"])
                elif n["type"] == "chapter":
                    collect_missing(n.get("children", []))
        collect_missing(course["tree"])

        course_id   = f"{order:02d}-{slugify(course['title'])}"
        tree_schema = [node_to_schema(n, course_id, course_id) for n in course["tree"]]
        output_courses.append({
            "id": course_id, "title": course["title"],
            "order": order, "tree": tree_schema
        })

    total = total_matched + total_unmatched
    print(f"✓ Ghép được {total_matched}/{total} bài có video")
    if missing:
        print(f"✗ {len(missing)} bài chưa có video (prefix): {', '.join(missing)}")

    # Gộp toàn bộ list YouTube ID đã upload
    all_yt_prefixes = []
    for c_order, p_map in playlist_map.items():
        all_yt_prefixes.extend(list(p_map.keys()))

    return {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "youtubeIds": all_yt_prefixes,
        "courses": output_courses
    }

# ============================================================
# FIRESTORE
# ============================================================

def push_to_firestore(data: dict):
    import google.auth.transport.requests
    creds_info = json.loads(GOOGLE_CREDENTIALS_JSON)
    creds = service_account.Credentials.from_service_account_info(
        creds_info, scopes=FIRESTORE_SCOPES
    )
    creds.refresh(google.auth.transport.requests.Request())
    project = FIRESTORE_PROJECT_ID or creds_info.get("project_id", "")
    url = (
        f"https://firestore.googleapis.com/v1/projects/{project}"
        f"/databases/(default)/documents/app_data/courses"
    )
    payload = {
        "fields": {
            "json":      {"stringValue": json.dumps(data, ensure_ascii=False)},
            "updatedAt": {"stringValue": data["lastUpdated"]}
        }
    }
    r = requests.patch(
        url, json=payload,
        headers={"Authorization": f"Bearer {creds.token}"},
        timeout=30
    )
    if r.status_code in (200, 201):
        print("✓ Đã push data lên Firestore")
    else:
        print(f"✗ Firestore push thất bại: {r.status_code} — {r.text[:200]}")

# ============================================================
# MAIN
# ============================================================

def main():
    if not DRIVE_ROOT_FOLDER_ID:
        raise ValueError("❌ Thiếu DRIVE_ROOT_FOLDER_ID.")

    print("▶ Khởi tạo Drive service...")
    service = build_drive_service()

    print("▶ Đọc cấu trúc Drive...")
    courses = read_drive(service)

    print("▶ Đọc YouTube...")
    playlist_map = read_youtube()

    print("▶ Ghép video + xuất data.json...")
    output = build_output(courses, playlist_map)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"→ Xuất {OUTPUT_FILE} ({os.path.getsize(OUTPUT_FILE)//1024} KB) ✓")

    push_to_firestore(output)

if __name__ == "__main__":
    main()
