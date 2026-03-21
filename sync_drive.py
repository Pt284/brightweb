"""
sync_drive.py — BrightWeb
Đọc cấu trúc Google Drive + YouTube playlists → xuất data.json
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
GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON", "")
YOUTUBE_CHANNEL_ID      = os.environ.get("YOUTUBE_CHANNEL_ID", "")  # ID kênh YouTube của bạn

# Playlist fallback cho các video đã upload vào playlist trước đây
# Không cần điền đủ — bỏ trống playlist nào không dùng nữa
COURSE_PLAYLISTS = {
    int(k): v
    for k, v in json.loads(
        os.environ.get("COURSE_PLAYLISTS_JSON", "{}")
    ).items()
}

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
FIRESTORE_SCOPES = ["https://www.googleapis.com/auth/datastore"]
OUTPUT_FILE = "data.json"
FIRESTORE_PROJECT_ID = os.environ.get("FIRESTORE_PROJECT_ID", "")

# ============================================================
# HELPERS
# ============================================================

def slugify(text: str) -> str:
    """Chuyển tiêu đề thành slug dùng làm id."""
    text = unicodedata.normalize("NFD", text)
    text = text.encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)

def extract_numeric_prefix(name: str):
    """
    Trả về (int, str) — số prefix tự nhiên và phần còn lại.
    '01 - Tên bài' → (1, 'Tên bài')
    'Tháng 2'      → (None, 'Tháng 2')
    """
    m = re.match(r"^(\d+)\s*~\s*(.*)", name)
    if m:
        return int(m.group(1)), m.group(2).strip() or name
    return None, name

def extract_video_prefix(title: str):
    """
    Lấy phần prefix số từ tên video YouTube.
    '020101 - Tính đơn điệu...' → '020101'
    """
    m = re.match(r"^(\d{6,10})\s*~", title)
    return m.group(1) if m else None

def parse_prefix_parts(prefix: str):
    """
    '020101' → [2, 1, 1]
    '02010101' → [2, 1, 1, 1]
    """
    return [int(prefix[i:i+2]) for i in range(0, len(prefix), 2)]

def sort_key(name: str):
    num, _ = extract_numeric_prefix(name)
    return (0, num) if num is not None else (1, name.lower())

def retry(fn, retries=4, backoff=2):
    """Gọi fn với exponential backoff khi gặp lỗi."""
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
        raise ValueError(
            "❌ Thiếu GOOGLE_CREDENTIALS_JSON.\n"
            "   Hãy export biến môi trường hoặc thêm vào GitHub Secrets."
        )
    creds_info = json.loads(GOOGLE_CREDENTIALS_JSON)
    creds = service_account.Credentials.from_service_account_info(
        creds_info, scopes=SCOPES
    )
    return build("drive", "v3", credentials=creds)

def fetch_all_items(service):
    """
    1 lần duy nhất: lấy TẤT CẢ file/folder trong toàn bộ Drive.
    Trả về dict {parent_id: [children]} và dict {id: item}.
    """
    all_items = {}
    children_map = {}  # parent_id → list of items
    page_token = None

    print("  Đang tải toàn bộ cấu trúc Drive (1 lần)...")
    while True:
        def call():
            return service.files().list(
                q="trashed=false",
                fields="nextPageToken, files(id, name, mimeType, parents)",
                pageSize=1000,
                pageToken=page_token
            ).execute()
        res = retry(call)
        for item in res.get("files", []):
            all_items[item["id"]] = item
            for parent in item.get("parents", []):
                children_map.setdefault(parent, []).append(item)
        page_token = res.get("nextPageToken")
        if not page_token:
            break

    print(f"  → Tải xong {len(all_items)} items")
    return all_items, children_map

def build_drive_tree_fast(folder_id, children_map):
    """Xây cây từ children_map trong memory — không gọi API thêm."""
    children = children_map.get(folder_id, [])
    folders = sorted(
        [c for c in children if c["mimeType"] == "application/vnd.google-apps.folder"],
        key=lambda c: sort_key(c["name"])
    )
    pdfs_here = [
        c for c in children
        if c["mimeType"] == "application/pdf" or c["name"].lower().endswith(".pdf")
    ]

    nodes = []
    for f in folders:
        num, clean_title = extract_numeric_prefix(f["name"])
        sub_folders = [
            c for c in children_map.get(f["id"], [])
            if c["mimeType"] == "application/vnd.google-apps.folder"
        ]
        if not sub_folders:
            # Lesson — folder lá
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
                "_order": num,
                "_raw_name": f["name"],
                "title": clean_title,
                "type": "lesson",
                "driveId": f["id"],
                "youtubeId": None,
                "documents": docs
            })
        else:
            # Chapter
            nodes.append({
                "_order": num,
                "_raw_name": f["name"],
                "title": clean_title,
                "type": "chapter",
                "children": build_drive_tree_fast(f["id"], children_map)
            })
    return nodes

def read_drive(service):
    """Đọc toàn bộ Drive bằng 1 API call, build cây trong memory."""
    all_items, children_map = fetch_all_items(service)

    top_folders = sorted(
        [c for c in children_map.get(DRIVE_ROOT_FOLDER_ID, [])
         if c["mimeType"] == "application/vnd.google-apps.folder"],
        key=lambda c: sort_key(c["name"])
    )

    courses = []
    for f in top_folders:
        num, clean_title = extract_numeric_prefix(f["name"])
        if num is None:
            continue
        tree = build_drive_tree_fast(f["id"], children_map)
        courses.append({
            "order": num,
            "title": clean_title,
            "driveId": f["id"],
            "tree": tree
        })
    print(f"✓ Đã đọc {len(courses)} khóa từ Drive")
    return courses

# ============================================================
# BƯỚC 2: ĐỌC YOUTUBE PLAYLISTS
# ============================================================

def get_channel_uploads_playlist_id():
    """Lấy uploads playlist ID ẩn của channel (chứa tất cả video đã upload)."""
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

def fetch_all_channel_videos():
    """
    Lấy TẤT CẢ video trên kênh qua uploads playlist ẩn.
    Trả về dict {prefix: videoId} cho tất cả video có prefix hợp lệ.
    """
    if not YOUTUBE_CHANNEL_ID:
        print("  ℹ Không có YOUTUBE_CHANNEL_ID — bỏ qua đọc channel")
        return {}

    uploads_id = get_channel_uploads_playlist_id()
    if not uploads_id:
        return {}

    print(f"  Đọc tất cả video từ channel (uploads playlist: {uploads_id})...")
    videos = fetch_playlist(0, uploads_id)  # course_order=0 chỉ để gọi hàm
    result = {v["prefix"]: v["videoId"] for v in videos}
    print(f"  → Tìm thấy {len(result)} video có prefix hợp lệ trên channel")
    return result

def read_youtube(course_orders):
    """
    Đọc video từ 2 nguồn rồi merge:
    1. Tất cả video trên channel (nguồn chính)
    2. Playlist cũ (fallback — video đã upload trước)
    Playlist thắng nếu trùng prefix (để ưu tiên assignment thủ công).
    Trả về dict {course_order: {prefix: videoId}}
    """
    # Bước 1: Đọc toàn bộ channel
    channel_videos = fetch_all_channel_videos()

    # Bước 2: Đọc playlist fallback
    playlist_videos = {}  # {prefix: videoId}
    for order in course_orders:
        pid = COURSE_PLAYLISTS.get(order)
        if not pid or pid.startswith("PLAYLIST_ID"):
            continue
        videos = fetch_playlist(order, pid)
        for v in videos:
            playlist_videos[v["prefix"]] = v["videoId"]

    # Bước 3: Merge — channel trước, playlist ghi đè nếu trùng
    merged = {**channel_videos, **playlist_videos}
    print(f"✓ Đã đọc {len(merged)} video tổng ({len(channel_videos)} từ channel, {len(playlist_videos)} từ playlist)")

    # Bước 4: Phân loại video theo course_order (2 chữ số đầu của prefix)
    playlist_map = {}
    for prefix, video_id in merged.items():
        try:
            course_order = int(prefix[:2])
            playlist_map.setdefault(course_order, {})[prefix] = video_id
        except (ValueError, IndexError):
            continue

    return playlist_map
    """Lấy toàn bộ video trong playlist, trả về list {videoId, title, prefix}."""
    if not YOUTUBE_API_KEY:
        raise ValueError("❌ Thiếu YOUTUBE_API_KEY.")

    videos, page_token = [], None
    while True:
        params = {
            "part": "snippet",
            "playlistId": playlist_id,
            "maxResults": 50,
            "key": YOUTUBE_API_KEY,
        }
        if page_token:
            params["pageToken"] = page_token

        def call():
            return requests.get(
                "https://www.googleapis.com/youtube/v3/playlistItems",
                params=params, timeout=15
            )
        r = retry(call)
        if r.status_code == 404:
            print(f"  ⚠ Playlist {playlist_id} không tồn tại, bỏ qua.")
            return []
        r.raise_for_status()
        data = r.json()

        for item in data.get("items", []):
            sn = item["snippet"]
            title = sn.get("title", "")
            video_id = sn.get("resourceId", {}).get("videoId", "")
            prefix = extract_video_prefix(title)
            if video_id and prefix:
                videos.append({"videoId": video_id, "title": title, "prefix": prefix})

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return videos

def read_youtube(course_orders):
    """Đọc tất cả playlist đã config. Trả về dict {course_order: [videos]}."""
    playlist_map = {}
    total = 0
    for order in course_orders:
        pid = COURSE_PLAYLISTS.get(order)
        if not pid or pid.startswith("PLAYLIST_ID"):
            continue
        videos = fetch_playlist(order, pid)
        playlist_map[order] = {v["prefix"]: v["videoId"] for v in videos}
        total += len(videos)
    print(f"✓ Đã đọc {total} video từ YouTube ({len(playlist_map)} playlist)")
    return playlist_map

# ============================================================
# BƯỚC 3: GHÉP VIDEO VÀO CÂY
# ============================================================

def assign_videos(nodes, playlist_map, course_order, index_path=[]):
    """
    Duyệt đệ quy cây Drive, gán youtubeId dựa vào prefix.
    index_path: list số thứ tự tính từ cấp đầu tiên trong khóa.
    """
    matched = unmatched = 0
    videos = playlist_map.get(course_order, {})

    for i, node in enumerate(nodes):
        order = node.get("_order") or (i + 1)
        current_path = index_path + [order]

        if node["type"] == "lesson":
            # Tạo prefix: [course_order] + current_path, mỗi số pad 2 chữ số
            parts = [course_order] + current_path
            prefix = "".join(f"{p:02d}" for p in parts)
            video_id = videos.get(prefix)
            if video_id:
                node["youtubeId"] = video_id
                matched += 1
            else:
                node["youtubeId"] = None
                unmatched += 1
                node["_missing_prefix"] = prefix  # dùng để log
        else:
            m, u = assign_videos(
                node.get("children", []), playlist_map, course_order, current_path
            )
            matched += m
            unmatched += u

    return matched, unmatched

# ============================================================
# BƯỚC 4: CHUYỂN SANG SCHEMA data.json
# ============================================================

def node_to_schema(node, course_id, id_prefix):
    """Chuyển node nội bộ → schema chuẩn của data.json."""
    title = node["title"]
    order = node.get("_order", 0)
    node_slug = f"{id_prefix}-{order:02d}"

    if node["type"] == "lesson":
        return {
            "id": node_slug,
            "title": title,
            "order": order,
            "type": "lesson",
            "youtubeId": node.get("youtubeId") or "",
            "documents": node.get("documents", [])
        }
    else:
        children = [
            node_to_schema(c, course_id, node_slug)
            for c in node.get("children", [])
        ]
        return {
            "id": node_slug,
            "title": title,
            "order": order,
            "type": "chapter",
            "children": children
        }

def build_output(courses, playlist_map):
    """Xây output data.json cuối cùng."""
    output_courses = []
    total_matched = total_unmatched = 0
    missing = []

    for course in courses:
        order = course["order"]
        matched, unmatched = assign_videos(
            course["tree"], playlist_map, order, index_path=[]
        )
        total_matched += matched
        total_unmatched += unmatched

        # Collect missing prefixes for logging
        def collect_missing(nodes):
            for n in nodes:
                if n["type"] == "lesson" and "_missing_prefix" in n:
                    missing.append(n["_missing_prefix"])
                elif n["type"] == "chapter":
                    collect_missing(n.get("children", []))
        collect_missing(course["tree"])

        course_id = f"{order:02d}-{slugify(course['title'])}"
        tree_schema = [
            node_to_schema(node, course_id, course_id)
            for node in course["tree"]
        ]
        output_courses.append({
            "id": course_id,
            "title": course["title"],
            "order": order,
            "tree": tree_schema
        })

    # Log
    total = total_matched + total_unmatched
    print(f"✓ Ghép được {total_matched}/{total} bài có video")
    if missing:
        print(f"✗ {len(missing)} bài chưa có video (prefix): {', '.join(missing)}")

    return {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "courses": output_courses
    }

# ============================================================
# MAIN
# ============================================================

def push_to_firestore(data: dict):
    """Push data.json lên Firestore collection 'app_data', doc 'courses'."""
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

    # Firestore REST API — lưu toàn bộ data dưới dạng 1 string JSON
    payload = {
        "fields": {
            "json": {"stringValue": json.dumps(data, ensure_ascii=False)},
            "updatedAt": {"stringValue": data["lastUpdated"]}
        }
    }
    r = requests.patch(
        url,
        json=payload,
        headers={"Authorization": f"Bearer {creds.token}"},
        timeout=30
    )
    if r.status_code in (200, 201):
        print("✓ Đã push data lên Firestore")
    else:
        print(f"✗ Firestore push thất bại: {r.status_code} — {r.text[:200]}")


def main():
    # Kiểm tra biến môi trường cơ bản
    if not DRIVE_ROOT_FOLDER_ID:
        raise ValueError("❌ Thiếu DRIVE_ROOT_FOLDER_ID.")

    print("▶ Khởi tạo Drive service...")
    service = build_drive_service()

    print("▶ Đọc cấu trúc Drive...")
    courses = read_drive(service)

    course_orders = [c["order"] for c in courses]
    print("▶ Đọc YouTube playlists...")
    playlist_map = read_youtube(course_orders)

    print("▶ Ghép video + xuất data.json...")
    output = build_output(courses, playlist_map)

    # Xuất local (để debug)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(OUTPUT_FILE) // 1024
    print(f"→ Xuất {OUTPUT_FILE} ({size_kb} KB) ✓")

    # Push lên Firestore
    push_to_firestore(output)

if __name__ == "__main__":
    main()
