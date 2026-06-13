# Kế hoạch: Admin Manual Course Management

---

## 1. Quyết định thiết kế cốt lõi

### Không đổi ID — chỉ đổi display
Vì video prefix (`010101`) gắn với `order` field của course/chapter/lesson trong auto data,
thay đổi ID có thể phá vỡ matching → **tuyệt đối không đổi ID node tự động**.  
Drag & drop chỉ thay đổi thứ tự hiển thị, không thay đổi `id` hay `order`.

### Hai lớp dữ liệu tách biệt
| Firestore doc | Ai ghi | Nội dung |
|---|---|---|
| `app_data/courses` | Chỉ `sync_drive.py` | Auto data — không bao giờ đụng |
| `app_data/overrides` | Admin qua web | Patch thủ công — layered lên trên |

→ sync_drive.py chạy lại không bao giờ xóa override.  
→ Manual override của `youtubeId` THẮNG auto data.  
→ "Reset to auto" = xóa patch của field đó, để auto data nổi lên.

### Backup
- Live: `app_data/overrides` trên Firestore (private, cần đăng nhập)
- Local: nút "Tải backup" → download JSON merged (auto + override) về máy

---

## 2. Schema `app_data/overrides`

```json
{
  "v": 1,
  "updatedAt": "2025-01-01T00:00:00Z",
  "updatedBy": "admin@gmail.com",

  "courseDisplayOrder": ["02-toan", "01-ly", "manual-abc"],

  "patches": {
    "<nodeId>": {
      "title":      "Tên ghi đè (optional)",
      "youtubeId":  "OVERRIDE_VIDEO_ID (optional)",
      "extraDocs":  [{ "title": "...", "url": "https://drive.google.com/..." }],
      "hidden":     false
    }
  },

  "manualCourses": [
    {
      "id": "manual-1715000000000",
      "title": "Khóa phụ đạo",
      "_isManual": true,
      "tree": [ ... ]
    }
  ]
}
```

**Merge logic (client-side `getMergedCourses()`):**
1. Clone `appData.courses` từ Firestore
2. Walk toàn bộ tree, apply `patches[node.id]` lên từng node
3. Thêm `overrides.manualCourses` vào cuối danh sách
4. Reorder theo `courseDisplayOrder` (IDs missing = giữ nguyên cuối)
5. Bỏ node có `patches[id].hidden === true`

---

## 3. Cập nhật Firestore Rules

```js
match /app_data/{doc} {
  allow read: if request.auth != null;
  allow write: if doc == 'overrides'
    && request.auth != null
    && exists(/databases/$(database)/documents/admins/$(request.auth.token.email));
  // app_data/courses vẫn chỉ service account ghi được (blocked by default)
}
```

---

## 3b. Bổ sung schema cho tính năng mới

```json
"patches": {
  "<chapterId>": {
    "flattenChildren": true,
    "promoteOnDelete": true
  }
},

"flattenAll": false,

"movedNodes": [
  {
    "originalId": "01-01-01-bai-1",
    "originalType": "auto",
    "destCourseId": "02-toan",
    "destChapterId": "02-01-dai-so",
    "movedAt": "ISO"
  }
]
```

Clipboard **không** lưu Firestore — chỉ tồn tại trong session (biến `_clipboard`).

---

## 4. Phase breakdown

### Phase 1 — Foundation (file `overrides.js` mới + rules)
- `loadOverrides()` / `saveOverrides(patch)` 
- `getMergedCourses(autoData, overrides)` — merge function
- Undo stack: `pushUndo(overridesBefore)`, `undo()`
- Nút "⬇ Tải backup" (download merged JSON) trong Admin Panel
- Update Firestore rules

### Phase 2 — Edit Mode + Quản lý Khóa học (Home)
- Nút ✏️ trong header (admin only, cạnh ⚙ và user-info)
- Toggle `editMode` global — thêm class `edit-mode` vào `<body>`
- Home: drag & drop course cards (update `courseDisplayOrder`)
- Card "＋ Thêm khóa học" xuất hiện khi edit mode
- Click course card (hoặc +) → popup **CourseEditModal**:
  - Đổi tên, ẩn/hiện, xóa khóa (manual) / chỉ ẩn (auto)
  - Nút "Đặt lại tên về auto" nếu đang có patch

### Phase 3 — Quản lý trong Khóa học (Sidebar)
- Pencil icon trên sidebar khi edit mode active
- Sidebar: drag & drop chapter/lesson items (update `chapterDisplayOrder` trong patch)
- Click chapter → popup **ChapterEditModal**: đổi tên, ẩn, xóa, thêm chapter mới
  - **Xóa chương**: nếu chương có bài bên trong → hiện 2 lựa chọn:
    - "Xóa tất cả bài bên trong" (xóa hẳn)
    - "Giữ bài, thăng cấp lên trên" (xóa chương, bài được promote lên cùng cấp cha)
  - Lý do: HocMai đôi khi merge 2 chương thành 1 folder → cần tách lại
- Click "＋ Thêm chương" ở cuối sidebar
- Click "＋ Bài" ở cuối mỗi chương
- Lesson item: click → navigate bình thường, có edit UI bên dưới video
- **Clipboard toolbar** hiện ở góc trên sidebar khi edit mode:
  - Mỗi item có nút ✂️ Cắt / 📋 Sao chép
  - Nút 📌 Dán (hiện khi clipboard có dữ liệu) ở đầu mỗi chapter hoặc cuối danh sách
  - Paste target: chapter (lesson được thêm vào) hoặc course (chapter được thêm vào)
- **Flatten button** (⚡ Làm phẳng) trên chapter có sub-chapter:
  - Gộp tất cả bài từ sub-chapter lên chapter cha
  - Tên bài được prefix: "TênSubChapter › TênBài" để giữ context
  - Lưu `patches[chapterId].flattenChildren = true`

### Phase 4 — Chỉnh sửa Bài học
- Bên dưới video player: input "🔗 Đổi link YouTube" + nút **Đổi / ↩ Reset auto**
- Bên dưới docs: input "📎 Thêm tài liệu (Google Drive URL)" + field tên → nút **Thêm**
- Xóa từng `extraDoc` trong edit mode
- "↩ Reset video về auto" = xóa `patches[lessonId].youtubeId`

### Phase 5 — Cut/Copy/Paste (Cross-course)
**Clipboard (in-memory `_clipboard`, không persist):**
```js
_clipboard = {
  mode: 'cut' | 'copy',
  nodeType: 'lesson' | 'chapter',
  nodeData: { ...fullNode },      // deep clone
  sourceInfo: {
    type: 'auto' | 'manual',
    courseId, chapterId, nodeId   // để biết cần hide hay remove
  }
}
```

**Cut auto node:**
1. Thêm `patches[originalId].hidden = true`
2. Thêm bản sao vào `movedNodes` (audit trail) + `manualCourses/Chapters/Lessons` ở destination
3. Node mới có `_isManual: true, _copiedFrom: originalId`

**Cut manual node:**
1. Xóa khỏi source trong `overrides`
2. Thêm vào destination

**Copy:** luôn tạo manual node mới, không ẩn source

**Paste UI:**
- Dán chapter → vào course (level 1)
- Dán lesson → vào chapter đang chọn
- Nếu clipboard là chapter và target là chapter → từ chối, gợi ý chọn course

### Phase 6 — Max Depth 3 & Flatten
**getMergedCourses() tự động:**
- Sau merge, chạy `enforceMaxDepth(tree, maxDepth=2)`
- Bất kỳ node nào ở depth > 2 (tính từ 0) mà type là lesson → promote lên depth 2
- Tên được prefix với tên cha: "PhầnA › Bài 1"
- Áp dụng khi `overrides.flattenAll === true` HOẶC `patches[chapterId].flattenChildren === true`

**Nút "⚡ Làm phẳng toàn bộ"** trong Admin Panel:
- Set `overrides.flattenAll = true`
- Xem preview trước khi xác nhận

**Nút "⚡ Làm phẳng" trên từng chapter có sub-chapter:**
- Set `patches[chapterId].flattenChildren = true`
- Granular hơn, an toàn hơn

### Phase 7 — Undo + Sync Reset
- Undo button (✕ Hoàn tác) hiện trong edit mode (ở cả ngoài home và trong khóa học), disabled nếu stack rỗng
- Redo button (↩ Làm lại) hiện cạnh undo button, disabled nếu stack rỗng
- History: 20 bước, lưu snapshot `overrides` trước mỗi thao tác
- "🔄 Đồng bộ lại từ Drive": xóa toàn bộ `patches` của node đang chọn  
  (giữ manual additions, chỉ clear patches)

---

## 5. Giao diện — dùng class có sẵn

| Component | Class hiện có |
|---|---|
| Popup modal | `.glass` + `.admin-container` style |
| Input | `<input type="text">` styled qua `style.css` |
| Nút hành động | `.btn .btn-primary` / `.btn .btn-outline` |
| Badge trạng thái | `.status .success/.warning/.error` (từ admin-check) |
| Drag handle | CSS `cursor: grab` + HTML5 Drag & Drop API |

**Không thêm CSS mới** — tận dụng hoàn toàn `style.css` + `glass.css`.

---

## 6. File sẽ thay đổi

| File | Thay đổi |
|---|---|
| `index.html` | +✏️ button, +edit mode logic, +renderHome edit, +renderLesson edit UI, +clipboard toolbar |
| `overrides.js` | **MỚI** — load/save/merge/undo/flatten/cut-paste logic |
| Firestore Rules | Thêm rule `app_data/overrides` cho admin write |

---

## 7. Edge cases cần xử lý

| Tình huống | Xử lý |
|---|---|
| sync_drive.py đổi ID lesson (hiếm) | Patch cũ orphan → UI hiển thị badge "⚠ Patch không tìm thấy node" trong Admin Panel |
| Manual course bị xóa trong overrides | `_isManual: true` → chỉ xóa được từ web, không bị sync xóa |
| Undo sau khi refresh | Stack bị reset — đó là lý do backup quan trọng |
| Admin mở 2 tab cùng lúc | Last-write-wins (Firestore `set` với merge) — chấp nhận được |
| Link YouTube invalid | Validate regex `youtu.be` / `youtube.com` trước khi lưu |
| Google Drive URL không phải `/view` | Auto-convert sang `drive.google.com/file/d/{id}/view` |