document.addEventListener('DOMContentLoaded', () => {
  const BASE_HUE = 215;

  // Base blob color: màu sáng nhất trong COLORS gốc = [21,82,148] ≈ HSL(209,75,33)
  // User có thể override qua color picker
  const BASE_BLOB_HSL = { h: 209, s: 75, l: 33 };

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

  // Token overrides from Advanced tab (lưu màu hex từng token riêng)
  let tokenOverrides = {};

  let currentSettings = {
    hue: 215,
    blobActive: true,
    blobSpeed: 1,
    glassActive: true,
    blobHsl: null,      // null = tự tính từ hue, or { h, s, l }
    tokenOverrides: {}
  };

  // --- Helper: hex → hsl ---
  function hexToHsl(hex) {
    let r = parseInt(hex.slice(1, 3), 16) / 255;
    let g = parseInt(hex.slice(3, 5), 16) / 255;
    let b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  // --- Helper: hsl → hex (for color input value) ---
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // --- Blob palette sinh từ 1 màu (HSL) ---
  // User chọn màu sáng nhất (màu cuối) → sinh 8 màu tối dần
  function generateBlobPaletteFromHsl(h, s, l) {
    const lightnessStops = [6, 8, 10, 15, 19, 24, 29, 33];
    const satMul = [1, 1, 1, 1, 1, 0.98, 0.96, 0.93];
    const hueShift = [0, 0, 0, -1, -2, -4, -7, -10];
    // Normalize: l là lightness của màu sáng nhất (index 7 = 33%)
    // Scale các stops theo tỉ lệ l/33
    const lScale = l / 33;
    const sScale = s / 81;  // base s của palette gốc = 81
    return lightnessStops.map((ls, i) => ({
      h: Math.round(((h + hueShift[i]) % 360 + 360) % 360),
      s: Math.round(81 * sScale * satMul[i]),
      l: Math.round(ls * lScale)
    }));
  }

  function applyBlobPalette(blobHsl) {
    if (!window.BlobController) return;
    const { h, s, l } = blobHsl;
    // setPalette trong BlobController sẽ dùng thuật toán mới
    if (window.BlobController.setPaletteFromHsl) {
      window.BlobController.setPaletteFromHsl(h, s, l);
    } else {
      window.BlobController.setPalette(h);
    }
  }

  // FIX: trang lịch dùng backdrop-filter nhiều (.cal-grid-wrap) — một số trình duyệt
  // không tự repaint ngay khi đổi CSS custom property nếu phần tử đó chỉ đứng yên,
  // khiến màu lịch "kẹt" màu cũ tới khi reload. Ép render lại lịch (debounce nhẹ)
  // mỗi khi đổi theme trong lúc đang mở trang lịch để đảm bảo cập nhật ngay.
  let _calThemeRefreshTimer = null;
  function _refreshCalendarIfActive() {
    const calPage = document.getElementById('page-calendar');
    if (!calPage || !calPage.classList.contains('active')) return;
    if (typeof window.renderCalendar !== 'function') return;
    clearTimeout(_calThemeRefreshTimer);
    _calThemeRefreshTimer = setTimeout(() => { window.renderCalendar(); }, 120);
  }

  function applyTheme(newHue) {
    const deltaHue = newHue - BASE_HUE;
    let canvasBgHsl = null;

    for (const [token, data] of Object.entries(BASE_TOKENS)) {
      // Skip nếu token đã bị override thủ công ở Advanced tab
      if (tokenOverrides[token]) {
        document.documentElement.style.setProperty(token, tokenOverrides[token]);
        continue;
      }

      const finalHue = Math.round(((data.h + deltaHue) % 360 + 360) % 360);
      if (data.type === 'color') {
        const val = `hsla(${finalHue}, ${data.s}%, ${data.l}%, ${data.a})`;
        document.documentElement.style.setProperty(token, val);
        if (token === '--color-bg') canvasBgHsl = val;
      } else if (data.type === 'shadow') {
        const shadowStr = data.format
          .replace('{h}', finalHue).replace('{s}', data.s)
          .replace('{l}', data.l).replace('{a}', data.a);
        document.documentElement.style.setProperty(token, shadowStr);
      }
    }

    if (window.BlobController) {
      // Blob palette: dùng blobHsl nếu được set thủ công, không thì tính từ hue
      const blobHsl = currentSettings.blobHsl || {
        h: Math.round(((BASE_BLOB_HSL.h + (newHue - BASE_HUE)) % 360 + 360) % 360),
        s: BASE_BLOB_HSL.s,
        l: BASE_BLOB_HSL.l
      };
      applyBlobPalette(blobHsl);
      if (canvasBgHsl) window.BlobController.setBgColor(canvasBgHsl);
    }

    // Sync swatches trong Advanced tab nếu đang mở
    syncAdvancedSwatches(newHue);

    _refreshCalendarIfActive();
  }

  function syncAdvancedSwatches(newHue) {
    const deltaHue = (newHue || currentSettings.hue) - BASE_HUE;
    for (const [token, data] of Object.entries(BASE_TOKENS)) {
      const input = document.getElementById(`picker-${token}`);
      if (!input) continue;
      if (tokenOverrides[token]) {
        // Không đổi, đã bị override
        continue;
      }
      if (data.type === 'color') {
        const finalHue = Math.round(((data.h + deltaHue) % 360 + 360) % 360);
        input.value = hslToHex(finalHue, data.s, data.l);
      }
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
      if (spd) {
        spd.value = settings.blobSpeed;
        const pct = ((settings.blobSpeed - 0.1) / (3 - 0.1) * 100).toFixed(1) + '%';
        spd.style.setProperty('--pct', pct);
      }
    }
    if (settings.glassActive !== undefined) {
      currentSettings.glassActive = settings.glassActive;
      document.body.classList.toggle('no-glass', !settings.glassActive);
      const cb = document.getElementById('cs-glass-toggle');
      if (cb) cb.checked = settings.glassActive;
    }
    if (settings.blobHsl !== undefined) {
      currentSettings.blobHsl = settings.blobHsl;
      if (settings.blobHsl) {
        applyBlobPalette(settings.blobHsl);
        // Tự động tính --color-bg từ shade tối nhất của palette blob
        const { h, s, l } = settings.blobHsl;
        const darkL = Math.round(6 * (l / 33));
        const darkS = Math.round(81 * (s / 81));
        const bgVal = `hsl(${((h + 360) % 360)}, ${darkS}%, ${darkL}%)`;
        document.documentElement.style.setProperty('--color-bg', bgVal);
        if (window.BlobController) window.BlobController.setBgColor(bgVal);
        // Lock lại để hue slider không ghi đè --color-bg khi đang dùng blob color thủ công
        tokenOverrides['--color-bg'] = bgVal;
      }
      const blobPicker = document.getElementById('cs-blob-color');
      if (blobPicker && settings.blobHsl) {
        blobPicker.value = hslToHex(settings.blobHsl.h, settings.blobHsl.s, settings.blobHsl.l);
      }
    }
    if (settings.tokenOverrides !== undefined) {
      tokenOverrides = { ...settings.tokenOverrides };
      currentSettings.tokenOverrides = tokenOverrides;
      for (const [token, val] of Object.entries(tokenOverrides)) {
        document.documentElement.style.setProperty(token, val);
      }
    }
  }

  function resetToDefaults() {
    tokenOverrides = {};
    currentSettings = { hue: 215, blobActive: true, blobSpeed: 1, glassActive: true, blobHsl: null, tokenOverrides: {} };
    localStorage.removeItem('theme_settings');
    applySettings(currentSettings);
    applyTheme(215);
    // Reset các input
    const slider = document.getElementById('cs-hue-slider');
    if (slider) slider.value = 215;
    const blobPicker = document.getElementById('cs-blob-color');
    if (blobPicker) blobPicker.value = hslToHex(BASE_BLOB_HSL.h, BASE_BLOB_HSL.s, BASE_BLOB_HSL.l);
    syncAdvancedSwatches(215);
  }

  function saveSettings() {
    currentSettings.tokenOverrides = tokenOverrides;
    localStorage.setItem('theme_settings', JSON.stringify(currentSettings));
  }

  function loadSavedSettings() {
    const saved = localStorage.getItem('theme_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.tokenOverrides) tokenOverrides = parsed.tokenOverrides;
        applySettings(parsed);
      } catch (e) { }
    } else {
      applySettings(currentSettings);
    }
  }

  function injectUI() {
    const backdrop = document.createElement('div');
    backdrop.id = 'color-settings-backdrop';

    const popup = document.createElement('div');
    popup.id = 'color-settings-popup';
    popup.classList.add('glass'); // dùng chung hiệu ứng glass (blur+saturate) với sidebar/header/admin-panel

    // --- Header --- dùng glass giống admin-panel (theo yêu cầu)
    const header = document.createElement('div');
    header.className = 'cs-header glass';
    const h3 = document.createElement('h3');
    h3.textContent = 'Cài đặt Giao diện';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cs-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => backdrop.classList.remove('open'));
    header.appendChild(h3);
    header.appendChild(closeBtn);

    // --- Body ---
    const body = document.createElement('div');
    body.className = 'cs-body';

    // Controls panel
    const controls = document.createElement('div');
    controls.className = 'cs-controls';

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'cs-tabs';
    const tabSimpleBtn = document.createElement('button');
    tabSimpleBtn.className = 'cs-tab-btn active';
    tabSimpleBtn.dataset.tab = 'tab-simple';
    tabSimpleBtn.textContent = 'Cơ bản';
    const tabAdvBtn = document.createElement('button');
    tabAdvBtn.className = 'cs-tab-btn';
    tabAdvBtn.dataset.tab = 'tab-advanced';
    tabAdvBtn.textContent = 'Nâng cao';
    tabs.appendChild(tabSimpleBtn);
    tabs.appendChild(tabAdvBtn);

    [tabSimpleBtn, tabAdvBtn].forEach(btn => {
      btn.addEventListener('click', () => {
        controls.querySelectorAll('.cs-tab-btn').forEach(b => b.classList.remove('active'));
        controls.querySelectorAll('.cs-tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      });
    });

    controls.appendChild(tabs);

    // --- Tab Simple ---
    const tabSimple = document.createElement('div');
    tabSimple.id = 'tab-simple';
    tabSimple.className = 'cs-tab-content active';

    function makeGroup(labelText, control) {
      const g = document.createElement('div');
      g.className = 'cs-form-group';
      const lbl = document.createElement('label');
      lbl.textContent = labelText;
      g.appendChild(lbl);
      g.appendChild(control);
      return g;
    }

    // Hue slider
    const hueSlider = document.createElement('input');
    hueSlider.type = 'range'; hueSlider.id = 'cs-hue-slider';
    hueSlider.className = 'cs-hue-slider'; hueSlider.min = 0; hueSlider.max = 360; hueSlider.value = 215;
    hueSlider.addEventListener('input', e => { applySettings({ hue: parseInt(e.target.value) }); saveSettings(); });
    tabSimple.appendChild(makeGroup('Màu chủ đạo (Hue)', hueSlider));

    // Blob color picker
    const blobColorGroup = document.createElement('div');
    blobColorGroup.className = 'cs-form-group';
    const blobLbl = document.createElement('label');
    blobLbl.textContent = 'Màu nền động (màu sáng nhất của blob)';
    const blobRow = document.createElement('div');
    blobRow.style.cssText = 'display:flex; gap:10px; align-items:center;';
    const blobPicker = document.createElement('input');
    blobPicker.type = 'color'; blobPicker.id = 'cs-blob-color';
    blobPicker.value = hslToHex(BASE_BLOB_HSL.h, BASE_BLOB_HSL.s, BASE_BLOB_HSL.l);
    blobPicker.style.cssText = 'width:40px;height:32px;border-radius:6px;border:1px solid var(--color-border);cursor:pointer;';
    blobPicker.addEventListener('input', e => {
      const hsl = hexToHsl(e.target.value);
      applySettings({ blobHsl: hsl });
      saveSettings();
    });
    const blobResetBtn = document.createElement('button');
    blobResetBtn.className = 'btn btn-outline btn-sm';
    blobResetBtn.textContent = 'Tự động';
    blobResetBtn.style.fontSize = '0.78rem';
    blobResetBtn.addEventListener('click', () => {
      // Xóa lock --color-bg để applyTheme có thể khôi phục từ hue slider
      delete tokenOverrides['--color-bg'];
      applySettings({ blobHsl: null });
      applyTheme(currentSettings.hue); // sẽ tính lại từ hue
      blobPicker.value = hslToHex(
        Math.round(((BASE_BLOB_HSL.h + (currentSettings.hue - BASE_HUE)) % 360 + 360) % 360),
        BASE_BLOB_HSL.s, BASE_BLOB_HSL.l
      );
      saveSettings();
    });
    blobRow.appendChild(blobPicker);
    blobRow.appendChild(blobResetBtn);
    blobColorGroup.appendChild(blobLbl);
    blobColorGroup.appendChild(blobRow);
    tabSimple.appendChild(blobColorGroup);

    // Blob toggle
    const blobToggle = document.createElement('input');
    blobToggle.type = 'checkbox'; blobToggle.id = 'cs-blob-toggle'; blobToggle.checked = true;
    blobToggle.addEventListener('change', e => { applySettings({ blobActive: e.target.checked }); saveSettings(); });
    const blobLabel = document.createElement('label');
    blobLabel.className = 'cs-toggle';
    blobLabel.appendChild(blobToggle);
    blobLabel.append(' Bật nền động (Blob Animation)');
    const blobGroup = document.createElement('div'); blobGroup.className = 'cs-form-group';
    blobGroup.appendChild(blobLabel); tabSimple.appendChild(blobGroup);

    // Speed slider
    const speedSlider = document.createElement('input');
    speedSlider.type = 'range'; speedSlider.id = 'cs-speed-slider';
    speedSlider.className = 'cs-range'; speedSlider.min = 0.1; speedSlider.max = 3; speedSlider.step = 0.1; speedSlider.value = 1;
    speedSlider.addEventListener('input', e => {
      const val = parseFloat(e.target.value);
      // Cập nhật fill gradient: min=0.1, max=3
      const pct = ((val - 0.1) / (3 - 0.1) * 100).toFixed(1) + '%';
      e.target.style.setProperty('--pct', pct);
      applySettings({ blobSpeed: val });
      saveSettings();
    });
    tabSimple.appendChild(makeGroup('Tốc độ nền', speedSlider));

    // Glass toggle
    const glassToggle = document.createElement('input');
    glassToggle.type = 'checkbox'; glassToggle.id = 'cs-glass-toggle'; glassToggle.checked = true;
    glassToggle.addEventListener('change', e => { applySettings({ glassActive: e.target.checked }); saveSettings(); });
    const glassLabel = document.createElement('label');
    glassLabel.className = 'cs-toggle';
    glassLabel.appendChild(glassToggle);
    glassLabel.append(' Hiệu ứng kính mờ (Glassmorphism)');
    const glassGroup = document.createElement('div'); glassGroup.className = 'cs-form-group';
    glassGroup.appendChild(glassLabel); tabSimple.appendChild(glassGroup);

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'cs-reset-btn';
    resetBtn.textContent = '↩ Reset về màu mặc định';
    resetBtn.addEventListener('click', resetToDefaults);
    tabSimple.appendChild(resetBtn);

    controls.appendChild(tabSimple);

    // --- Tab Advanced ---
    const tabAdv = document.createElement('div');
    tabAdv.id = 'tab-advanced';
    tabAdv.className = 'cs-tab-content';

    const advDesc = document.createElement('p');
    advDesc.style.cssText = 'font-size:0.85rem;color:var(--color-text-muted);margin-bottom:16px;';
    advDesc.textContent = 'Chỉnh màu từng token CSS riêng lẻ.';
    tabAdv.appendChild(advDesc);

    const grid = document.createElement('div');
    grid.className = 'cs-token-grid';
    grid.id = 'cs-token-grid';

    for (const [token, data] of Object.entries(BASE_TOKENS)) {
      if (data.type !== 'color') continue; // skip shadow tokens — không pick được dễ
      const item = document.createElement('div');
      item.className = 'cs-token-item';

      const swatch = document.createElement('div');
      swatch.className = 'cs-token-color';
      swatch.style.background = `var(${token})`;

      // Nhúng input[type=color] vào trong swatch
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.id = `picker-${token}`;
      // Giá trị hiện tại
      const finalHue = Math.round(((data.h + (currentSettings.hue - BASE_HUE)) % 360 + 360) % 360);
      picker.value = hslToHex(finalHue, data.s, data.l);

      picker.addEventListener('input', e => {
        const hex = e.target.value;
        tokenOverrides[token] = hex;
        currentSettings.tokenOverrides = tokenOverrides;
        document.documentElement.style.setProperty(token, hex);
        swatch.style.background = hex;
        saveSettings();
        _refreshCalendarIfActive();
      });

      swatch.appendChild(picker);

      // Cập nhật swatch background khi picker thay đổi
      picker.addEventListener('input', e => { swatch.style.background = e.target.value; });

      const lbl = document.createElement('span');
      lbl.textContent = token.replace('--color-', '').replace('--progress-', 'prog-').replace('--', '');

      item.appendChild(swatch);
      item.appendChild(lbl);
      grid.appendChild(item);
    }

    tabAdv.appendChild(grid);

    // Reset Advanced
    const resetAdvBtn = document.createElement('button');
    resetAdvBtn.className = 'cs-reset-btn';
    resetAdvBtn.textContent = '↩ Reset tất cả token về mặc định';
    resetAdvBtn.addEventListener('click', resetToDefaults);
    tabAdv.appendChild(resetAdvBtn);

    controls.appendChild(tabAdv);

    // --- Preview Panel ---
    const preview = document.createElement('div');
    preview.className = 'cs-preview';

    // Canvas mirror nền động — nằm phía sau preview content. Chỉ vẽ khi bật
    // nền động (blobActive), иначе ẩn đi để tránh tốn CPU.
    const previewBg = document.createElement('canvas');
    previewBg.className = 'cs-preview-bg';
    preview.appendChild(previewBg);

    const previewContent = document.createElement('div');
    previewContent.className = 'cs-preview-content';
    // FIX: dùng đúng cấu trúc DOM như buildTree() trong app.js — <div class="bar-track">
    // bên trong <div class="bar-fill">, và % nằm trong <span> riêng. Trước đây dùng <span>
    // cho track/fill nên width/height bị bỏ qua (inline) → bar rỗng.
    // Thêm 1 dòng chương (arc-label + SVG circle) để demo đủ 2 kiểu hiển thị tiến độ.
    previewContent.innerHTML = `
      <div class="sidebar glass" style="width:100%;height:auto;min-height:100px;">
        <div class="sidebar-title">Giao diện mẫu</div>
        <div class="tree-label" style="margin-top:10px;">
          <span class="icon toggle-icon">▶</span>
          <span style="flex:1;">Chương mẫu</span>
          <div class="arc-wrap" aria-label="9%">
            <svg width="24" height="24" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="14" fill="none" stroke="var(--progress-track)" stroke-width="4"></circle>
              <circle cx="18" cy="18" r="14" fill="none" stroke="var(--progress-low)" stroke-width="4"
                stroke-dasharray="7.92 87.96" stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 18 18)"></circle>
            </svg>
            <span class="arc-label" style="font-size:8px; color:var(--progress-low); font-weight:bold;">9%</span>
          </div>
        </div>
        <div class="tree-label active-lesson">
          <span class="icon">▶</span>
          <span style="flex:1;">Bài đang xem</span>
          <span class="bar-badge"><div class="bar-track"><div class="bar-fill" style="width:40%;"></div></div><span>40%</span></span>
        </div>
        <div class="tree-label">
          <span class="icon">📄</span>
          <span style="flex:1;">Bài đã xem</span>
          <span class="bar-badge"><div class="bar-track"><div class="bar-fill done" style="width:100%;"></div></div><span>100%</span></span>
        </div>
      </div>
      <div class="course-card glass">
        <h3>Ví dụ Khóa Học</h3>
        <div class="progress-bar"><div class="progress-fill" style="width:65%;"></div></div>
        <div class="progress-label">Tiến độ: 65%</div>
      </div>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-primary">Primary</button>
        <button class="btn btn-outline">Outline</button>
        <button class="btn btn-danger">Danger</button>
      </div>
    `;
    preview.appendChild(previewContent);

    body.appendChild(controls);
    body.appendChild(preview);

    popup.appendChild(header);
    popup.appendChild(body);
    backdrop.appendChild(popup);

    // ── Mirror nền động vào .cs-preview khi popup mở và blob đang bật ──
    let _previewBgRaf = 0;
    let _previewBgResizeHandler = null;
    function startPreviewBgMirror() {
      const globalCanvas = document.getElementById('bg-canvas');
      if (!globalCanvas) return;
      // Chỉ mirror khi nền động đang bật
      if (!currentSettings.blobActive) return;
      const ctx = previewBg.getContext('2d');
      function resize() {
        const r = previewBg.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        previewBg.width = Math.max(1, Math.round(r.width * dpr));
        previewBg.height = Math.max(1, Math.round(r.height * dpr));
      }
      resize();
      function frame() {
        try {
          ctx.clearRect(0, 0, previewBg.width, previewBg.height);
          ctx.drawImage(globalCanvas, 0, 0, previewBg.width, previewBg.height);
        } catch (e) { /* canvas chưa sẵn sàng */ }
        _previewBgRaf = requestAnimationFrame(frame);
      }
      cancelAnimationFrame(_previewBgRaf);
      _previewBgRaf = requestAnimationFrame(frame);
      _previewBgResizeHandler = resize;
      window.addEventListener('resize', _previewBgResizeHandler);
    }
    function stopPreviewBgMirror() {
      cancelAnimationFrame(_previewBgRaf);
      _previewBgRaf = 0;
      if (_previewBgResizeHandler) {
        window.removeEventListener('resize', _previewBgResizeHandler);
        _previewBgResizeHandler = null;
      }
      const ctx = previewBg.getContext('2d');
      if (ctx && previewBg.width) ctx.clearRect(0, 0, previewBg.width, previewBg.height);
    }
    // Lắng nghe open/close của backdrop (bất kể đường nào gọi) để bật/tắt mirror
    const _previewBgObserver = new MutationObserver(() => {
      if (backdrop.classList.contains('open')) startPreviewBgMirror();
      else stopPreviewBgMirror();
    });
    _previewBgObserver.observe(backdrop, { attributes: true, attributeFilter: ['class'] });

    // Đóng khi click ra ngoài popup
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) backdrop.classList.remove('open');
    });

    document.body.appendChild(backdrop);
  }

  // --- Init ---
  injectUI();

  const headerRight = document.querySelector('.header-right');
  if (headerRight) {
    const btn = document.createElement('button');
    btn.className = 'btn-icon';
    btn.textContent = '🎨';
    btn.title = 'Cài đặt giao diện';
    btn.id = 'btn-color-settings';
    btn.onclick = () => document.getElementById('color-settings-backdrop').classList.add('open');
    const adminBtn = document.getElementById('btn-admin');
    if (adminBtn) headerRight.insertBefore(btn, adminBtn);
    else headerRight.prepend(btn);
  }

  // bg.js dùng defer → đợi 150ms để BlobController được gán
  setTimeout(loadSavedSettings, 150);

  window.openColorSettings = () => document.getElementById('color-settings-backdrop').classList.add('open');
});