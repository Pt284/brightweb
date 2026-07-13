// sw.js — Service Worker cho HM-LEAKBASE Push Notifications
// Đặt tại /brightweb/sw.js, scope = /brightweb/

const SW_VERSION = "1.0.0";
const BASE = "/brightweb";

// ── Install & Activate ──────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  // Skip waiting để active ngay, không chờ tab cũ đóng
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim tất cả client ngay lập tức (không cần reload)
  event.waitUntil(self.clients.claim());
});

// ── Push Event ──────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.error("[SW] push data parse error:", e);
    return;
  }

  const title = data.title || "HM-LEAKBASE 😈";
  const body  = data.body  || "Có thông báo mới";
  const tag   = data.tag   || "hm-push-default";
  const url   = data.url   || (BASE + "/");

  const options = {
    body,
    tag,
    icon:  BASE + "/icons/icon-192.png",
    badge: BASE + "/icons/icon-192.png",
    // data truyền vào để notificationclick đọc được URL đích
    data: { url },
    // vibrate: pattern rung (Android)
    vibrate: [200, 100, 200],
    // renotify: true để iOS/Android rung lại kể cả cùng tag
    renotify: true,
    // requireInteraction: notification ở lại màn hình cho đến khi user bấm (Android)
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification Click ───────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : (BASE + "/");

  event.waitUntil(
    // Ưu tiên focus tab đang mở site, không mở tab mới thừa
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Tìm tab đang mở site của chúng ta
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin + BASE) && "focus" in client) {
          client.focus();
          // Điều hướng tab đang mở sang URL đích
          return client.navigate ? client.navigate(targetUrl) : undefined;
        }
      }
      // Nếu không có tab nào mở → mở tab mới
      return self.clients.openWindow(targetUrl);
    })
  );
});

// ── Notification Close ───────────────────────────────────────────────────────
self.addEventListener("notificationclose", (_event) => {
  // Có thể track analytics sau này nếu cần
});
