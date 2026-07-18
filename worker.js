// @ts-nocheck
// worker.js — Cloudflare Worker cho HM-LEAKBASE
// Routes:
//   GET  /go               → handleGo()         (click tracking + redirect)
//   POST /push/subscribe   → handleSubscribe()   (lưu subscription vào Firestore)
//   POST /push/unsubscribe → handleUnsubscribe() (xoá subscription)
//   POST *                 → handleSyncDispatch() (giữ nguyên hành vi cũ — nút "Sync ngay")
//
//   scheduled()           → reminderJob()        (cron mỗi phút — Phase 4, sẽ bổ sung sau)

// ── Module-level cache cho Google Access Token ───────────────────────────────
let _cachedToken = null;
let _tokenExpiry = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // Route mới: GET /go
    if (url.pathname === "/go" && method === "GET")
      return handleGo(request, env);

    // Route mới: POST /push/subscribe
    if (url.pathname === "/push/subscribe" && method === "POST")
      return handleSubscribe(request, env);

    // Route mới: POST /push/unsubscribe
    if (url.pathname === "/push/unsubscribe" && method === "POST")
      return handleUnsubscribe(request, env);

    // Route mới: GET /vapid-public-key (Cấp Public Key động cho Frontend)
    if (url.pathname === "/vapid-public-key" && method === "GET") {
      const allowedOrigin = `https://${env.GITHUB_OWNER}.github.io`;
      return new Response(env.VAPID_PUBLIC_KEY, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        }
      });
    }

    // CORS cho OPTIONS /vapid-public-key
    if (url.pathname === "/vapid-public-key" && method === "OPTIONS") {
      const allowedOrigin = `https://${env.GITHUB_OWNER}.github.io`;
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        }
      });
    }

    // Route cũ: mọi POST còn lại → handleSyncDispatch (giữ nguyên 100%)
    return handleSyncDispatch(request, env);
  },

  // Phase 4 — Cron Trigger (bật sau khi set Cron Trigger * * * * * trên Dashboard)
  async scheduled(event, env, ctx) {
    // Cron mỗi phút (* * * * *) → reminderJob (nhắc trước giờ học)
    // Cron 2 phút (*/2 0-16 * * * = 07:00-23:58 VN) → watchModeJob (lấy m3u8)
    if (event.cron === "*/2 0-16 * * *") {
      ctx.waitUntil(watchModeJob(env));
    } else {
      ctx.waitUntil(reminderJob(env));
    }
  },
};

// ════════════════════════════════════════════════════════════════════════════
// handleSyncDispatch — GIỮ NGUYÊN 100% logic cũ (KHÔNG sửa gì bên trong)
// ════════════════════════════════════════════════════════════════════════════
async function handleSyncDispatch(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = `https://${env.GITHUB_OWNER}.github.io`;

  const corsHeaders = {
    "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const authHeader = request.headers.get("Authorization") || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

    if (!idToken) {
      return new Response("Unauthorized: Missing token", { status: 401, headers: corsHeaders });
    }

    // Verify JWT cryptographically
    let payload;
    try {
      payload = await verifyFirebaseJWT(idToken, env.FIREBASE_PROJECT_ID);
    } catch (e) {
      console.error("JWT verify failed:", e.message);
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const email = payload.email;
    if (!email) {
      return new Response("Unauthorized: No email in token", { status: 401, headers: corsHeaders });
    }

    // Rate limiting — 3 lần sync / 5 phút / admin
    if (env.RATE_LIMIT_KV) {
      const allowed = await checkRateLimit(env.RATE_LIMIT_KV, `sync:${email}`);
      if (!allowed) {
        return new Response("Too Many Requests: vui lòng chờ 5 phút", {
          status: 429,
          headers: { ...corsHeaders, "Retry-After": "300" },
        });
      }
    }

    // Kiểm tra admin qua Firestore (dùng idToken của user, Rules tự validate)
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/admins/${encodeURIComponent(email)}`;
    const adminRes = await fetch(firestoreUrl, {
      headers: { "Authorization": `Bearer ${idToken}` },
    });

    if (!adminRes.ok) {
      return new Response("Forbidden: Not an admin", { status: 403, headers: corsHeaders });
    }

    // Trigger GitHub Actions
    const resp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `token ${env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "BrightWeb-Proxy",
        },
        body: JSON.stringify({ event_type: "sync-drive" }),
      }
    );

    return new Response(null, {
      status: resp.ok ? 204 : 502,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error("Worker crash:", error.message);
    return new Response("Internal Server Error", { status: 500, headers: corsHeaders });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// handleSubscribe — Nhận subscription từ client, lưu vào Firestore
// ════════════════════════════════════════════════════════════════════════════
async function handleSubscribe(request, env) {
  // CORS: cho phép từ GitHub Pages origin
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = `https://${env.GITHUB_OWNER}.github.io`;
  const corsH = makeCorsHeaders(origin, allowedOrigin);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsH });

  // [Phase 6] Rate limit theo IP — tái dùng checkRateLimit()/RATE_LIMIT_KV đã
  // có sẵn cho handleSyncDispatch. Đặt TRƯỚC verifyFirebaseJWT (tốn 1 fetch
  // JWKS) để chặn sớm, giảm chi phí nếu bị spam. Guard bằng `if (env.RATE_LIMIT_KV)`
  // giống hệt handleSyncDispatch (line ~119) — nếu binding chưa/bị mất, không
  // được để toàn bộ /push/subscribe crash 500 vì thiếu guard này.
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.RATE_LIMIT_KV) {
    const rateOk = await checkRateLimit(env.RATE_LIMIT_KV, `subscribe:${clientIp}`, 60, 5);
    if (!rateOk) {
      console.warn(`[handleSubscribe] Rate limited: ${clientIp}`);
      return new Response("Too Many Requests", { status: 429, headers: corsH });
    }
  }

  // Verify Firebase ID token
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!idToken) return new Response("Unauthorized", { status: 401, headers: corsH });

  let payload;
  try {
    payload = await verifyFirebaseJWT(idToken, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    console.error("Subscribe JWT verify failed:", e.message);
    return new Response("Unauthorized", { status: 401, headers: corsH });
  }

  // [BUG #2] Lấy uid/email từ JWT đã verify — KHÔNG tin body
  const uid = payload.sub;
  const emailFromToken = payload.email || "";
  if (!emailFromToken) {
    return new Response("Unauthorized: No email in token", { status: 401, headers: corsH });
  }

  // [BUG #1] Kiểm tra email có trong whitelist hoặc admins — chặn người ngoài nhóm
  const isAllowed = await checkWhitelistOrAdmin(emailFromToken, idToken, env);
  if (!isAllowed) {
    console.warn(`[handleSubscribe] Rejected non-whitelisted: ${emailFromToken}`);
    return new Response("Forbidden: Not whitelisted", { status: 403, headers: corsH });
  }

  // Parse body — BỎ uid, email ra khỏi destructuring (đã lấy từ JWT)
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400, headers: corsH });
  }

  const { endpoint, keys, deviceId, platform, userAgent } = body;
  if (!endpoint || !keys) {
    return new Response("Bad Request: missing endpoint/keys", { status: 400, headers: corsH });
  }

  // [H1 Fix] Validate SSRF endpoint: phải là https và đúng domain các push services phổ biến
  try {
    const epUrl = new URL(endpoint);
    if (epUrl.protocol !== "https:") throw new Error("not https");
    const validHosts = ["googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];
    if (!validHosts.some(h => epUrl.hostname === h || epUrl.hostname.endsWith("." + h))) {
      throw new Error("untrusted host");
    }
  } catch (e) {
    console.warn(`[handleSubscribe] Rejected invalid endpoint: ${endpoint} (${e.message})`);
    return new Response("Bad Request: invalid endpoint URL", { status: 400, headers: corsH });
  }

  // Tính doc ID = sha1(endpoint).slice(0,32) bằng Web Crypto (không cần Node)
  const sid = await sha1Hex(endpoint);
  const docId = sid.slice(0, 32);

  const now = new Date().toISOString();
  const fields = {
    endpoint: { stringValue: endpoint },
    p256dh: { stringValue: keys.p256dh || "" },
    auth: { stringValue: keys.auth || "" },
    uid: { stringValue: uid },           // ✅ từ JWT, không phải body
    email: { stringValue: emailFromToken }, // ✅ từ JWT, không phải body
    deviceId: { stringValue: deviceId || "" },
    platform: { stringValue: platform || "" },
    userAgent: { stringValue: (userAgent || "").slice(0, 200) },
    active: { booleanValue: true },
    lastSeenAt: { stringValue: now },
    createdAt: { stringValue: now },
  };

  try {
    await firestorePatch(env, `push_subscriptions/${docId}`, fields, true);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsH, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("handleSubscribe Firestore error:", e.message);
    return new Response("Internal Server Error", { status: 500, headers: corsH });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// handleUnsubscribe — Xoá subscription khỏi Firestore
// ════════════════════════════════════════════════════════════════════════════
async function handleUnsubscribe(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = `https://${env.GITHUB_OWNER}.github.io`;
  const corsH = makeCorsHeaders(origin, allowedOrigin);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsH });

  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!idToken) return new Response("Unauthorized", { status: 401, headers: corsH });

  let payload;
  try {
    payload = await verifyFirebaseJWT(idToken, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    return new Response("Unauthorized", { status: 401, headers: corsH });
  }

  // [BUG #1] Kiểm tra whitelist nhất quán với handleSubscribe
  const emailFromToken = payload.email || "";
  if (emailFromToken) {
    const isAllowed = await checkWhitelistOrAdmin(emailFromToken, idToken, env);
    if (!isAllowed) {
      console.warn(`[handleUnsubscribe] Rejected non-whitelisted: ${emailFromToken}`);
      return new Response("Forbidden: Not whitelisted", { status: 403, headers: corsH });
    }
  }

  let body;
  try { body = await request.json(); } catch { return new Response("Bad Request", { status: 400, headers: corsH }); }

  const { endpoint } = body;
  if (!endpoint) return new Response("Bad Request: missing endpoint", { status: 400, headers: corsH });

  const sid = await sha1Hex(endpoint);
  const docId = sid.slice(0, 32);

  try {
    // [BUG #3] Verify ownership: đọc doc trước, so uid với payload.sub
    const existing = await firestoreGet(env, `push_subscriptions/${docId}`);
    if (existing && existing.fields?.uid?.stringValue !== payload.sub) {
      console.warn(`[handleUnsubscribe] uid mismatch: doc=${existing.fields?.uid?.stringValue} token=${payload.sub}`);
      return new Response("Forbidden: Not the subscription owner", { status: 403, headers: corsH });
    }

    await firestoreDelete(env, `push_subscriptions/${docId}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsH, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("handleUnsubscribe Firestore error:", e.message);
    return new Response("Internal Server Error", { status: 500, headers: corsH });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// handleGo — Click tracking + redirect sang link thật
// ════════════════════════════════════════════════════════════════════════════
async function handleGo(request, env) {
  const url = new URL(request.url);
  const session = url.searchParams.get("session");
  const user = url.searchParams.get("user");
  const to = url.searchParams.get("to");

  // Validate tham số
  if (!session || !to) {
    return new Response("Bad Request: missing session or to", { status: 400 });
  }

  // [C1/C2 Fix] Regex validation chống path traversal / parameter injection
  // Dù sao worker auth header không gửi được qua redirect, nên ta check format chặt chẽ
  const idRegex = /^[\w-]{1,128}$/;
  if (!idRegex.test(session) || (user && !idRegex.test(user))) {
    console.warn(`[handleGo] Rejected invalid session/user format: ${session} / ${user}`);
    return new Response("Bad Request: invalid format", { status: 400 });
  }

  let decodedTo;
  try {
    decodedTo = decodeURIComponent(to);
    const targetUrl = new URL(decodedTo);
    const allowedDomains = [".hocmai.net", ".hocmai.vn", ".hcdn.vn", ".viettelcdn.vn"];
    const isAllowed = allowedDomains.some(domain => targetUrl.hostname.endsWith(domain));
    if (!isAllowed) {
      return new Response("Bad Request: unsafe redirect domain", { status: 403 });
    }
  } catch {
    return new Response("Bad Request: invalid 'to'", { status: 400 });
  }

  // [BUG #4] Ghi click vào Firestore — CHỈ patch nếu doc đã tồn tại sẵn
  // (send_push.py tạo doc users/{uid} trước khi gửi push, nếu không có doc = user lạ/spam)
  if (user) {
    const now = new Date().toISOString();
    // [C1 Fix] Encode thành phần path
    const docPath = `session_clicks/${encodeURIComponent(session)}/users/${encodeURIComponent(user)}`;

    // fire-and-forget: không await, không chặn redirect
    firestoreGet(env, docPath).then((existing) => {
      if (existing) {
        return firestorePatch(env, docPath, {
          clicked: { booleanValue: true },
          clickedAt: { stringValue: now },
        }, true);
      } else {
        console.warn(`[handleGo] Ignored click: doc ${docPath} does not exist (unknown user or session)`);
      }
    }).catch((e) => console.error("handleGo Firestore error:", e.message));
  }

  // Redirect 302 ngay lập tức
  return Response.redirect(decodedTo, 302);
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 4 — Cron reminder T-90s
// Chạy mỗi phút, tìm session sắp bắt đầu trong [+60s, +120s],
// gửi burst 3 thông báo cách nhau 4s cho user chưa click.
// ════════════════════════════════════════════════════════════════════════════

const WORKER_SELF = "https://brightweb-sync.mcdg5444.workers.dev";

/**
 * Chuyển timestamp (ms) sang ISO string khớp format Python isoformat():
 * Python: "2026-07-13T03:33:00+00:00"  (không ms, dùng +00:00)
 * JS:     "2026-07-13T03:33:00.123Z"   (có ms, dùng Z)
 * Firestore so sánh lexicographic → format PHẢI nhất quán.
 * Bug: '+' (ASCII 43) < '.' (ASCII 46) nên 'xxx+00:00' < 'xxx.123Z' ⇒ query SAI.
 */
function toFirestoreIso(ms) {
  // Xóa milliseconds và thay 'Z' bằng '+00:00' → khớp Python isoformat()
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// Các mốc nhắc trước giờ học: offset tính bằng giây trước startAt.
// Emoji leo thang theo mức "khẩn cấp" — vì mỗi mốc chỉ gửi cho user CHƯA
// click link (pendingUids), nên hễ ai nhận được mốc muộn tức là vẫn chưa
// vào lớp dù đã bị nhắc các mốc trước đó.
const REMINDER_CHECKPOINTS = [
  { key: "reminded_15m", offsetSec: 900, tolSec: 35, bursts: 1, emoji: "🔔", label: "15 phút nữa", ttl: 3600 },
  { key: "reminded_10m", offsetSec: 600, tolSec: 35, bursts: 1, emoji: "🔔", label: "10 phút nữa", ttl: 3600 },
  { key: "reminded_5m", offsetSec: 300, tolSec: 35, bursts: 1, emoji: "⏰", label: "5 phút nữa", ttl: 1800 },
  { key: "reminded_150s", offsetSec: 150, tolSec: 35, bursts: 2, emoji: "⚠️", label: "2 phút 30 giây nữa", ttl: 600 },
  { key: "reminded_60s", offsetSec: 60, tolSec: 35, bursts: 3, emoji: "🚨", label: "1 phút nữa", ttl: 300 },
];

// ════════════════════════════════════════════════════════════════════════════
// [Phase 2/3] Helpers dùng chung giữa watchModeJob (tự tạo "Link mới" —
// handleNewM3u8) và reminderJob (fallback khi chưa có session_clicks —
// tryFallbackFromSchedule). Lấp khoảng trống kiến trúc: trước đây CHỈ
// GitHub Action (tools/send_push.py) mới tạo doc `session_clicks/{sid}`,
// nên nếu Action lỗi hoặc không kịp chạy đúng lúc thì reminderJob luôn
// "Found 0 session(s)" — đúng như log Cloudflare ngày 16/7/2026.
// ════════════════════════════════════════════════════════════════════════════

/** Timestamp hiện tại, format khớp Firestore/Python (suffix +00:00, không ms) */
function nowFsIso() {
  return toFirestoreIso(Date.now());
}

/** Base URL của PWA (GitHub Pages) — dùng khi CHƯA có link m3u8 thật để mở */
function appUrl(env) {
  return `https://${env.GITHUB_OWNER}.github.io/${env.GITHUB_REPO}`;
}

/**
 * sessionId dự phòng — đường chính luôn dùng `ev.sessionId` do
 * crawl_calendar.py ghi sẵn (session_id() = sha1(date|time|title)[:16]).
 * Hàm này chỉ chạy khi event thiếu sẵn field đó (data cũ/bất thường) —
 * PHẢI khớp hash Python 100% nếu được dùng tới.
 */
async function computeSid(ev) {
  const raw = `${ev.date}|${ev.time}|${ev.title}`;
  const hex = await sha1Hex(raw);
  return hex.slice(0, 16);
}

/**
 * startAt dự phòng — đường chính luôn dùng `ev.startAt` do
 * crawl_calendar.py ghi sẵn (compute_start_at(): VN local → UTC ISO,
 * suffix "+00:00" khớp toFirestoreIso()). Chỉ chạy khi thiếu field đó.
 */
function computeStartAtFromVN(dateStr, timeStr) {
  const [Y, M, D] = (dateStr || "").split("-").map(Number);
  const [h, m] = (timeStr || "").split(":").map(Number);
  if ([Y, M, D, h, m].some((n) => Number.isNaN(n))) return null;
  const vnEpochMs = Date.UTC(Y, M - 1, D, h, m, 0) - 7 * 3600 * 1000;
  return toFirestoreIso(vnEpochMs);
}

/**
 * Danh sách subscription đang active — schema PHẲNG (endpoint/p256dh/auth/
 * uid/email/active), khớp field do handleSubscribe() ghi. KHÔNG có field
 * lồng `keys.p256dh/auth` — chỉ tồn tại ở bên Python (firestore_rest.py),
 * không phải ở Worker. Tách từ logic vốn nằm inline trong reminderJob để
 * dùng lại ở handleNewM3u8()/tryFallbackFromSchedule() — hành vi giữ
 * nguyên 100% so với bản gốc.
 */
async function listActiveSubscriptions(env) {
  const allSubDocs = await firestoreListCollection(env, "push_subscriptions");
  return allSubDocs
    .filter((doc) => doc.fields?.active?.booleanValue === true)
    .map((doc) => ({
      endpoint: doc.fields.endpoint?.stringValue,
      p256dh: doc.fields.p256dh?.stringValue,
      auth: doc.fields.auth?.stringValue,
      uid: doc.fields.uid?.stringValue,
      email: doc.fields.email?.stringValue,
      id: doc.name.split("/").pop(),
    }))
    .filter((s) => s.endpoint && s.p256dh && s.auth);
}

/**
 * [Phase 2 — CHỦ CHỐT] Khi watchModeJob phát hiện m3u8 mới/đổi cho 1 event,
 * TỰ tạo doc `session_clicks/{sid}` (để reminderJob thấy được ngay, không
 * cần chờ GitHub Action) + TỰ gửi push "Link mới". `tools/send_push.py`
 * vẫn chạy như cũ sau đó và tự skip vì thấy doc đã tồn tại với cùng
 * realLink (logic skip đã có sẵn ở send_push.py — không cần đổi Python).
 */
async function handleNewM3u8(env, ev, m3u8) {
  const sid = ev.sessionId || (await computeSid(ev));
  const startAt = ev.startAt || computeStartAtFromVN(ev.date, ev.time);
  if (!startAt || !sid) {
    console.log(`[handleNewM3u8] skip: invalid startAt/sid for ${ev.title}`);
    return;
  }

  const existing = await firestoreGet(env, `session_clicks/${sid}`).catch(() => null);
  const oldLink = existing?.fields?.realLink?.stringValue || null;
  if (oldLink === m3u8) return; // đã ghi đúng link này rồi → không làm gì thêm
  // isFirstRealLink cũng đúng cho doc do tryFallbackFromSchedule() tạo trước
  // (realLink=null lúc đó) — dù doc đã tồn tại, đây vẫn là link thật ĐẦU
  // TIÊN nên phải dùng tiêu đề "ĐÃ CÓ LINK HỌC", không phải "LINK ĐỔI".
  const isFirstRealLink = !oldLink;

  const subs = await listActiveSubscriptions(env);

  // Tạo/patch doc TRƯỚC khi gửi push — đảm bảo reminderJob thấy được ngay
  // cả khi bước gửi push bên dưới lỗi giữa chừng.
  try {
    await firestorePatch(env, `session_clicks/${sid}`, {
      sessionId: { stringValue: sid },
      subject: { stringValue: ev.subject || "" },
      title: { stringValue: ev.title || "" },
      date: { stringValue: ev.date },
      time: { stringValue: ev.time },
      startAt: { stringValue: startAt },
      realLink: { stringValue: m3u8 },
      reminderSent: { booleanValue: false }, // field cũ, tools/send_push.py vẫn ghi — giữ khớp schema
      notifiedBy: { stringValue: "worker-watchmode" },
      createdAt: { stringValue: existing?.fields?.createdAt?.stringValue || nowFsIso() },
      updatedAt: { stringValue: nowFsIso() },
    }, true);
  } catch (e) {
    console.error(`[handleNewM3u8] ${sid}: patch doc failed:`, e.message);
    return;
  }

  if (subs.length === 0) {
    console.log(`[handleNewM3u8] ${sid}: doc ${existing ? "updated" : "created"}, 0 subscribers to push`);
    return;
  }

  // users/{uid} subdocs — reset clicked=false để reminderJob biết ai còn
  // "pending" cho link mới/đổi. CHỈ patch field `clicked` (updateMask 1
  // field) — KHÔNG kèm clickedAt/remindedAt/createdAt nữa: nếu đây là link
  // ĐỔI (không phải session mới), user đã có subdoc từ trước sẽ bị mất lịch
  // sử audit oan nếu ghi đè cả 4 field mỗi lần đổi link. Với user thực sự
  // mới, thiếu 3 field kia không sao vì reminderJob/send_push.py không đọc
  // chúng để quyết định gì (chỉ đọc `clicked`).
  for (const sub of subs) {
    await firestorePatch(env, `session_clicks/${sid}/users/${sub.uid}`, {
      clicked: { booleanValue: false },
    }, true).catch((e) => console.log(`[handleNewM3u8] ${sid}: init user doc fail uid=${sub.uid}: ${e.message}`));
  }

  const pushTitle = isFirstRealLink ? "🗣🔥🔥🔥 ĐÃ CÓ LINK HỌC 😈" : "📡 LINK BỊ THAY ĐỔI ĐỘT NGỘT";
  let success = 0;
  // Tuần tự (KHÔNG Promise.all): encrypt Web Push (RFC 8291) tốn CPU, Free
  // plan chỉ có 10ms CPU/invocation — gửi song song dễ spike vượt quota.
  for (const sub of subs) {
    const goUrl = `${WORKER_SELF}/go?session=${encodeURIComponent(sid)}&user=${encodeURIComponent(sub.uid)}&to=${encodeURIComponent(m3u8)}`;
    const payload = JSON.stringify({
      title: pushTitle,
      body: `${ev.subject || ""} — ${ev.title}`.trim(),
      url: goUrl,
      tag: `link-${sid}`, // dedup: tag cố định → trình duyệt tự thay notification cũ bằng mới
      sessionId: sid,
    });
    try {
      const status = await sendWebPush(sub.endpoint, sub.p256dh, sub.auth, payload, env, 86400);
      if (status >= 200 && status < 300) success++;
      else if (status === 404 || status === 410) {
        await firestoreDelete(env, `push_subscriptions/${sub.id}`).catch(() => { });
      }
    } catch (e) {
      console.log(`[handleNewM3u8] push fail uid=${sub.uid}: ${e.message}`);
    }
  }
  console.log(`[handleNewM3u8] ${sid}: ${isFirstRealLink ? "new" : "changed"} link, pushed ${success}/${subs.length}`);
}

/**
 * [Phase 3] Lưới an toàn cuối cùng: khi reminderJob query `session_clicks`
 * ra 0 kết quả, đọc thẳng `app_data/schedule` — nếu có event rơi vào
 * window mà CHƯA có doc session_clicks thì tạo tạm (realLink=null) để vẫn
 * nhắc được. Không phụ thuộc watchModeJob/GitHub Action đã lấy được m3u8
 * hay chưa; khi sau đó lấy được, handleNewM3u8() sẽ tự update lại doc này
 * (không tạo trùng, vì đã tồn tại → nhánh isChanged xử lý).
 */
async function tryFallbackFromSchedule(env, windowStart, windowEnd) {
  const doc = await firestoreGet(env, "app_data/schedule").catch(() => null);
  if (!doc?.fields?.json?.stringValue) return [];
  let schedule;
  try { schedule = JSON.parse(doc.fields.json.stringValue); }
  catch { return []; }

  // [Low #7] Lọc sớm theo ngày VN trước khi tính startAt/computeSid cho từng
  // event — lịch có thể chứa hàng trăm event nhiều tháng, đa số chắc chắn
  // ngoài window [now-90s, now+16min]. Lấy CẢ hôm nay lẫn ngày mai VN để
  // không bỏ sót event 00:0x VN khi now đang ~23:5x VN hôm trước.
  const todayStr = toVnParts(Date.now()).date;
  const tomorrowStr = toVnParts(Date.now() + 24 * 3600 * 1000).date;
  const nearEvents = (schedule.events || []).filter(
    (ev) => ev.date === todayStr || ev.date === tomorrowStr
  );

  // [Low #6] Hoist ra ngoài loop — trước đây gọi lại mỗi lần tạo 1 fallback
  // doc mới; nếu 2 event cùng rơi vào window 1 tick sẽ đọc push_subscriptions
  // 2 lần không cần thiết.
  const subs = await listActiveSubscriptions(env);

  const created = [];
  for (const ev of nearEvents) {
    const startAt = ev.startAt || computeStartAtFromVN(ev.date, ev.time);
    if (!startAt || startAt < windowStart || startAt > windowEnd) continue;

    const sid = ev.sessionId || (await computeSid(ev));
    const existing = await firestoreGet(env, `session_clicks/${sid}`).catch(() => null);
    if (existing) continue; // đã có doc (watchModeJob hoặc GitHub Action tạo trước) → bỏ qua

    try {
      await firestorePatch(env, `session_clicks/${sid}`, {
        sessionId: { stringValue: sid },
        subject: { stringValue: ev.subject || "" },
        title: { stringValue: ev.title || "" },
        date: { stringValue: ev.date },
        time: { stringValue: ev.time },
        startAt: { stringValue: startAt },
        realLink: { nullValue: null }, // chưa có link thật — reminderJob sẽ mở app thay vì m3u8
        reminderSent: { booleanValue: false },
        notifiedBy: { stringValue: "reminder-fallback" },
        createdAt: { stringValue: nowFsIso() },
        updatedAt: { stringValue: nowFsIso() },
      }, true);
    } catch (e) {
      console.error(`[reminderJob] fallback create ${sid} failed:`, e.message);
      continue;
    }

    for (const sub of subs) {
      await firestorePatch(env, `session_clicks/${sid}/users/${sub.uid}`, {
        clicked: { booleanValue: false },
        clickedAt: { nullValue: null },
        remindedAt: { nullValue: null },
        createdAt: { stringValue: nowFsIso() },
      }, true).catch(() => { });
    }

    created.push({
      name: `session_clicks/${sid}`,
      id: sid,
      fields: {
        startAt: { stringValue: startAt },
        subject: { stringValue: ev.subject || "" },
        title: { stringValue: ev.title || "" },
        realLink: { nullValue: null },
      },
    });
  }
  return created;
}

async function reminderJob(env) {
  const now = Date.now();
  // Quét rộng: từ 90s trước tới 16 phút sau — đủ phủ mốc xa nhất (15 phút) + buffer trễ cron
  const windowStart = toFirestoreIso(now - 90_000);
  const windowEnd = toFirestoreIso(now + 16 * 60_000);

  console.log(`[reminderJob] Window: ${windowStart} → ${windowEnd}`);

  let sessions;
  try {
    sessions = await firestoreRunQuery(env, "session_clicks", [
      {
        fieldFilter: {
          field: { fieldPath: "startAt" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { stringValue: windowStart },
        },
      },
      {
        fieldFilter: {
          field: { fieldPath: "startAt" },
          op: "LESS_THAN_OR_EQUAL",
          value: { stringValue: windowEnd },
        },
      },
    ]);
  } catch (e) {
    console.error("[reminderJob] query error:", e.message);
    return;
  }

  console.log(`[reminderJob] Found ${sessions.length} session(s) in window`);

  // [Phase 3] Lưới an toàn: nếu chưa có doc session_clicks nào (vd. watchMode
  // chưa kịp lấy m3u8, hoặc GitHub Action lỗi/không chạy đúng lúc), tạo tạm
  // từ app_data/schedule để vẫn nhắc được (xem tryFallbackFromSchedule()).
  // Dùng luôn trong tick này (không đợi tick sau) — mốc 60s/150s có dung sai
  // chỉ ±35s nên chờ thêm 1 phút có thể lỡ hẳn mốc gần giờ học nhất.
  if (sessions.length === 0) {
    const fallback = await tryFallbackFromSchedule(env, windowStart, windowEnd).catch((e) => {
      console.error("[reminderJob] fallback error:", e.message);
      return [];
    });
    if (fallback.length > 0) {
      console.log(`[reminderJob] fallback created ${fallback.length} session_clicks doc(s)`);
      sessions = fallback;
    }
  }
  if (sessions.length === 0) return;

  // Với mỗi session, tìm checkpoint (nếu có) đang khớp giờ hiện tại và CHƯA gửi
  const dueList = [];
  for (const s of sessions) {
    const startAtStr = s.fields.startAt?.stringValue;
    if (!startAtStr) continue;
    const startAtMs = Date.parse(startAtStr);
    if (isNaN(startAtMs)) continue;
    const secUntil = (startAtMs - now) / 1000;

    for (const cp of REMINDER_CHECKPOINTS) {
      if (s.fields[cp.key]?.booleanValue === true) continue; // đã gửi mốc này rồi
      if (Math.abs(secUntil - cp.offsetSec) <= cp.tolSec) {
        dueList.push({ session: s, checkpoint: cp });
        break; // 1 session chỉ khớp tối đa 1 checkpoint mỗi lần chạy
      }
    }
  }

  if (dueList.length === 0) {
    console.log("[reminderJob] No due checkpoints");
    return;
  }

  // Lấy toàn bộ subscription active — dùng chung cho mọi checkpoint due lần này
  let activeSubs;
  try {
    activeSubs = await listActiveSubscriptions(env);
  } catch (e) {
    console.error("[reminderJob] list subs error:", e.message);
    return;
  }

  if (activeSubs.length === 0) {
    console.log("[reminderJob] No active subscriptions");
    return;
  }

  for (const { session, checkpoint } of dueList) {
    const sid = session.id;
    const fields = session.fields;
    const subject = fields.subject?.stringValue || "Lịch học";
    const title = fields.title?.stringValue || "";
    // [Phase 3] realLink có thể null (doc tạo bởi tryFallbackFromSchedule khi
    // chưa lấy được m3u8) — /go chỉ allowlist domain hocmai/CDN nên KHÔNG
    // dùng /go cho trường hợp này, mở thẳng app (giống send_daily_digest()
    // bên Python vốn cũng không đi qua go_url khi không có link cụ thể).
    const realLink = fields.realLink?.stringValue || null;

    // Đánh dấu checkpoint đã xử lý TRƯỚC KHI gửi (tránh double-fire nếu 2 lần cron chồng nhau)
    try {
      await firestorePatch(env, `session_clicks/${sid}`, {
        [checkpoint.key]: { booleanValue: true },
      }, true);
    } catch (e) {
      console.error(`[reminderJob] patch ${checkpoint.key} error for ${sid}:`, e.message);
      continue;
    }

    let users;
    try {
      users = await firestoreListSubcollection(env, `session_clicks/${sid}/users`);
    } catch (e) {
      console.error(`[reminderJob] list users error for ${sid}:`, e.message);
      continue;
    }

    const pendingUids = new Set(
      users.filter((u) => u.fields?.clicked?.booleanValue !== true).map((u) => u.id)
    );

    if (pendingUids.size === 0) {
      console.log(`[reminderJob] ${sid}: all clicked already, skip ${checkpoint.key}`);
      continue;
    }

    const subsToNotify = activeSubs.filter((s) => pendingUids.has(s.uid));
    if (subsToNotify.length === 0) {
      console.log(`[reminderJob] ${sid}: no active subs for pending users, skip ${checkpoint.key}`);
      continue;
    }

    console.log(`[reminderJob] ${sid}: ${checkpoint.key} → ${subsToNotify.length} user(s), x${checkpoint.bursts} burst`);

    for (let burst = 1; burst <= checkpoint.bursts; burst++) {
      const nowIso = new Date().toISOString();
      for (const sub of subsToNotify) {
        const goUrl = realLink
          ? `${WORKER_SELF}/go?session=${encodeURIComponent(sid)}&user=${encodeURIComponent(sub.uid)}&to=${encodeURIComponent(realLink)}`
          : `${appUrl(env)}/#calendar`;
        const payload = JSON.stringify({
          title: `${checkpoint.emoji} Sắp học: ${subject}`,
          body: `${title ? title + " — " : ""}bắt đầu trong ${checkpoint.label}!`,
          url: goUrl,
          tag: `remind-${sid}-${checkpoint.key}-${burst}`,
          sessionId: sid,
        });

        try {
          const status = await sendWebPush(sub.endpoint, sub.p256dh, sub.auth, payload, env, checkpoint.ttl);
          console.log(`  [${checkpoint.key} burst ${burst}] ${sub.email || sub.uid}: HTTP ${status}`);

          if (status === 404 || status === 410) {
            // Subscription hỏng → xoá (fire-and-forget)
            firestoreDelete(env, `push_subscriptions/${sub.id}`).catch(() => { });
          } else if (status === 201 || status === 200 || status === 204) {
            // Cập nhật remindedAt (fire-and-forget)
            firestorePatch(env, `session_clicks/${sid}/users/${sub.uid}`, {
              remindedAt: { stringValue: nowIso },
            }, true).catch(() => { });
          }
        } catch (e) {
          console.error(`  [${checkpoint.key} burst ${burst}] error for ${sub.uid}:`, e.message);
        }
      }

      // Đợi 4 giây giữa các burst (trừ burst cuối)
      if (burst < checkpoint.bursts) await sleep(4000);
    }
  }
}

// ── sleep helper ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════════════════════════════
// WEB PUSH ENCRYPTION (RFC 8291 + RFC 8188 aes128gcm)
// Thuần Web Crypto API — không cần Node.js / npm / nodejs_compat
// ════════════════════════════════════════════════════════════════════════════

/**
 * Gửi 1 Web Push tới 1 subscription.
 * @returns {number} HTTP status code (201=success, 404/410=expired, v.v.)
 */
async function sendWebPush(endpoint, p256dhB64, authB64, payloadStr, env, ttl = 3600) {
  // Parse subscriber keys
  const recipientPublic = b64ToBytes(p256dhB64); // 65 bytes, uncompressed P-256
  const authSecret = b64ToBytes(authB64);    // 16 bytes

  // 1. Ephemeral P-256 key pair (Application Server = Sender)
  const ephemeralPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, ["deriveBits"]
  );
  const senderPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeralPair.publicKey)
  ); // 65 bytes uncompressed

  // 2. Import recipient public key for ECDH
  const recipientKey = await crypto.subtle.importKey(
    "raw", recipientPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );

  // 3. ECDH shared secret (256 bits)
  const sharedSecretBuf = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientKey },
    ephemeralPair.privateKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedSecretBuf);

  // 4. HKDF per RFC 8291 — derive IKM
  //    auth_info = "WebPush: info\0" || ua_public(65) || as_public(65)
  const authInfo = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info"),
    0x00,
    ...recipientPublic,
    ...senderPublicRaw,
  ]);

  //    PRK_key = HMAC-SHA-256(auth_secret, sharedSecret)  [HKDF-Extract]
  const prkKey = await crypto.subtle.importKey(
    "raw", authSecret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const prkRaw = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, sharedSecret));

  //    IKM = HMAC-SHA-256(PRK_key, auth_info || 0x01)[:32]  [HKDF-Expand, 1 block]
  const ikmKey = await crypto.subtle.importKey(
    "raw", prkRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const ikmInput = new Uint8Array([...authInfo, 0x01]);
  const ikm = new Uint8Array(await crypto.subtle.sign("HMAC", ikmKey, ikmInput));

  // 5. Random 16-byte salt for content encryption
  const salt = crypto.getRandomValues(new Uint8Array(16));

  //    PRK2 = HMAC-SHA-256(salt, IKM)  [HKDF-Extract for content keys]
  const prk2Key = await crypto.subtle.importKey(
    "raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const prk2 = new Uint8Array(await crypto.subtle.sign("HMAC", prk2Key, ikm));

  const prk2SignKey = await crypto.subtle.importKey(
    "raw", prk2, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );

  //    CEK = HMAC-SHA-256(PRK2, "Content-Encoding: aes128gcm\0" || 0x01)[:16]
  const cekInput = new Uint8Array([
    ...new TextEncoder().encode("Content-Encoding: aes128gcm"),
    0x00, 0x01,
  ]);
  const cek = new Uint8Array(await crypto.subtle.sign("HMAC", prk2SignKey, cekInput)).slice(0, 16);

  //    NONCE = HMAC-SHA-256(PRK2, "Content-Encoding: nonce\0" || 0x01)[:12]
  const nonceInput = new Uint8Array([
    ...new TextEncoder().encode("Content-Encoding: nonce"),
    0x00, 0x01,
  ]);
  const nonce = new Uint8Array(await crypto.subtle.sign("HMAC", prk2SignKey, nonceInput)).slice(0, 12);

  // 6. AES-128-GCM encrypt
  //    paddedPlaintext = plaintext + 0x02 (last-record delimiter, no extra padding)
  const plaintext = new TextEncoder().encode(payloadStr);
  const paddedPlaintext = new Uint8Array([...plaintext, 0x02]);

  const cekKey = await crypto.subtle.importKey(
    "raw", cek, { name: "AES-GCM" }, false, ["encrypt"]
  );
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 },
    cekKey,
    paddedPlaintext
  );
  const ciphertext = new Uint8Array(ciphertextBuf); // plaintext + 1 (delimiter) + 16 (GCM tag)

  // 7. Build aes128gcm header: salt(16) | rs=4096(4) | idlen=65(1) | senderPublic(65)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  // rs as big-endian uint32
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = 65; // idlen = length of sender public key
  header.set(senderPublicRaw, 21);

  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);

  // 8. VAPID JWT (ES256)
  const origin = new URL(endpoint).origin;
  const vapidJwt = await makeVapidJwt(origin, env);

  // 9. POST to push endpoint
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${vapidJwt},k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": String(ttl),
    },
    body,
  });

  return resp.status;
}

/**
 * Tạo VAPID JWT dùng ES256 (ECDSA P-256) — chuẩn Web Push VAPID (RFC 8292)
 * VAPID_PRIVATE_KEY là raw base64url P-256 scalar (32 bytes)
 * VAPID_PUBLIC_KEY  là raw base64url uncompressed P-256 point (65 bytes: 04||x||y)
 */
async function makeVapidJwt(audience, env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    aud: audience,
    exp: now + 86400,
    sub: env.VAPID_SUBJECT,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // Tách x, y từ uncompressed public key (04 || x(32) || y(32))
  const pubKeyBytes = b64ToBytes(env.VAPID_PUBLIC_KEY); // 65 bytes
  const privKeyBytes = b64ToBytes(env.VAPID_PRIVATE_KEY); // 32 bytes

  // Import dưới dạng JWK
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: b64url(privKeyBytes),                  // raw private scalar
    x: b64url(pubKeyBytes.slice(1, 33)),      // x coordinate
    y: b64url(pubKeyBytes.slice(33, 65)),     // y coordinate
  };

  const privateKey = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );

  // ECDSA sign → raw format (r||s, 64 bytes) — khớp với ES256 JWT
  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${b64url(new Uint8Array(sigBytes))}`;
}

// ════════════════════════════════════════════════════════════════════════════
// FIRESTORE REST HELPERS
// ════════════════════════════════════════════════════════════════════════════

/** Lấy OAuth2 access token từ service account để ghi Firestore */
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  // Trả cache nếu còn hiệu lực > 5 phút
  if (_cachedToken && _tokenExpiry - now > 300) return _cachedToken;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const { client_email, private_key } = sa;

  // Tạo JWT RS256
  const header = { alg: "RS256", typ: "JWT" };
  const jwtPayload = {
    iss: client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(jwtPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Chuyển PEM → DER (bỏ header/footer, base64-decode)
  const pemBody = private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const derBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", derBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const sig = b64url(sigBytes);
  const jwt = `${signingInput}.${sig}`;

  // Đổi JWT lấy access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    throw new Error(`OAuth2 token exchange failed: ${tokenRes.status} ${txt}`);
  }
  const { access_token, expires_in } = await tokenRes.json();

  _cachedToken = access_token;
  _tokenExpiry = now + (expires_in || 3600);
  return _cachedToken;
}

/** PATCH (merge upsert) một Firestore document */
async function firestorePatch(env, docPath, fieldsObj, merge = true) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const token = await getGoogleAccessToken(env);

  let url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  if (merge) {
    const keys = Object.keys(fieldsObj);
    const mask = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
    url += `?${mask}`;
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: fieldsObj }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`firestorePatch ${docPath} failed: ${res.status} ${txt}`);
  }
  return res;
}

/** DELETE một Firestore document */
async function firestoreDelete(env, docPath) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const token = await getGoogleAccessToken(env);

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${token}` },
  });

  // 404 = không tồn tại → coi như đã xoá thành công
  if (!res.ok && res.status !== 404) {
    const txt = await res.text();
    throw new Error(`firestoreDelete ${docPath} failed: ${res.status} ${txt}`);
  }
  return res;
}

/** GET một Firestore document đơn (trả null nếu 404) */
async function firestoreGet(env, docPath) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const token = await getGoogleAccessToken(env);

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`firestoreGet ${docPath} failed: ${res.status} ${txt}`);
  }
  return res.json();
}

/** List documents trong một collection (để lấy toàn bộ push_subscriptions) */
async function firestoreListCollection(env, collectionId) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const token = await getGoogleAccessToken(env);

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionId}?pageSize=200`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`firestoreListCollection ${collectionId} failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return data.documents || [];
}

/** runQuery để lọc session_clicks theo startAt range */
async function firestoreRunQuery(env, collectionId, filters) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const token = await getGoogleAccessToken(env);

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        compositeFilter: {
          op: "AND",
          filters,
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`firestoreRunQuery ${collectionId} failed: ${res.status} ${txt}`);
  }

  const results = await res.json();
  // Mỗi phần tử có thể có hoặc không có field "document" — lọc bỏ phần tử trống
  return results.filter((r) => r.document).map((r) => ({
    name: r.document.name,
    fields: r.document.fields,
    // Lấy sessionId từ cuối path: .../session_clicks/{sessionId}
    id: r.document.name.split("/").pop(),
  }));
}

/** List sub-collection documents (vd: session_clicks/{sid}/users) */
async function firestoreListSubcollection(env, path) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const token = await getGoogleAccessToken(env);

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?pageSize=100`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    const txt = await res.text();
    throw new Error(`firestoreListSubcollection ${path} failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return (data.documents || []).map((d) => ({
    name: d.name,
    fields: d.fields,
    id: d.name.split("/").pop(),
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (được dùng bởi cả route cũ và mới)
// ════════════════════════════════════════════════════════════════════════════

/** Tạo CORS headers chuẩn */
function makeCorsHeaders(origin, allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

/** SHA-1 hex của một string (dùng Web Crypto native, không cần Node) */
async function sha1Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Base64url encode (string hoặc ArrayBuffer) */
function b64url(data) {
  let str;
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    str = String.fromCharCode(...new Uint8Array(data));
  } else {
    str = typeof data === "string" ? data : JSON.stringify(data);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Verify Firebase JWT (giữ nguyên 100% từ bản cũ) ─────────────────────────
async function verifyFirebaseJWT(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const header = JSON.parse(b64Decode(parts[0]));
  const payload = JSON.parse(b64Decode(parts[1]));

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error("Token expired");
  if (!payload.iat || payload.iat > now + 300) throw new Error("Token iat invalid");

  if (payload.iss !== `https://securetoken.google.com/${projectId}`)
    throw new Error("Invalid issuer");
  if (payload.aud !== projectId)
    throw new Error("Invalid audience");
  if (!payload.sub)
    throw new Error("Missing subject");

  const jwksRes = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    { cf: { cacheTtl: 3600, cacheEverything: true } }
  );
  if (!jwksRes.ok) throw new Error("Failed to fetch Firebase public keys");
  const { keys } = await jwksRes.json();

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`No public key for kid=${header.kid}`);

  const cryptoKey = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    b64ToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!valid) throw new Error("Invalid JWT signature");
  return payload;
}

// ── Whitelist / admin check (dùng token của chính user, Rules tự validate) ────
/**
 * Kiểm tra email có trong whitelist hoặc admins không.
 * Dùng idToken của chính user → Firestore Rules tự validate quyền tự-đọc.
 * Không cần service account, không cần sửa Firestore Rules.
 */
async function checkWhitelistOrAdmin(email, idToken, env) {
  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const headers = { "Authorization": `Bearer ${idToken}` };
  const [wlRes, adminRes] = await Promise.all([
    fetch(`${base}/whitelist/${encodeURIComponent(email)}`, { headers }),
    fetch(`${base}/admins/${encodeURIComponent(email)}`, { headers }),
  ]);
  return wlRes.ok || adminRes.ok;
}

// ── Rate limiting (giữ nguyên từ bản cũ) ─────────────────────────────────────
async function checkRateLimit(kv, key, windowSec = 300, maxReqs = 3) {
  const now = Math.floor(Date.now() / 1000);
  const raw = await kv.get(key);
  let timestamps = raw ? JSON.parse(raw) : [];

  timestamps = timestamps.filter((t) => t > now - windowSec);
  if (timestamps.length >= maxReqs) return false;

  timestamps.push(now);
  await kv.put(key, JSON.stringify(timestamps), { expirationTtl: windowSec + 60 });
  return true;
}

// ── Base64 helpers ────────────────────────────────────────────────────────────
function b64Decode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
}
function b64ToBytes(str) {
  return Uint8Array.from(b64Decode(str), (c) => c.charCodeAt(0));
}

// ════════════════════════════════════════════════════════════════════════════
// WATCH MODE — port từ crawl_calendar.py _run_watch_mode() + lophoc_api.py
//
// ⚠️ QUAN TRỌNG: API lophoc KHÔNG trả Set-Cookie. Toàn bộ "cookie" là tự
// dựng từ field trong JSON response body rồi tự gắn vào header Cookie của
// các request sau — y hệt cách lophoc_api.py làm (session.cookies.set(...)).
// Auth có 2 lớp: sessionToken (UUID, từ verify-user) rồi roomToken (JWT,
// từ /api/auth/room-token, PHẢI lấy riêng cho từng code/learn_number
// TRƯỚC KHI gọi livestreamlink — thiếu bước này livestreamlink sẽ 401/403).
// ════════════════════════════════════════════════════════════════════════════

const VN_TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
const LOPHOC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** ms UTC → {date, time, nowMinutes} theo giờ VN (không dùng Intl — tốn CPU) */
function toVnParts(ms) {
  const d = new Date(ms + VN_TZ_OFFSET_MS);
  const iso = d.toISOString(); // đã lệch +7h nên các thành phần đọc bằng slice() ra đúng giờ VN
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    nowMinutes: parseInt(iso.slice(11, 13), 10) * 60 + parseInt(iso.slice(14, 16), 10),
  };
}

/** BASE_URL lophoc từ HM_BASE_URL — khớp lophoc_api.py: "https://X" → "https://lophoc.X" */
function lophocBaseUrl(env) {
  try {
    const u = new URL(env.HM_BASE_URL);
    return `${u.protocol}//lophoc.${u.host}`;
  } catch {
    return "";
  }
}

/** UTF-8-safe base64 (btoa thường chỉ chạy đúng với Latin1) */
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Dựng cookie "session_name_user" — base64 JSON — khớp
 * lophoc_api.py::_build_session_name_user(). Server đọc field này để biết
 * user + buổi học hiện tại (không có nó, nhiều endpoint trả 401/403).
 */
function buildSessionNameUser(phone, code = "", learnNumber = "0", lessonName = "", subject = "", classId = "") {
  const payload = {
    user: phone,
    username: phone,
    displayName: phone,
    email: phone,
    role: "student",
    exp: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    current_lesson: {
      code,
      learn_number: String(learnNumber),
      name: lessonName || phone,
      subject,
      class_id: classId,
    },
  };
  return utf8ToB64(JSON.stringify(payload));
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * [Phase 1] Redact secret-looking substrings (token/password/session/cookie/jwt)
 * trước khi log response body lỗi — tránh leak secret vào Cloudflare log.
 */
function redactBody(body) {
  return String(body).replace(/(token|password|session|cookie|jwt)[^,&}"]*/gi, "$1=***");
}

/** [Phase 1] Timeout cho mỗi fetch lophoc — Free plan wall-time 30s, chừa time cho các bước sau */
const LOPHOC_FETCH_TIMEOUT_MS = 8000;

/**
 * Login lophoc bằng password — POST /api/auth/verify-user.
 * KHÔNG có Set-Cookie — sessionToken (UUID) nằm trong JSON body, ta tự
 * dựng cookie jar từ đó (khớp lophoc_api.py::_set_post_login_cookies).
 * Trả về object cookies {name: value} ban đầu (chưa có room-token).
 */
async function lophocLogin(env) {
  const base = lophocBaseUrl(env);
  const r = await fetch(`${base}/api/auth/verify-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": base,
      "Referer": `${base}/login`,
      "User-Agent": LOPHOC_UA,
    },
    body: JSON.stringify({ user: env.HM_USERNAME, password: env.HM_PASSWORD }),
    signal: AbortSignal.timeout(LOPHOC_FETCH_TIMEOUT_MS),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.log(`[lophocLogin] ${r.status} body=${redactBody(txt).slice(0, 300)}`);
    throw new Error(`lophoc login HTTP ${r.status}`);
  }
  const data = await r.json();
  if (!data.success) throw new Error(`lophoc login failed: ${JSON.stringify(data).slice(0, 200)}`);

  const sessionToken = data.sessionToken;
  const username = env.HM_USERNAME;
  return {
    _user_session_token: sessionToken,
    _user_identifier: username,
    user_login_input: username,
    session_name_user: buildSessionNameUser(username),
  };
}

/**
 * Lấy roomToken (JWT) cho 1 buổi học cụ thể — POST /api/auth/room-token.
 * BẮT BUỘC gọi trước livestreamlink cho mỗi code/learn_number mới, nếu
 * không sẽ bị 401/403 (đây là bước cả 2 bản port trước đó đều thiếu).
 * Trả về cookies object đã cập nhật (_user_session_token giờ là JWT).
 */
async function lophocRoomToken(env, cookies, code, learnNumber) {
  const base = lophocBaseUrl(env);
  const username = env.HM_USERNAME;
  const r = await fetch(`${base}/api/auth/room-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": base,
      "Referer": `${base}/schedule`,
      "User-Agent": LOPHOC_UA,
      "Cookie": cookieHeader(cookies),
    },
    body: JSON.stringify({ user: username, code, learn_number: learnNumber }),
    signal: AbortSignal.timeout(LOPHOC_FETCH_TIMEOUT_MS),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.log(`[lophocRoomToken] ${r.status} body=${redactBody(txt).slice(0, 300)}`);
    // [Phase 1 fix] Trước đây lỗi này KHÔNG gắn cờ authError → ensureM3u8()
    // không bao giờ retry khi chính room-token (chứ không phải livestreamlink)
    // trả 401/403 — đây là nguyên nhân của log "room-token HTTP 403" ngày 16/7
    // không được retry. Gắn cờ giống lophocGetM3u8() để dùng chung 1 cơ chế retry.
    const e = new Error(`room-token HTTP ${r.status}`);
    if (r.status === 401 || r.status === 403) e.authError = true;
    throw e;
  }
  const data = await r.json();
  if (!data.success) throw new Error(`room-token failed: ${JSON.stringify(data).slice(0, 200)}`);

  const roomToken = data.roomToken;
  const lesson = data.lesson || {};
  return {
    ...cookies,
    _user_session_token: roomToken,
    _class_room_code: code,
    _learn_number: String(learnNumber),
    session_name_user: buildSessionNameUser(
      username, code, String(learnNumber), lesson.lesson_name || "", lesson.subject || ""
    ),
  };
}

/** POST /api/calendar/ — danh sách buổi học (cần sessionToken, chưa cần roomToken) */
async function lophocGetCalendar(env, cookies) {
  const base = lophocBaseUrl(env);
  const r = await fetch(`${base}/api/calendar/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": base,
      "Referer": `${base}/schedule`,
      "User-Agent": LOPHOC_UA,
      "Cookie": cookieHeader(cookies),
    },
    body: JSON.stringify({ user: env.HM_USERNAME }),
    signal: AbortSignal.timeout(LOPHOC_FETCH_TIMEOUT_MS),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.log(`[lophocGetCalendar] ${r.status} body=${redactBody(txt).slice(0, 300)}`);
    throw new Error(`lophoc calendar HTTP ${r.status}`);
  }
  const data = await r.json();
  if (!data.success) return [];
  return data.calendar || [];
}

/**
 * POST /api/livestreamlink — lấy m3u8. Field top-level là "status" (không
 * phải "success"); field URL là "streamkey" — khớp lophoc_api.py.
 * Cookies TRUYỀN VÀO phải đã qua lophocRoomToken() cho đúng code này.
 */
async function lophocGetM3u8(env, cookies, code, learnNumber) {
  const base = lophocBaseUrl(env);
  const roomB64 = utf8ToB64(`${code}-${learnNumber}`);
  const r = await fetch(`${base}/api/livestreamlink`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": base,
      "Referer": `${base}/room/${roomB64}`,
      "User-Agent": LOPHOC_UA,
      "Cookie": cookieHeader(cookies),
    },
    body: JSON.stringify({ code, learn_number: learnNumber }),
    signal: AbortSignal.timeout(LOPHOC_FETCH_TIMEOUT_MS),
  });
  if (r.status === 401 || r.status === 403) {
    const txt = await r.text().catch(() => "");
    console.log(`[lophocGetM3u8] ${r.status} body=${redactBody(txt).slice(0, 300)}`);
    const e = new Error(`livestreamlink HTTP ${r.status}`);
    e.authError = true;
    throw e;
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.log(`[lophocGetM3u8] ${r.status} body=${redactBody(txt).slice(0, 300)}`);
    throw new Error(`livestreamlink HTTP ${r.status}`);
  }
  const data = await r.json();
  if (!data.status) return null;
  return data.data?.[0]?.streamkey || null;
}

/** Check CDN trực tiếp (HEAD, fallback GET nếu 405) — Referer/Origin cố định theo hocmai.vn, khớp crawl_calendar.py */
async function checkCdnLive(m3u8Url) {
  try {
    const r = await fetch(m3u8Url, {
      method: "HEAD",
      headers: { "Referer": "https://lophoc.hocmai.vn/", "Origin": "https://lophoc.hocmai.vn", "User-Agent": LOPHOC_UA },
    });
    if (r.status === 405) {
      const r2 = await fetch(m3u8Url, {
        method: "GET",
        headers: { "Referer": "https://lophoc.hocmai.vn/", "Origin": "https://lophoc.hocmai.vn", "User-Agent": LOPHOC_UA },
      });
      r2.body?.cancel();
      return r2.status === 200;
    }
    return r.status === 200;
  } catch {
    return false;
  }
}

/**
 * Lấy m3u8 cho 1 event: đảm bảo roomToken đúng code, gọi livestreamlink,
 * tự retry 1 lần (re-login + room-token lại) nếu 401/403 — khớp
 * LophocClient.get_m3u8() trong lophoc_api.py.
 */
async function ensureM3u8(env, session, code, learnNumber) {
  try {
    if (session.currentCode !== code) {
      session.cookies = await lophocRoomToken(env, session.cookies, code, learnNumber);
      session.currentCode = code;
    }
    return await lophocGetM3u8(env, session.cookies, code, learnNumber);
  } catch (e) {
    if (!e.authError || session.retried) throw e;
    session.retried = true;
    session.cookies = await lophocLogin(env);
    session.cookies = await lophocRoomToken(env, session.cookies, code, learnNumber);
    session.currentCode = code;
    return await lophocGetM3u8(env, session.cookies, code, learnNumber);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// WATCH MODE MAIN — chỉ login lophoc khi có target event (tiết kiệm CPU/request)
// ════════════════════════════════════════════════════════════════════════════
async function watchModeJob(env) {
  const nowMs = Date.now();
  const vn = toVnParts(nowMs);
  console.log(`[watchMode] ${vn.date}T${vn.time} VN`);

  let scheduleDoc;
  try {
    scheduleDoc = await firestoreGet(env, "app_data/schedule");
  } catch (e) {
    console.error("[watchMode] read schedule error:", e.message);
    return;
  }
  if (!scheduleDoc?.fields?.json?.stringValue) {
    console.log("[watchMode] no schedule");
    return;
  }

  let schedule;
  try {
    schedule = JSON.parse(scheduleDoc.fields.json.stringValue);
  } catch {
    console.error("[watchMode] schedule parse error");
    return;
  }
  const events = schedule.events || [];
  const todayStr = vn.date;
  const nowMinutes = vn.nowMinutes;

  // Lọc target events: hôm nay, trong cửa sổ [-30, +60] phút quanh giờ học
  const targetEvents = events.filter((ev) => {
    if (ev.date !== todayStr) return false;
    const t = ev.time || "00:00";
    const h = parseInt(t.slice(0, 2), 10);
    const m = parseInt(t.slice(3, 5), 10);
    if (isNaN(h) || isNaN(m)) return false;
    const evMin = h * 60 + m;
    return -30 <= nowMinutes - evMin && nowMinutes - evMin <= 60;
  });

  let changed = false;

  if (targetEvents.length > 0) {
    console.log(`[watchMode] ${targetEvents.length} target event(s)`);
    const session = { cookies: null, currentCode: null, retried: false };
    let lophocLessons = [];
    try {
      session.cookies = await lophocLogin(env);
      lophocLessons = await lophocGetCalendar(env, session.cookies);
    } catch (e) {
      console.error("[watchMode] lophoc login/calendar error:", e.message);
      lophocLessons = [];
    }

    const lophocIdx = new Map();
    for (const lesson of lophocLessons) {
      lophocIdx.set(`${lesson.subject}|${lesson.lesson_name}`, lesson);
    }

    for (const ev of targetEvents) {
      const lesson = lophocIdx.get(`${ev.subject}|${ev.title}`);
      if (!lesson) {
        console.log(`[watchMode] no lophoc match: ${ev.subject} — ${ev.title}`);
        continue;
      }
      const code = lesson.code || "";
      const learnNumber = lesson.learn_number || 0;

      let m3u8;
      try {
        m3u8 = await ensureM3u8(env, session, code, learnNumber);
      } catch (e) {
        console.error(`[watchMode] getM3u8 error for ${ev.title}:`, e.message);
        continue;
      }
      if (!m3u8) continue;

      const oldM3u8 = ev.m3u8;
      const linkChanged = oldM3u8 && m3u8 !== oldM3u8;
      if (!oldM3u8 || linkChanged) {
        for (const mainEv of events) {
          if (mainEv.date === ev.date && mainEv.subject === ev.subject && mainEv.title === ev.title) {
            mainEv.m3u8 = m3u8;
            mainEv.status = "live";
            mainEv.code = code;
            mainEv.learn_number = learnNumber;
            if (!mainEv.liveStartEpoch) mainEv.liveStartEpoch = nowMs;
            changed = true;
            console.log(`[watchMode] set live: ${ev.subject} — ${ev.title}`);
            // [Phase 2] Tự tạo session_clicks/{sid} + gửi "Link mới" — không
            // còn phụ thuộc GitHub Action send_push.py phải chạy đúng lúc.
            await handleNewM3u8(env, mainEv, m3u8).catch((e) =>
              console.error(`[watchMode] handleNewM3u8 fail for ${mainEv.title}:`, e.message)
            );
            break;
          }
        }
      }
    }
  } else {
    console.log("[watchMode] no target events in window");
  }

  // Cleanup: clear m3u8 cho event đã quá 60 phút mà CDN không còn trả 200
  // (fix bug "live chạy mãi" — port bonus, không có trong crawl_calendar.py gốc)
  for (const ev of events) {
    if (!ev.m3u8 || ev.date !== todayStr) continue;
    const h = parseInt((ev.time || "00:00").slice(0, 2), 10);
    const m = parseInt((ev.time || "00:00").slice(3, 5), 10);
    if (isNaN(h) || isNaN(m)) continue;
    const evMin = h * 60 + m;
    if (nowMinutes - evMin > 60) {
      const stillLive = await checkCdnLive(ev.m3u8);
      if (!stillLive) {
        ev.m3u8 = null;
        ev.status = "past";
        ev.liveStartEpoch = null;
        changed = true;
        console.log(`[watchMode] clear ended: ${ev.subject} — ${ev.title} (CDN không còn live)`);
      }
    }
  }

  if (changed) {
    schedule.events = events;
    schedule.lastUpdated = new Date(nowMs).toISOString();
    try {
      await firestorePatch(env, "app_data/schedule", {
        json: { stringValue: JSON.stringify(schedule) },
        updatedAt: { stringValue: schedule.lastUpdated },
      }, true);
      console.log("[watchMode] schedule updated");
    } catch (e) {
      console.error("[watchMode] write schedule error:", e.message);
    }
  } else {
    console.log("[watchMode] no changes");
  }
}
