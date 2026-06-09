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
    W = canvas.width  = window.innerWidth  * devicePixelRatio;
    H = canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width  = window.innerWidth  + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  resize();
  window.addEventListener('resize', resize);

  function rand(a, b) { return a + Math.random() * (b - a); }

  const COLORS = [
    [3,  10, 28],
    [4,  14, 38],
    [5,  18, 48],
    [7,  28, 68],
    [9,  38, 88],
    [12, 52, 108],
    [16, 68, 130],
    [21, 82, 148],
  ];

  function makeBlob(forceEdge) {
    let x, y;
    if (forceEdge || Math.random() < 0.45) {
      const side = Math.floor(rand(0, 4));
      if      (side === 0) { x = rand(-0.1, 1.1); y = rand(-0.2,  0.15); }
      else if (side === 1) { x = rand( 0.85, 1.2); y = rand(-0.1,  1.1); }
      else if (side === 2) { x = rand(-0.1, 1.1); y = rand( 0.85, 1.2); }
      else                 { x = rand(-0.2, 0.15); y = rand(-0.1,  1.1); }
    } else {
      x = rand(-0.1, 1.1);
      y = rand(-0.1, 1.1);
    }
    const cIdx   = Math.floor(rand(0, COLORS.length));
    const isLight = cIdx >= 5;
    const r       = isLight ? rand(0.28, 0.42) : rand(0.40, 0.70);
    const tAlpha  = isLight ? rand(0.35, 0.60) : rand(0.60, 0.90);
    const angle   = rand(0, Math.PI * 2);
    const spd     = rand(0.00004, 0.00011);
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

  const blobs = Array.from({ length: 11 }, () => makeBlob(false));
  blobs.forEach((b, i) => {
    if (i < 6) {
      b.alpha      = rand(0.1, b.targetAlpha);
      b.fadeState  = Math.random() < 0.5 ? 'hold' : 'in';
      b.holdTimer  = rand(200, 1200);
      b.x          = rand(0, 1);
      b.y          = rand(0, 1);
    }
  });

  function sn(t, seed) {
    return Math.sin(t * 1.0 + seed)       * 0.5
         + Math.sin(t * 1.7 + seed * 2.1) * 0.3
         + Math.sin(t * 2.9 + seed * 0.7) * 0.2;
  }

  function updateBlob(b) {
    b.noiseT += b.noiseSpd;
    const nx = sn(b.noiseT, b.x * 10 + 1.0) * 0.000025;
    const ny = sn(b.noiseT, b.y * 10 + 4.5) * 0.000025;
    b.vx += nx; b.vy += ny;
    const maxSpd = 0.00113;
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
    ctx.fillStyle = '#020810';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';

    for (const b of blobs) {
      updateBlob(b);
      if (b.alpha <= 0.01) continue;
      const cx = b.x * W, cy = b.y * H;
      const radius = b.r * Math.max(W, H);
      const [r, g, bl] = b.color;
      const a = b.alpha;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0,    `rgba(${r},${g},${bl},${a})`);
      grad.addColorStop(0.40, `rgba(${r},${g},${bl},${(a*0.42).toFixed(3)})`);
      grad.addColorStop(0.72, `rgba(${r},${g},${bl},${(a*0.10).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(${r},${g},${bl},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(draw);
  }

  draw();
})();
}); // DOMContentLoaded
