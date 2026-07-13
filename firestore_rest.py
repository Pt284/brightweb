"""
firestore_rest.py — Helper Firestore REST API dùng chung cho nhiều script.
Tái sử dụng logic từ crawl_calendar.py, bổ sung thêm:
  - list_active_subscriptions()  — GET toàn bộ push_subscriptions active=true
  - list_subcollection()         — GET documents trong sub-collection
  - delete_doc()                 — DELETE một document
  - firestore_now_iso()          — helper trả ISO-8601 UTC hiện tại
"""

import os
import json
from datetime import datetime, timezone

GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON", "")
FIRESTORE_PROJECT_ID    = os.environ.get("FIRESTORE_PROJECT_ID", "")


# ── TOKEN ─────────────────────────────────────────────────────────────────────
def _get_firestore_token():
    import google.auth.transport.requests
    from google.oauth2 import service_account

    creds_info = json.loads(GOOGLE_CREDENTIALS_JSON)
    creds = service_account.Credentials.from_service_account_info(
        creds_info, scopes=["https://www.googleapis.com/auth/datastore"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    project = FIRESTORE_PROJECT_ID or creds_info.get("project_id", "")
    return creds.token, project


def _fs_url(project: str, doc_path: str) -> str:
    return (
        f"https://firestore.googleapis.com/v1/projects/{project}"
        f"/databases/(default)/documents/{doc_path}"
    )


# ── CRUD CƠ BẢN ───────────────────────────────────────────────────────────────
def read_fs(doc_path: str) -> dict | None:
    """Đọc một document. Trả về dict fields hoặc None nếu không tồn tại."""
    import requests as req
    token, project = _get_firestore_token()
    r = req.get(
        _fs_url(project, doc_path),
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json().get("fields", {})


def write_fs(doc_path: str, fields: dict):
    """
    Ghi (PATCH merge) một document. Nếu chưa tồn tại → tạo mới.
    fields: dict theo format Firestore REST, vd {"name": {"stringValue": "x"}}
    """
    import requests as req
    token, project = _get_firestore_token()
    # Thêm updateMask để merge (không xoá field cũ không được nhắc đến)
    keys = list(fields.keys())
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in keys)
    url = _fs_url(project, doc_path) + (f"?{mask}" if mask else "")
    r = req.patch(
        url,
        json={"fields": fields},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Firestore write failed: {r.status_code} — {r.text[:300]}")


def delete_doc(doc_path: str):
    """Xoá một document. Không lỗi nếu document không tồn tại."""
    import requests as req
    token, project = _get_firestore_token()
    r = req.delete(
        _fs_url(project, doc_path),
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if r.status_code not in (200, 204, 404):
        raise RuntimeError(f"Firestore delete failed: {r.status_code} — {r.text[:300]}")


# ── LIST HELPERS ──────────────────────────────────────────────────────────────
def _extract_fields(doc: dict) -> dict:
    """Lấy fields đơn giản hóa từ Firestore document (unwrap stringValue, booleanValue...)."""
    raw = doc.get("fields", {})
    result = {}
    for k, v in raw.items():
        if "stringValue" in v:
            result[k] = v["stringValue"]
        elif "booleanValue" in v:
            result[k] = v["booleanValue"]
        elif "integerValue" in v:
            result[k] = int(v["integerValue"])
        elif "nullValue" in v:
            result[k] = None
        else:
            result[k] = v  # giữ nguyên nếu không biết type
    return result


def list_active_subscriptions() -> list[dict]:
    """
    Lấy toàn bộ push_subscriptions có active=true.
    Trả về list[dict] với các field đã được unwrap.
    Mỗi dict có thêm field 'id' = document ID.
    """
    import requests as req
    token, project = _get_firestore_token()

    # Dùng runQuery để lọc active=true ngay từ server
    url = (
        f"https://firestore.googleapis.com/v1/projects/{project}"
        f"/databases/(default)/documents:runQuery"
    )
    body = {
        "structuredQuery": {
            "from": [{"collectionId": "push_subscriptions"}],
            "where": {
                "fieldFilter": {
                    "field": {"fieldPath": "active"},
                    "op": "EQUAL",
                    "value": {"booleanValue": True},
                }
            },
        }
    }
    r = req.post(
        url,
        json=body,
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    r.raise_for_status()
    results = r.json()

    subs = []
    for item in results:
        doc = item.get("document")
        if not doc:
            continue
        fields = _extract_fields(doc)
        # Lấy document ID từ cuối path
        fields["id"] = doc["name"].split("/")[-1]
        # Rebuild keys dict cho pywebpush (cần format gốc)
        fields["keys"] = {
            "p256dh": fields.get("p256dh", ""),
            "auth":   fields.get("auth", ""),
        }
        subs.append(fields)
    return subs


def list_subcollection(path: str) -> list[dict]:
    """
    List documents trong một sub-collection.
    path: vd 'session_clicks/{sid}/users'
    Trả về list[dict] với fields đã unwrap + 'id'.
    """
    import requests as req
    token, project = _get_firestore_token()

    url = _fs_url(project, path) + "?pageSize=100"
    r = req.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    docs = r.json().get("documents", [])
    result = []
    for doc in docs:
        fields = _extract_fields(doc)
        fields["id"] = doc["name"].split("/")[-1]
        result.append(fields)
    return result


# ── MISC ──────────────────────────────────────────────────────────────────────
def firestore_now_iso() -> str:
    """Trả về thời điểm hiện tại dưới dạng ISO-8601 UTC string."""
    return datetime.now(timezone.utc).isoformat()
