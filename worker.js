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
    ctx.waitUntil(reminderJob(env));
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

async function reminderJob(env) {
  const now = Date.now();
  // Cửa sổ [now-30s, now+150s]: ~ T-90s ± 60s buffer
  // Mở rộng hơn [+60s, +120s] cũ → bắt kịp kể cả khi cron delay 30s
  // reminderSent=true đảm bảo không gửi trùng
  const windowStart = toFirestoreIso(now - 30_000);   // now - 30 giây
  const windowEnd = toFirestoreIso(now + 150_000);  // now + 150 giây

  console.log(`[reminderJob] Window: ${windowStart} → ${windowEnd}`);

  // 1. Query session_clicks trong cửa sổ thời gian
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

  // 2. Lọc session chưa được nhắc nhở
  const pending = sessions.filter(
    (s) => s.fields.reminderSent?.booleanValue !== true
  );

  if (pending.length === 0) {
    console.log("[reminderJob] No pending sessions");
    return;
  }

  // 3. Lấy toàn bộ subscription active
  let allSubDocs;
  try {
    allSubDocs = await firestoreListCollection(env, "push_subscriptions");
  } catch (e) {
    console.error("[reminderJob] list subs error:", e.message);
    return;
  }

  const activeSubs = allSubDocs
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

  if (activeSubs.length === 0) {
    console.log("[reminderJob] No active subscriptions");
    return;
  }

  // 4. Xử lý từng session
  for (const session of pending) {
    const sid = session.id;
    const fields = session.fields;
    const subject = fields.subject?.stringValue || "Lịch học";
    const title = fields.title?.stringValue || "";
    const realLink = fields.realLink?.stringValue || "";

    // Mark reminderSent = true TRƯỚC KHI gửi (tránh 2 cron chồng nhau gửi trùng)
    try {
      await firestorePatch(env, `session_clicks/${sid}`, {
        reminderSent: { booleanValue: true },
      }, true);
    } catch (e) {
      console.error(`[reminderJob] patch reminderSent error for ${sid}:`, e.message);
      continue;
    }

    // Lấy users chưa click
    let users;
    try {
      users = await firestoreListSubcollection(env, `session_clicks/${sid}/users`);
    } catch (e) {
      console.error(`[reminderJob] list users error for ${sid}:`, e.message);
      continue;
    }

    const pendingUids = new Set(
      users
        .filter((u) => u.fields?.clicked?.booleanValue !== true)
        .map((u) => u.id)
    );

    if (pendingUids.size === 0) {
      console.log(`[reminderJob] All users already clicked for ${sid}`);
      continue;
    }

    // Lọc subscription cho user chưa click
    const subsToNotify = activeSubs.filter((s) => pendingUids.has(s.uid));
    if (subsToNotify.length === 0) {
      console.log(`[reminderJob] No active subs for pending users of ${sid}`);
      continue;
    }

    console.log(`[reminderJob] ${sid}: ${subsToNotify.length} users, burst x3`);

    // Gửi 3 burst, tag khác nhau để iOS rung 3 lần
    for (let burst = 1; burst <= 3; burst++) {
      const nowIso = new Date().toISOString();
      for (const sub of subsToNotify) {
        const goUrl = (
          `${WORKER_SELF}/go`
          + `?session=${sid}`
          + `&user=${sub.uid}`
          + `&to=${encodeURIComponent(realLink)}`
        );
        const payload = JSON.stringify({
          title: `⏰ Sắp có lớp: ${subject}`,
          body: `${title ? title + " — " : ""}bắt đầu trong ~90 giây!`,
          url: goUrl,
          tag: `remind-${sid}-${burst}`,
          sessionId: sid,
        });

        try {
          const status = await sendWebPush(sub.endpoint, sub.p256dh, sub.auth, payload, env);
          console.log(`  [burst ${burst}] ${sub.email || sub.uid}: HTTP ${status}`);

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
          console.error(`  [burst ${burst}] error for ${sub.uid}:`, e.message);
        }
      }

      // Đợi 4 giây giữa các burst (trừ burst cuối)
      if (burst < 3) await sleep(4000);
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
async function sendWebPush(endpoint, p256dhB64, authB64, payloadStr, env) {
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
      "TTL": "3600",
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
