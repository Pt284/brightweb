// bg.js — Animated blob background, dùng chung toàn web
// Chỉ cần include file này là có nền động ở mọi trang

document.addEventListener('DOMContentLoaded', function () {
  (function () {
    const canvas = document.createElement('canvas');
    canvas.id = 'bg-canvas';
    canvas.style.cssText = `
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: -1;
    pointer-events: none;
  `;
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    let W, H;

    function resize() {
      W = canvas.width = window.innerWidth * devicePixelRatio;
      H = canvas.height = window.innerHeight * devicePixelRatio;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    }
    resize();
    window.addEventListener('resize', resize);

    function rand(a, b) { return a + Math.random() * (b - a); }

    const COLORS = [
      [3, 10, 28],
      [4, 14, 38],
      [5, 18, 48],
      [7, 28, 68],
      [9, 38, 88],
      [12, 52, 108],
      [16, 68, 130],
      [21, 82, 148],
    ];

    function hslToRgb(h, s, l) {
      s /= 100; l /= 100;
      const k = n => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
    }

    function makeBlob(forceEdge) {
      let x, y;
      if (forceEdge || Math.random() < 0.45) {
        const side = Math.floor(rand(0, 4));
        if (side === 0) { x = rand(-0.1, 1.1); y = rand(-0.2, 0.15); }
        else if (side === 1) { x = rand(0.85, 1.2); y = rand(-0.1, 1.1); }
        else if (side === 2) { x = rand(-0.1, 1.1); y = rand(0.85, 1.2); }
        else { x = rand(-0.2, 0.15); y = rand(-0.1, 1.1); }
      } else {
        x = rand(-0.1, 1.1);
        y = rand(-0.1, 1.1);
      }
      const cIdx = Math.floor(rand(0, COLORS.length));
      const isLight = cIdx >= 5;
      const r = isLight ? rand(0.28, 0.42) : rand(0.40, 0.70);
      const tAlpha = isLight ? rand(0.35, 0.60) : rand(0.60, 0.90);
      const angle = rand(0, Math.PI * 2);
      const spd = rand(0.00004, 0.00011);
      return {
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        r,
        color: COLORS[cIdx],
        alpha: 0,
        targetAlpha: tAlpha,
        fadeState: 'in',
        holdTimer: rand(500, 1400),
        fadeSpeed: rand(0.0015, 0.004),
        noiseT: rand(0, 100),
        noiseSpd: rand(0.0003, 0.0008),
      };
    }

    let speedMultiplier = 1;
    let isBlobActive = true;
    let currentBgColor = '#020810';
    let rafId = null;

    // FIX: trước đây canvas luôn khởi động với màu MẶC ĐỊNH (COLORS gốc + isBlobActive=true),
    // rồi đợi color-settings.js load xong mới áp lại theme đã lưu (~150ms sau) → gây
    // hiệu ứng nháy: nền động mặc định hiện ra một chút rồi mới đổi màu/tắt đi.
    // Giờ đọc thẳng theme đã lưu trong localStorage NGAY TỪ ĐẦU, trước khi vẽ khung hình
    // đầu tiên, để không còn khoảng hở nào hiện màu/trạng thái sai.
    const BASE_HUE = 215;
    const BASE_BLOB_HSL = { h: 209, s: 75, l: 33 };
    let savedTheme = null;
    try {
      const raw = localStorage.getItem('theme_settings');
      if (raw) savedTheme = JSON.parse(raw);
    } catch (e) { /* dùng mặc định nếu parse lỗi */ }

    if (savedTheme) {
      if (savedTheme.blobActive !== undefined) isBlobActive = savedTheme.blobActive;
      if (savedTheme.blobSpeed !== undefined) speedMultiplier = savedTheme.blobSpeed;
    }

    window.BlobController = {
      setPalette: function (hue) {
        const lightnessStops = [6, 8, 10, 15, 19, 24, 29, 33];
        const satMul = [1, 1, 1, 1, 1, 0.98, 0.96, 0.93];
        const hueShift = [0, 0, 0, -1, -2, -4, -7, -10];
        for (let i = 0; i < 8; i++) {
          const h = (hue + hueShift[i] + 360) % 360;
          const [r, g, b] = hslToRgb(h, 80 * satMul[i], lightnessStops[i]);
          // Mutate in-place — blob.color là reference đến COLORS[i],
          // replace bằng array mới thì blob đang sống không thấy thay đổi
          COLORS[i][0] = r; COLORS[i][1] = g; COLORS[i][2] = b;
        }
      },
      // Sinh palette từ HSL đầy đủ (user chọn màu sáng nhất = index 7, l≈33%)
      setPaletteFromHsl: function (h, s, l) {
        const lightnessStops = [6, 8, 10, 15, 19, 24, 29, 33];
        const satMul = [1, 1, 1, 1, 1, 0.98, 0.96, 0.93];
        const hueShift = [0, 0, 0, -1, -2, -4, -7, -10];
        const lScale = l / 33;
        const sScale = s / 81;
        for (let i = 0; i < 8; i++) {
          const hi = (h + hueShift[i] + 360) % 360;
          const [r, g, b] = hslToRgb(hi, 81 * sScale * satMul[i], lightnessStops[i] * lScale);
          COLORS[i][0] = r; COLORS[i][1] = g; COLORS[i][2] = b;
        }
      },
      setSpeed: function (mul) {
        speedMultiplier = mul;
      },
      toggle: function (active) {
        const wasInactive = !isBlobActive;
        isBlobActive = active;
        // Nếu bật lại thì khởi động lại loop
        if (wasInactive && active) {
          if (rafId) cancelAnimationFrame(rafId);
          draw();
        }
      },
      setBgColor: function (color) {
        currentBgColor = color;
      }
    };

    // Áp palette + màu nền đã lưu NGAY (nếu có), trước khung hình đầu tiên —
    // công thức giống hệt applyTheme()/applySettings() bên color-settings.js
    // để nhất quán, chỉ khác là chạy đồng bộ ngay tại đây thay vì đợi script kia.
    (function applySavedThemeImmediately() {
      const hue = savedTheme?.hue !== undefined ? savedTheme.hue : BASE_HUE;
      const blobHsl = savedTheme?.blobHsl || {
        h: Math.round(((BASE_BLOB_HSL.h + (hue - BASE_HUE)) % 360 + 360) % 360),
        s: BASE_BLOB_HSL.s,
        l: BASE_BLOB_HSL.l
      };
      window.BlobController.setPaletteFromHsl(blobHsl.h, blobHsl.s, blobHsl.l);

      if (savedTheme?.blobHsl) {
        const { h, s, l } = savedTheme.blobHsl;
        const darkL = Math.round(6 * (l / 33));
        const darkS = Math.round(81 * (s / 81));
        currentBgColor = `hsl(${(h + 360) % 360}, ${darkS}%, ${darkL}%)`;
      } else {
        // --color-bg gốc: h:213 s:78 l:4, dịch theo cùng deltaHue như applyTheme()
        const finalHue = Math.round(((213 + (hue - BASE_HUE)) % 360 + 360) % 360);
        currentBgColor = `hsla(${finalHue}, 78%, 4%, 1)`;
      }
    })();

    const blobs = Array.from({ length: 11 }, () => makeBlob(false));
    blobs.forEach((b, i) => {
      if (i < 6) {
        b.alpha = rand(0.1, b.targetAlpha);
        b.fadeState = Math.random() < 0.5 ? 'hold' : 'in';
        b.holdTimer = rand(200, 1200);
        b.x = rand(0, 1);
        b.y = rand(0, 1);
      }
    });

    function sn(t, seed) {
      return Math.sin(t * 1.0 + seed) * 0.5
        + Math.sin(t * 1.7 + seed * 2.1) * 0.3
        + Math.sin(t * 2.9 + seed * 0.7) * 0.2;
    }

    function updateBlob(b) {
      b.noiseT += b.noiseSpd * speedMultiplier;
      const nx = sn(b.noiseT, b.x * 10 + 1.0) * 0.000025;
      const ny = sn(b.noiseT, b.y * 10 + 4.5) * 0.000025;
      // Chỉ scale noise force, KHÔNG scale maxSpd theo multiplier để tránh double-scaling
      b.vx += nx; b.vy += ny;
      const maxSpd = 0.00113 * Math.max(0.1, speedMultiplier);
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (spd > maxSpd) { b.vx = b.vx / spd * maxSpd; b.vy = b.vy / spd * maxSpd; }
      b.x += b.vx; b.y += b.vy;

      if (b.fadeState === 'in') {
        b.alpha = Math.min(b.alpha + b.fadeSpeed, b.targetAlpha);
        if (b.alpha >= b.targetAlpha) b.fadeState = 'hold';
      } else if (b.fadeState === 'hold') {
        if (--b.holdTimer <= 0) b.fadeState = 'out';
      } else {
        b.alpha = Math.max(b.alpha - b.fadeSpeed * 0.8, 0);
        if (b.alpha <= 0) Object.assign(b, makeBlob(true));
      }
    }

    function draw() {
      ctx.fillStyle = currentBgColor;
      ctx.fillRect(0, 0, W, H);

      if (!isBlobActive) {
        // Dừng loop khi tắt animation — không tốn CPU
        rafId = null;
        return;
      }

      ctx.globalCompositeOperation = 'screen';

      for (const b of blobs) {
        updateBlob(b);
        if (b.alpha <= 0.01) continue;
        const cx = b.x * W, cy = b.y * H;
        const radius = b.r * Math.max(W, H);
        const [r, g, bl] = b.color;
        const a = b.alpha;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, `rgba(${r},${g},${bl},${a})`);
        grad.addColorStop(0.40, `rgba(${r},${g},${bl},${(a * 0.42).toFixed(3)})`);
        grad.addColorStop(0.72, `rgba(${r},${g},${bl},${(a * 0.10).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      ctx.globalCompositeOperation = 'source-over';
      rafId = requestAnimationFrame(draw);
    }

    draw();
  })();
}); // DOMContentLoaded