// push.js — Client-side Web Push subscription
// Loaded AFTER app.js (Firebase đã init, user đã sign in)
// Đặt tại /brightweb/push.js

(function () {
  "use strict";

  const BASE = "/brightweb";
  const WORKER_URL = "https://brightweb-sync.mcdg5444.workers.dev";
  // VAPID_PUBLIC_KEY sẽ được inject bởi workflow hoặc hardcode tạm ở đây
  // VAPID Public Key - khớp với private key mới
  const VAPID_PUBLIC_KEY = "BNNHPHF77kCtd0jDah4dF_ezdFEGf_O50pF9nmQpEkUGu9NcTjlsVp41rv3TJTyRxgt0Q96gOCEdrMkszuZuV9U";

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Chuyển VAPID public key từ base64url → Uint8Array (chuẩn Web Push API)
  function urlB64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  // Toast nhỏ gọn (không phụ thuộc app.js)
  function showToast(msg, isError = false) {
    let el = document.getElementById("push-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "push-toast";
      Object.assign(el.style, {
        position: "fixed",
        bottom: "80px",
        left: "50%",
        transform: "translateX(-50%)",
        background: isError ? "rgba(220,38,38,.92)" : "rgba(30,41,59,.95)",
        color: "#fff",
        padding: "10px 20px",
        borderRadius: "10px",
        fontSize: "14px",
        zIndex: "9999",
        pointerEvents: "none",
        transition: "opacity .3s",
        maxWidth: "90vw",
        textAlign: "center",
        boxShadow: "0 4px 20px rgba(0,0,0,.4)",
      });
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.opacity = "0"; }, 3500);
  }

  // Detect iOS
  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) || 
           (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  // Detect standalone (đã Add to Home Screen)
  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches ||
           window.navigator.standalone === true;
  }

  // Lấy Firebase ID token (firebase đã được init trong app.js)
  async function getIdToken() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("Chưa đăng nhập");
    return user.getIdToken();
  }

  // ── Modal hướng dẫn Add to Home Screen (iOS non-standalone) ───────────────
  function showAddToHomeModal() {
    const existing = document.getElementById("push-a2hs-modal");
    if (existing) { existing.style.display = "flex"; return; }

    const overlay = document.createElement("div");
    overlay.id = "push-a2hs-modal";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "10000",
      background: "rgba(0,0,0,.6)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      padding: "16px",
    });

    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "var(--color-surface-modal, #1e293b)",
      borderRadius: "16px",
      padding: "24px 20px",
      maxWidth: "380px",
      width: "100%",
      color: "var(--color-text-primary, #f1f5f9)",
      boxShadow: "0 -4px 40px rgba(0,0,0,.5)",
      position: "relative",
    });

    box.innerHTML = `
      <div style="font-size:28px;text-align:center;margin-bottom:12px">📲</div>
      <h3 style="margin:0 0 8px;font-size:17px;text-align:center">Thêm vào Màn hình chính</h3>
      <p style="margin:0 0 16px;font-size:14px;color:var(--color-text-muted,#94a3b8);line-height:1.5">
        Để nhận thông báo trên iPhone, bạn cần mở site trong Safari và thêm vào Màn hình chính trước.
      </p>
      <ol style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:2">
        <li>Bấm nút <strong>Chia sẻ</strong> <span style="font-size:16px">⎙</span> ở thanh dưới Safari</li>
        <li>Chọn <strong>"Thêm vào Màn hình chính"</strong></li>
        <li>Mở app từ icon trên màn hình chính</li>
        <li>Bấm 🔔 lại để bật thông báo</li>
      </ol>
      <button id="push-a2hs-close" style="
        width:100%;padding:12px;border-radius:10px;border:none;
        background:var(--color-accent,#6366f1);color:#fff;
        font-size:15px;cursor:pointer;font-weight:600;
      ">Đã hiểu</button>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.getElementById("push-a2hs-close").onclick = () => {
      overlay.style.display = "none";
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.style.display = "none";
    };
  }

  // ── Subscribe ──────────────────────────────────────────────────────────────
  async function subscribe() {
    const reg = await navigator.serviceWorker.ready;

    let subscription;
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    } catch (e) {
      console.warn("[push.js] Lỗi subscribe, nghi ngờ kẹt VAPID key cũ. Đang dọn dẹp và thử lại...", e);
      const oldSub = await reg.pushManager.getSubscription();
      if (oldSub) {
        await oldSub.unsubscribe(); // Xoá giấy phép cũ
      }
      // Thử xin lại giấy phép mới
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const subJson = subscription.toJSON();

    const user = firebase.auth().currentUser;
    const token = await user.getIdToken();

    const body = {
      endpoint: subJson.endpoint,
      keys: subJson.keys,
      uid: user.uid,
      email: user.email || "",
      deviceId: getDeviceId(),
      platform: isIOS() ? "ios" : "other",
      userAgent: navigator.userAgent.slice(0, 200),
    };

    const res = await fetch(`${WORKER_URL}/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Worker trả lỗi ${res.status}: ${text}`);
    }

    return subscription;
  }

  // ── Unsubscribe ────────────────────────────────────────────────────────────
  async function unsubscribe() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;

    const token = await getIdToken();
    await fetch(`${WORKER_URL}/push/unsubscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });

    await sub.unsubscribe();
  }

  // ── Device ID (stable per browser) ────────────────────────────────────────
  function getDeviceId() {
    let id = localStorage.getItem("push_device_id");
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      localStorage.setItem("push_device_id", id);
    }
    return id;
  }

  // ── Update button UI ───────────────────────────────────────────────────────
  function updateBtnState(btn, subscribed, loading = false) {
    if (loading) {
      btn.textContent = "⏳";
      btn.disabled = true;
      btn.title = "Đang xử lý...";
      return;
    }
    btn.disabled = false;
    if (subscribed) {
      btn.textContent = "🔔";
      btn.title = "Thông báo: BẬT — bấm để tắt";
      btn.style.opacity = "1";
      btn.style.filter = "";
    } else {
      btn.textContent = "🔕";
      btn.title = "Thông báo: TẮT — bấm để bật";
      btn.style.opacity = "0.55";
      btn.style.filter = "grayscale(0.5)";
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    // Kiểm tra trình duyệt hỗ trợ
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.log("[push.js] Trình duyệt không hỗ trợ Web Push");
      return;
    }

    // Tạo nút 🔔 trong header (đặt trước btn-calendar)
    const btnCalendar = document.getElementById("btn-calendar");
    if (!btnCalendar) {
      console.warn("[push.js] Không tìm thấy btn-calendar để đặt nút thông báo");
      return;
    }

    const btn = document.createElement("button");
    btn.id = "btn-notify";
    btn.className = "btn-icon";
    btn.title = "Thông báo";
    btn.textContent = "🔕";
    btn.style.opacity = "0.55";
    btn.style.filter = "grayscale(0.5)";
    btnCalendar.parentElement.insertBefore(btn, btnCalendar);

    // Đăng ký Service Worker
    let reg;
    try {
      reg = await navigator.serviceWorker.register(BASE + "/sw.js", {
        scope: BASE + "/",
      });
      console.log("[push.js] SW registered, scope:", reg.scope);
    } catch (e) {
      console.error("[push.js] SW register failed:", e);
      return;
    }

    // Kiểm tra trạng thái subscription hiện tại
    const existingSub = await reg.pushManager.getSubscription();
    updateBtnState(btn, !!existingSub);

    // ── Nút bấm ─────────────────────────────────────────────────────────────
    btn.addEventListener("click", async () => {
      // Chưa đăng nhập
      if (!firebase.auth().currentUser) {
        showToast("Vui lòng đăng nhập trước", true);
        return;
      }

      const currentSub = await reg.pushManager.getSubscription();

      // TẮT thông báo
      if (currentSub) {
        updateBtnState(btn, false, true);
        try {
          await unsubscribe();
          updateBtnState(btn, false);
          showToast("Đã tắt thông báo");
        } catch (e) {
          console.error("[push.js] unsubscribe error:", e);
          updateBtnState(btn, true);
          showToast("Lỗi khi tắt thông báo: " + e.message, true);
        }
        return;
      }

      // iOS chưa Add to Home Screen → hướng dẫn
      if (isIOS() && !isStandalone()) {
        showAddToHomeModal();
        return;
      }

      // Xin quyền notification
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        showToast("Bạn đã từ chối quyền thông báo. Vào Settings để bật lại.", true);
        return;
      }

      // BẬT thông báo
      updateBtnState(btn, false, true);
      try {
        await subscribe();
        updateBtnState(btn, true);
        showToast("✅ Đã bật thông báo!");
      } catch (e) {
        console.error("[push.js] subscribe error:", e);
        updateBtnState(btn, false);
        showToast("Lỗi khi bật thông báo: " + e.message, true);
      }
    });

    // Sync lại trạng thái nút và tự động sửa lỗi kẹt key (background update)
    firebase.auth().onAuthStateChanged(async (user) => {
      if (!user) {
        updateBtnState(btn, false);
      } else {
        let sub = await reg.pushManager.getSubscription();
        if (sub && sub.options && sub.options.applicationServerKey) {
          // So sánh key hiện tại đang dùng với key mới
          const currentKeyArray = new Uint8Array(sub.options.applicationServerKey);
          const expectedKeyArray = urlB64ToUint8Array(VAPID_PUBLIC_KEY);
          let isMatch = currentKeyArray.length === expectedKeyArray.length;
          if (isMatch) {
            for (let i = 0; i < currentKeyArray.length; i++) {
              if (currentKeyArray[i] !== expectedKeyArray[i]) {
                isMatch = false;
                break;
              }
            }
          }

          // Nếu lệch key → tự động huỷ cái cũ và cấp lại cái mới (âm thầm)
          if (!isMatch) {
            console.warn("[push.js] Phát hiện đang dùng VAPID key cũ. Đang tự động nâng cấp ngầm...");
            try {
              await sub.unsubscribe();
              sub = await subscribe();
              console.log("[push.js] ✅ Tự động nâng cấp VAPID key thành công!");
            } catch (e) {
              console.error("[push.js] ❌ Tự nâng cấp thất bại:", e);
              sub = null; // Hiện nút chuông gạch chéo để user tự bấm lại
            }
          }
        }
        updateBtnState(btn, !!sub);
      }
    });
  }

  // Khởi động sau khi DOM sẵn sàng
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // DOM đã ready (script load sau app.js có thể đã chạy xong)
    init();
  }
})();
