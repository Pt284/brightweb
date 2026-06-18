export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = `https://${env.GITHUB_OWNER}.github.io`;

    // Fix 3: bỏ localhost, bỏ credentials — chỉ cho phép đúng origin production
    // Fix M3: thêm Vary: Origin để CDN không cache sai response cho origin khác
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      // Đã xóa: "Access-Control-Allow-Credentials": "true"
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

      // Fix 6: Verify JWT cryptographically thay vì accounts:lookup
      let payload;
      try {
        payload = await verifyFirebaseJWT(idToken, env.FIREBASE_PROJECT_ID);
      } catch (e) {
        // Fix M2: log chi tiết nội bộ, trả về thông báo chung (tránh information disclosure)
        console.error("JWT verify failed:", e.message);
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }

      const email = payload.email;
      if (!email) {
        return new Response("Unauthorized: No email in token", { status: 401, headers: corsHeaders });
      }

      // Fix 4: Rate limiting — 3 lần sync / 5 phút / admin
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
  },
};

// ─────────────────────────────────────────────
// Fix 6: Verify Firebase JWT bằng Web Crypto API
// (không phụ thuộc accounts:lookup)
// ─────────────────────────────────────────────
async function verifyFirebaseJWT(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const header  = JSON.parse(b64Decode(parts[0]));
  const payload = JSON.parse(b64Decode(parts[1]));

  // Kiểm tra thời gian
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now)       throw new Error("Token expired");
  if (!payload.iat || payload.iat > now + 300) throw new Error("Token iat invalid");

  // Kiểm tra claims
  if (payload.iss !== `https://securetoken.google.com/${projectId}`)
    throw new Error("Invalid issuer");
  if (payload.aud !== projectId)
    throw new Error("Invalid audience");
  if (!payload.sub)
    throw new Error("Missing subject");

  // Lấy public keys Firebase (Cloudflare tự cache theo Cache-Control)
  const jwksRes = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    { cf: { cacheTtl: 3600, cacheEverything: true } }
  );
  if (!jwksRes.ok) throw new Error("Failed to fetch Firebase public keys");
  const { keys } = await jwksRes.json();

  const jwk = keys.find(k => k.kid === header.kid);
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

// ─────────────────────────────────────────────
// Fix 4: Rate limiting qua Cloudflare KV
// Cần tạo KV namespace "RATE_LIMIT_KV" và bind vào Worker
// ─────────────────────────────────────────────
async function checkRateLimit(kv, key, windowSec = 300, maxReqs = 3) {
  const now = Math.floor(Date.now() / 1000);
  const raw = await kv.get(key);
  let timestamps = raw ? JSON.parse(raw) : [];

  timestamps = timestamps.filter(t => t > now - windowSec);
  if (timestamps.length >= maxReqs) return false;

  timestamps.push(now);
  await kv.put(key, JSON.stringify(timestamps), { expirationTtl: windowSec + 60 });
  return true;
}

// ── Helpers ──
function b64Decode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
}
function b64ToBytes(str) {
  return Uint8Array.from(b64Decode(str), c => c.charCodeAt(0));
}