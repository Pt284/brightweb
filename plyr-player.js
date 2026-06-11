// ── PLYR YOUTUBE PLAYER ──
// Thay thế iframe YouTube bằng Plyr với đầy đủ keyboard shortcuts

let plyrInstance = null;     // Plyr player hiện tại
let _holdSpaceTimer = null;  // Timer giữ phím Space → 2x
let _holdSpeedActive = false;
let _prevSpeed = 1;
let _holdIndicatorTimer = null;
let _playerReady = false;    // Cờ player đã sẵn sàng

// ── Khởi tạo Plyr cho YouTube ID ──
function initPlyr(youtubeId) {
  destroyPlyr(); // Dọn player cũ

  const vw = document.getElementById('video-wrap');
  const nv = document.getElementById('no-video');
  if (!youtubeId) { nv.style.display = 'flex'; return; }
  nv.style.display = 'none';

  // Tạo container
  const wrapper = document.createElement('div');
  wrapper.id = 'plyr-wrapper';
  wrapper.style.cssText = 'position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:10px;overflow:hidden;';

  // Phần tử video cho Plyr
  const div = document.createElement('div');
  div.id = 'plyr-target';
  div.setAttribute('data-plyr-provider', 'youtube');
  div.setAttribute('data-plyr-embed-id', youtubeId);
  wrapper.appendChild(div);

  // Overlay chặn YouTube UI (pointer-events ở mức iframe)
  const overlay = document.createElement('div');
  overlay.id = 'yt-block-overlay';
  overlay.title = 'Dùng các nút điều khiển bên dưới';
  overlay.style.cssText = [
    'position:absolute', 'inset:0', 'z-index:10',
    'background:transparent', 'cursor:default',
    // Chỉ chặn phần trên (YouTube logo, title, controls) — phần giữa cần click play
    'pointer-events:none',
  ].join(';');
  wrapper.appendChild(overlay);

  // Indicator 2x speed
  const ind = document.createElement('div');
  ind.id = 'speed-indicator';
  ind.textContent = '⚡ 2×';
  ind.style.cssText = [
    'position:absolute', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
    'background:rgba(0,0,0,0.72)', 'color:#fff', 'font-size:14px', 'font-weight:700',
    'padding:4px 14px', 'border-radius:20px', 'letter-spacing:1px',
    'z-index:20', 'display:none', 'pointer-events:none',
    'backdrop-filter:blur(4px)',
  ].join(';');
  wrapper.appendChild(ind);

  vw.appendChild(wrapper);

  // Khởi tạo Plyr
  plyrInstance = new Plyr('#plyr-target', {
    controls: [
      'restart', 'rewind', 'play', 'fast-forward',
      'progress', 'current-time', 'duration',
      'mute', 'volume', 'captions',
      'settings', 'pip', 'fullscreen'
    ],
    settings: ['captions', 'quality', 'speed'],
    speed: {
      selected: 1,
      options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
    },
    seekTime: 10,
    keyboard: { focused: false, global: false }, // tắt Plyr keyboard, dùng custom
    tooltips: { controls: true, seek: true },
    youtube: {
      noCookie: false,
      rel: 0,
      showinfo: 0,
      iv_load_policy: 3,
      modestbranding: 1,
      disablekb: 1,    // tắt keyboard YouTube
      controls: 0,     // ẩn controls YouTube
      enablejsapi: 1,
    },
    i18n: {
      restart: 'Phát lại từ đầu',
      rewind: 'Quay lại {seektime}s',
      play: 'Phát',
      pause: 'Tạm dừng',
      fastForward: 'Tua nhanh {seektime}s',
      seek: 'Tua',
      seekLabel: '{currentTime} / {duration}',
      played: 'Đã phát',
      buffered: 'Đã tải',
      currentTime: 'Thời gian hiện tại',
      duration: 'Thời lượng',
      volume: 'Âm lượng',
      mute: 'Tắt tiếng',
      unmute: 'Bật tiếng',
      enableCaptions: 'Bật phụ đề',
      disableCaptions: 'Tắt phụ đề',
      download: 'Tải xuống',
      enterFullscreen: 'Toàn màn hình',
      exitFullscreen: 'Thoát toàn màn hình',
      frameTitle: 'Video: {title}',
      captions: 'Phụ đề',
      settings: 'Cài đặt',
      pip: 'PIP',
      menuBack: 'Quay lại',
      speed: 'Tốc độ',
      normal: 'Bình thường',
      quality: 'Chất lượng',
      loop: 'Lặp',
    }
  });

  _playerReady = false;
  let hasAutoSeeked = false;

  plyrInstance.on('ready', () => {
    _playerReady = true;
    setupPlyrOverlay();
    
    // Tự động tua đến thời gian đã lưu và play
    if (typeof getLocalProgress === 'function' && typeof currentLessonId !== 'undefined') {
      const saved = getLocalProgress(currentLessonId);
      if (saved && saved.watchedTime > 0 && !hasAutoSeeked) {
        hasAutoSeeked = true;
        safeSeek(saved.watchedTime);
      }
    }
    try { plyrInstance.play(); } catch(e) {}
  });

  // Lưu thời gian xem mỗi 5 giây
  let lastSavedTime = 0;
  plyrInstance.on('timeupdate', () => {
    if (!_playerReady || !plyrInstance) return;
    const t = plyrInstance.currentTime;
    const d = plyrInstance.duration;
    if (Math.abs(t - lastSavedTime) > 5 && typeof saveLocalProgress === 'function' && typeof currentLessonId !== 'undefined') {
      lastSavedTime = t;
      saveLocalProgress(currentLessonId, t, d);
    }
  });

  // Keyboard shortcuts
  setupKeyboardShortcuts();
}

// ── Hủy Plyr cũ ──
function destroyPlyr() {
  _playerReady = false;
  if (plyrInstance) {
    try { 
      plyrInstance.stop();
      plyrInstance.destroy(); 
    } catch(e) {}
    plyrInstance = null;
  }
  removeKeyboardShortcuts();
  const old = document.getElementById('plyr-wrapper');
  if (old) {
    // Ép iframe dừng hẳn (xoá src) trước khi xóa khỏi DOM để tránh chạy nền
    const ifr = old.querySelector('iframe');
    if (ifr) ifr.src = '';
    old.remove();
  }
  clearHoldSpace();
}

// ── Overlay chặn YouTube UI ──
function setupPlyrOverlay() {
  // Sau khi Plyr render xong, tìm iframe YouTube và đặt overlay đúng vị trí
  const wrapper = document.getElementById('plyr-wrapper');
  if (!wrapper) return;

  // Lắng nghe click vào giữa video → play/pause (overlay dưới controls Plyr)
  const plyrEl = wrapper.querySelector('.plyr');
  if (plyrEl) {
    // Chỉ chặn click vào YouTube controls (bottom bar của iframe)
    // Overlay trong suốt toàn màn, pointer-events:none để Plyr controls vẫn hoạt động
    const ov = document.getElementById('yt-block-overlay');
    if (ov) {
      // Bật pointer-events TRÊN iframe nhưng bên dưới .plyr__controls
      ov.style.pointerEvents = 'none'; // Plyr tự xử lý, không cần chặn thêm
    }
  }
}

// Đã xóa setupSpeedSliderUI() vì sẽ dùng menu gốc của Plyr

// ── Safe seek (tránh bug tua khi paused) ──
function safeSeek(targetTime) {
  if (!plyrInstance || !_playerReady) return;
  const dur = plyrInstance.duration;
  if (!dur || isNaN(dur) || dur <= 0) return;
  const t = Math.max(0, Math.min(dur, targetTime));
  try { plyrInstance.currentTime = t; } catch(e) {}
}

function safeGetTime() {
  if (!plyrInstance || !_playerReady) return 0;
  try {
    const t = plyrInstance.currentTime;
    return (isNaN(t) || t < 0) ? 0 : t;
  } catch(e) { return 0; }
}

// ── Hold Space = 2× speed ──
function showSpeedIndicator(show) {
  const ind = document.getElementById('speed-indicator');
  if (!ind) return;
  clearTimeout(_holdIndicatorTimer);
  if (show) {
    ind.style.display = 'block';
  } else {
    ind.style.display = 'none';
  }
}

function startHoldSpace() {
  if (_holdSpeedActive || !plyrInstance || !_playerReady) return;
  _holdSpaceTimer = setTimeout(() => {
    _holdSpeedActive = true;
    _prevSpeed = plyrInstance.speed || 1;
    try { plyrInstance.speed = 2; } catch(e) {}
    showSpeedIndicator(true);
  }, 400); // giữ 400ms mới kích hoạt
}

function endHoldSpace() {
  clearTimeout(_holdSpaceTimer);
  _holdSpaceTimer = null;
  if (_holdSpeedActive) {
    _holdSpeedActive = false;
    try { if (plyrInstance && _playerReady) plyrInstance.speed = _prevSpeed; } catch(e) {}
    showSpeedIndicator(false);
  }
}

function clearHoldSpace() {
  clearTimeout(_holdSpaceTimer);
  clearTimeout(_holdIndicatorTimer);
  _holdSpaceTimer = null;
  _holdSpeedActive = false;
}

// ── Volume helpers ──
function changeVolume(delta) {
  if (!plyrInstance || !_playerReady) return;
  const v = Math.max(0, Math.min(1, (plyrInstance.volume || 0) + delta));
  try { plyrInstance.volume = v; } catch(e) {}
}

// ── Keyboard handler ──
let _keyHandlerFn = null;
let _keyUpHandlerFn = null;

function setupKeyboardShortcuts() {
  removeKeyboardShortcuts();

  _keyHandlerFn = function(e) {
    // Không bắt phím khi đang gõ trong input/textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Chỉ bắt khi đang ở trang lesson
    if (!document.getElementById('page-lesson')?.classList.contains('active')) return;
    if (!plyrInstance || !_playerReady) return;

    const key = e.key;
    let handled = true;

    switch (key) {
      // Play / Pause
      case ' ':
      case 'k':
      case 'K':
        if (key === ' ') startHoldSpace();
        else plyrInstance.togglePlay();
        break;

      // -10s / +10s
      case 'j':
      case 'J':
        safeSeek(safeGetTime() - 10);
        break;
      case 'l':
      case 'L':
        safeSeek(safeGetTime() + 10);
        break;

      // ←/→ -5s / +5s
      case 'ArrowLeft':
        safeSeek(safeGetTime() - 5);
        break;
      case 'ArrowRight':
        safeSeek(safeGetTime() + 5);
        break;

      // ↑/↓ volume
      case 'ArrowUp':
        changeVolume(0.05);
        break;
      case 'ArrowDown':
        changeVolume(-0.05);
        break;

      // Mute
      case 'm':
      case 'M':
        try { plyrInstance.muted = !plyrInstance.muted; } catch(e) {}
        break;

      // Fullscreen
      case 'f':
      case 'F':
        try { plyrInstance.fullscreen.toggle(); } catch(e) {}
        break;

      // Captions
      case 'c':
      case 'C':
        try { plyrInstance.toggleCaptions(); } catch(e) {}
        break;

      // Home / End
      case 'Home':
        safeSeek(0);
        break;
      case 'End':
        safeSeek(plyrInstance.duration || 0);
        break;

      // 0–9 → nhảy tới % video
      default:
        if (/^[0-9]$/.test(key)) {
          const pct = parseInt(key) / 10;
          const dur = plyrInstance.duration;
          if (dur && !isNaN(dur)) safeSeek(dur * pct);
        } else {
          handled = false;
        }
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  _keyUpHandlerFn = function(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!document.getElementById('page-lesson')?.classList.contains('active')) return;

    if (e.key === ' ') {
      const wasHolding = _holdSpeedActive;
      endHoldSpace();
      // Nếu không phải hold → toggle play/pause bình thường
      if (!wasHolding) {
        if (plyrInstance && _playerReady) plyrInstance.togglePlay();
      }
      e.preventDefault();
      e.stopPropagation();
    }
  };

  document.addEventListener('keydown', _keyHandlerFn, true);
  document.addEventListener('keyup', _keyUpHandlerFn, true);
}

function removeKeyboardShortcuts() {
  if (_keyHandlerFn) {
    document.removeEventListener('keydown', _keyHandlerFn, true);
    _keyHandlerFn = null;
  }
  if (_keyUpHandlerFn) {
    document.removeEventListener('keyup', _keyUpHandlerFn, true);
    _keyUpHandlerFn = null;
  }
}
