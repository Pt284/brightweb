import os, re, json, time, unicodedata
from datetime import datetime, timezone
from google.oauth2 import service_account
from googleapiclient.discovery import build
import requests
DRIVE_ROOT_FOLDER_ID   = os.environ.get("DRIVE_ROOT_FOLDER_ID", "")
YOUTUBE_API_KEY        = os.environ.get("YOUTUBE_API_KEY", "")
GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON", "")
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
def slugify(text: str) -> str:
    text = unicodedata.normalize("NFD", text)
    text = text.encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)
def extract_numeric_prefix(name: str):
    m = re.match(r"^(\d+)\s*~\s*(.*)", name)
    if m:
        return int(m.group(1)), m.group(2).strip() or name
    return None, name
def extract_video_prefix(title: str):
    m = re.match(r"^(\d{6,10})\s*~", title)
    return m.group(1) if m else None
def parse_prefix_parts(prefix: str):
    return [int(prefix[i:i+2]) for i in range(0, len(prefix), 2)]
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
    all_items = {}
    children_map = {}  
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
            nodes.append({
                "_order": num,
                "_raw_name": f["name"],
                "title": clean_title,
                "type": "chapter",
                "children": build_drive_tree_fast(f["id"], children_map)
            })
    return nodes
def read_drive(service):
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
def fetch_playlist(course_order: int, playlist_id: str):
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
def assign_videos(nodes, playlist_map, course_order, index_path=[]):
    matched = unmatched = 0
    videos = playlist_map.get(course_order, {})
    for i, node in enumerate(nodes):
        order = node.get("_order") or (i + 1)
        current_path = index_path + [order]
        if node["type"] == "lesson":
            parts = [course_order] + current_path
            prefix = "".join(f"{p:02d}" for p in parts)
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
            matched += m
            unmatched += u
    return matched, unmatched
def node_to_schema(node, course_id, id_prefix):
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
    total = total_matched + total_unmatched
    print(f"✓ Ghép được {total_matched}/{total} bài có video")
    if missing:
        print(f"✗ {len(missing)} bài chưa có video (prefix): {', '.join(missing)}")
    return {
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "courses": output_courses
    }
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
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(OUTPUT_FILE) // 1024
    print(f"→ Xuất {OUTPUT_FILE} ({size_kb} KB) ✓")
    push_to_firestore(output)
if __name__ == "__main__":
    main()
