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
let _tokenExpiry  = 0;

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
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

    // Route cũ: mọi POST còn lại → handleSyncDispatch (giữ nguyên 100%)
    return handleSyncDispatch(request, env);
  },

  // Phase 4 — Cron Trigger (sẽ uncomment sau khi bật Cron Trigger trên Dashboard)
  // async scheduled(event, env, ctx) {
  //   ctx.waitUntil(reminderJob(env));
  // },
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

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400, headers: corsH });
  }

  const { endpoint, keys, uid, email, deviceId, platform, userAgent } = body;
  if (!endpoint || !keys || !uid) {
    return new Response("Bad Request: missing endpoint/keys/uid", { status: 400, headers: corsH });
  }

  // Tính doc ID = sha1(endpoint).slice(0,32) bằng Web Crypto (không cần Node)
  const sid = await sha1Hex(endpoint);
  const docId = sid.slice(0, 32);

  const now = new Date().toISOString();
  const fields = {
    endpoint:    { stringValue: endpoint },
    p256dh:      { stringValue: keys.p256dh || "" },
    auth:        { stringValue: keys.auth    || "" },
    uid:         { stringValue: uid },
    email:       { stringValue: email || "" },
    deviceId:    { stringValue: deviceId || "" },
    platform:    { stringValue: platform || "" },
    userAgent:   { stringValue: (userAgent || "").slice(0, 200) },
    active:      { booleanValue: true },
    lastSeenAt:  { stringValue: now },
    createdAt:   { stringValue: now },
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

  try {
    await verifyFirebaseJWT(idToken, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    return new Response("Unauthorized", { status: 401, headers: corsH });
  }

  let body;
  try { body = await request.json(); } catch { return new Response("Bad Request", { status: 400, headers: corsH }); }

  const { endpoint } = body;
  if (!endpoint) return new Response("Bad Request: missing endpoint", { status: 400, headers: corsH });

  const sid = await sha1Hex(endpoint);
  const docId = sid.slice(0, 32);

  try {
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
  const user    = url.searchParams.get("user");
  const to      = url.searchParams.get("to");

  // Validate tham số
  if (!session || !to) {
    return new Response("Bad Request: missing session or to", { status: 400 });
  }
  // Whitelist: chỉ redirect tới https://
  let decodedTo;
  try {
    decodedTo = decodeURIComponent(to);
  } catch {
    return new Response("Bad Request: invalid 'to'", { status: 400 });
  }
  if (!decodedTo.startsWith("https://")) {
    return new Response("Bad Request: unsafe redirect target", { status: 400 });
  }

  // Ghi click vào Firestore (fire-and-forget, không chặn redirect)
  if (user) {
    const now = new Date().toISOString();
    const docPath = `session_clicks/${session}/users/${user}`;
    // Dùng waitUntil nếu có ctx, nếu không thì best-effort (không await)
    firestorePatch(env, docPath, {
      clicked:   { booleanValue: true },
      clickedAt: { stringValue: now },
    }, true).catch((e) => console.error("handleGo Firestore error:", e.message));
  }

  // Redirect 302 ngay lập tức
  return Response.redirect(decodedTo, 302);
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 4 — reminderJob (sẽ kích hoạt sau khi bật Cron Trigger)
// ════════════════════════════════════════════════════════════════════════════
// async function reminderJob(env) { ... }

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
  const header  = { alg: "RS256", typ: "JWT" };
  const jwtPayload = {
    iss:   client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };

  const headerB64  = b64url(JSON.stringify(header));
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
  _tokenExpiry  = now + (expires_in || 3600);
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

  const header  = JSON.parse(b64Decode(parts[0]));
  const payload = JSON.parse(b64Decode(parts[1]));

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now)       throw new Error("Token expired");
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