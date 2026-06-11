document.addEventListener('DOMContentLoaded', () => {
  const BASE_HUE = 215;

  const BASE_TOKENS = {
    // --- Backgrounds ---
    '--color-bg': { type: 'color', h: 213, s: 78, l: 4, a: 1 },
    '--color-bg-alt': { type: 'color', h: 222, s: 54, l: 20, a: 1 },
    // --- Surfaces ---
    '--color-surface': { type: 'color', h: 223, s: 52, l: 25, a: 1 },
    '--color-surface2': { type: 'color', h: 225, s: 52, l: 29, a: 1 },
    '--color-surface3': { type: 'color', h: 221, s: 53, l: 22, a: 1 },
    '--color-surface-modal': { type: 'color', h: 222, s: 54, l: 20, a: 0.8 },
    '--color-surface-overlay': { type: 'color', h: 214, s: 78, l: 4, a: 0.55 },
    // --- Border ---
    '--color-border': { type: 'color', h: 222, s: 45, l: 30, a: 1 },
    // --- Accents ---
    '--color-accent': { type: 'color', h: 203, s: 100, l: 46, a: 1 },
    '--color-accent-hover': { type: 'color', h: 203, s: 100, l: 38, a: 1 },
    '--color-accent-alpha': { type: 'color', h: 203, s: 100, l: 46, a: 0.12 },
    '--color-accent-text': { type: 'color', h: 201, s: 100, l: 69, a: 1 },
    // --- Typography ---
    '--color-text': { type: 'color', h: 214, s: 32, l: 91, a: 1 },
    '--color-text-muted': { type: 'color', h: 215, s: 25, l: 65, a: 1 },
    '--color-text-dim': { type: 'color', h: 213, s: 27, l: 84, a: 1 },
    // --- Progress ---
    '--progress-fill': { type: 'color', h: 210, s: 71, l: 54, a: 1 },
    // --- Shadows ---
    '--shadow-sm': { type: 'shadow', format: '0 2px 16px hsla({h}, {s}%, {l}%, {a})', h: 203, s: 100, l: 46, a: 0.2 },
    '--shadow-glass-hover': { type: 'shadow', format: '0 12px 40px hsla({h}, {s}%, {l}%, {a})', h: 203, s: 100, l: 46, a: 0.2 }
  };

  let currentSettings = {
    hue: 215,
    blobActive: true,
    blobSpeed: 1,
    glassActive: true
  };

  function applyTheme(newHue) {
    const deltaHue = newHue - BASE_HUE;
    
    for (const [token, data] of Object.entries(BASE_TOKENS)) {
      const finalHue = Math.round(((data.h + deltaHue) % 360 + 360) % 360);
      
      if (data.type === 'color') {
        document.documentElement.style.setProperty(
          token, 
          `hsla(${finalHue}, ${data.s}%, ${data.l}%, ${data.a})`
        );
      } else if (data.type === 'shadow') {
        const shadowString = data.format
          .replace('{h}', finalHue)
          .replace('{s}', data.s)
          .replace('{l}', data.l)
          .replace('{a}', data.a);
        document.documentElement.style.setProperty(token, shadowString);
      }
    }

    if (window.BlobController && window.BlobController.setPalette) {
      window.BlobController.setPalette(newHue);
    }
  }

  function applySettings(settings) {
    if (settings.hue !== undefined) {
      currentSettings.hue = settings.hue;
      applyTheme(settings.hue);
      const slider = document.getElementById('cs-hue-slider');
      if (slider) slider.value = settings.hue;
    }
    
    if (settings.blobActive !== undefined) {
      currentSettings.blobActive = settings.blobActive;
      if (window.BlobController) window.BlobController.toggle(settings.blobActive);
      const cb = document.getElementById('cs-blob-toggle');
      if (cb) cb.checked = settings.blobActive;
    }
    
    if (settings.blobSpeed !== undefined) {
      currentSettings.blobSpeed = settings.blobSpeed;
      if (window.BlobController) window.BlobController.setSpeed(settings.blobSpeed);
      const spd = document.getElementById('cs-speed-slider');
      if (spd) spd.value = settings.blobSpeed;
    }
    
    if (settings.glassActive !== undefined) {
      currentSettings.glassActive = settings.glassActive;
      if (!settings.glassActive) {
        document.body.classList.add('no-glass');
      } else {
        document.body.classList.remove('no-glass');
      }
      const cb = document.getElementById('cs-glass-toggle');
      if (cb) cb.checked = settings.glassActive;
    }
  }

  function saveSettings() {
    localStorage.setItem('theme_settings', JSON.stringify(currentSettings));
  }

  function loadSavedSettings() {
    const saved = localStorage.getItem('theme_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        applySettings(parsed);
      } catch(e) {}
    } else {
      applySettings(currentSettings); // apply defaults
    }
  }

  function injectUI() {
    const html = `
      <div id="color-settings-backdrop">
        <div id="color-settings-popup">
          <div class="cs-header">
            <h3>Cài đặt Giao diện</h3>
            <button class="cs-close-btn">&times;</button>
          </div>
          <div class="cs-body">
            <div class="cs-controls">
              <div class="cs-tabs">
                <button class="cs-tab-btn active" data-tab="tab-simple">Cơ bản</button>
                <button class="cs-tab-btn" data-tab="tab-advanced">Nâng cao</button>
              </div>
              
              <div id="tab-simple" class="cs-tab-content active">
                <div class="cs-form-group">
                  <label>Màu chủ đạo (Hue)</label>
                  <input type="range" id="cs-hue-slider" class="cs-hue-slider" min="0" max="360" value="215">
                </div>
                
                <div class="cs-form-group">
                  <label class="cs-toggle">
                    <input type="checkbox" id="cs-blob-toggle" checked>
                    Bật nền động (Blob Animation)
                  </label>
                </div>
                
                <div class="cs-form-group">
                  <label>Tốc độ nền</label>
                  <input type="range" id="cs-speed-slider" class="cs-range" min="0.1" max="3" step="0.1" value="1">
                </div>
                
                <div class="cs-form-group">
                  <label class="cs-toggle">
                    <input type="checkbox" id="cs-glass-toggle" checked>
                    Hiệu ứng kính mờ (Glassmorphism)
                  </label>
                </div>
              </div>
              
              <div id="tab-advanced" class="cs-tab-content">
                <p style="font-size: 0.85rem; color: var(--color-text-muted); margin-bottom: 16px;">
                  Chế độ này hiển thị danh sách các token CSS.
                </p>
                <div class="cs-token-grid" id="cs-token-grid"></div>
              </div>
            </div>
            
            <div class="cs-preview">
              <div class="cs-preview-content">
                <div class="sidebar glass" style="width: 100%; height: auto; min-height: 100px;">
                  <div class="sidebar-title">Giao diện mẫu</div>
                  <div class="tree-label active-lesson" style="margin-top: 10px;"><span class="icon">▶</span> Bài học đang xem</div>
                  <div class="tree-label"><span class="icon check">✓</span> Bài học đã xem</div>
                </div>
                
                <div class="course-card glass">
                  <h3>Ví dụ Khóa Học</h3>
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: 65%;"></div>
                  </div>
                  <div class="progress-label">Tiến độ: 65%</div>
                </div>
                
                <div style="display: flex; gap: 10px;">
                  <button class="btn btn-primary">Nút Primary</button>
                  <button class="btn btn-outline">Nút Outline</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', html);
    
    const grid = document.getElementById('cs-token-grid');
    for (const token of Object.keys(BASE_TOKENS)) {
      grid.innerHTML += \`
        <div class="cs-token-item">
          <div class="cs-token-color" style="background: var(\${token});"></div>
          \${token.replace('--color-', '').replace('--', '')}
        </div>
      \`;
    }

    document.querySelector('.cs-close-btn').addEventListener('click', () => {
      document.getElementById('color-settings-backdrop').classList.remove('open');
    });

    document.querySelectorAll('.cs-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.cs-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.cs-tab-content').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById(e.target.dataset.tab).classList.add('active');
      });
    });

    document.getElementById('cs-hue-slider').addEventListener('input', (e) => {
      applySettings({ hue: parseInt(e.target.value) });
      saveSettings();
    });

    document.getElementById('cs-blob-toggle').addEventListener('change', (e) => {
      applySettings({ blobActive: e.target.checked });
      saveSettings();
    });

    document.getElementById('cs-speed-slider').addEventListener('input', (e) => {
      applySettings({ blobSpeed: parseFloat(e.target.value) });
      saveSettings();
    });

    document.getElementById('cs-glass-toggle').addEventListener('change', (e) => {
      applySettings({ glassActive: e.target.checked });
      saveSettings();
    });
  }

  const headerRight = document.querySelector('.header-right');
  if (headerRight) {
    const btn = document.createElement('button');
    btn.className = 'btn-icon';
    btn.innerHTML = '🎨';
    btn.title = 'Cài đặt giao diện';
    btn.onclick = () => {
      document.getElementById('color-settings-backdrop').classList.add('open');
    };
    headerRight.prepend(btn);
  }

  injectUI();
  
  // Wait a small tick so bg.js logic attaches window.BlobController if it's late
  setTimeout(loadSavedSettings, 50);

  window.openColorSettings = () => {
    document.getElementById('color-settings-backdrop').classList.add('open');
  };
});
