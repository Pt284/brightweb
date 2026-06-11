# Kế hoạch triển khai PHASE 3: Color Settings Popup

Tài liệu này vạch ra kế hoạch xây dựng tính năng Color Settings Popup, bao gồm thuật toán Hue Shift, danh sách các token CSS sẽ bị ảnh hưởng, và cấu trúc giao diện.

## 1. Danh sách Token tham gia Hue Shift (System Colors)

Để đảm bảo thuật toán Hue Shift hoạt động như Photoshop (xoay màu tuyến tính, giữ nguyên Saturation và Lightness tương đối, đặc biệt là bóng đổ shadow), đây là danh sách các token sẽ tham gia vào quá trình cộng `ΔHue`:

### Tham gia Shift (Shift = `true`)
*Các token có chứa sắc tố (Saturation > 0) thuộc hệ thống theme chính.*
- `--color-bg`, `--color-bg-alt`
- `--color-surface`, `--color-surface2`, `--color-surface3`
- `--color-surface-modal`, `--color-surface-overlay`
- `--color-border`
- `--color-accent`, `--color-accent-hover`, `--color-accent-alpha`, `--color-accent-text`
- `--color-text`, `--color-text-muted`, `--color-text-dim`
- `--progress-fill`
- `--shadow-sm`, `--shadow-glass-hover` (Đảm bảo bóng sáng lên cùng tông màu với accent)

### KHÔNG tham gia Shift (Shift = `false`)
*Các token không mang sắc tố (Saturation = 0) hoặc mang ý nghĩa Semantic.*
- **Kính & Overlay (S = 0):** `--color-surface-glass`, `--color-surface-glass-hover`, `--color-surface-input`, `--color-border-glass`, `--color-border-glass-hover`
- **Chữ tĩnh (S = 0):** `--color-text-inverse`
- **Semantic Colors:** `--color-green`, `--color-green-alpha`, `--color-red`, `--color-red-alpha`, `--color-yellow`, `--color-yellow-alpha`, `--color-info`, `--color-info-alpha`
- **Progress Semantic:** `--progress-done`, `--progress-low`, `--progress-track`
- **Shadow tĩnh:** `--shadow`, `--shadow-glass`

## 2. Thuật toán xử lý màu

const BASE_HUE = 215; // Hue gốc của theme hiện tại

// Cấu trúc lưu trữ base token trong JS (đầy đủ 100%)
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
  // --- Shadows (String interpolation) ---
  '--shadow-sm': { type: 'shadow', format: '0 2px 16px hsla({h}, {s}%, {l}%, {a})', h: 203, s: 100, l: 46, a: 0.2 },
  '--shadow-glass-hover': { type: 'shadow', format: '0 12px 40px hsla({h}, {s}%, {l}%, {a})', h: 203, s: 100, l: 46, a: 0.2 }
};

// Hàm load cấu hình từ LocalStorage
function loadSavedSettings() {
  const saved = localStorage.getItem('theme_settings');
  if (saved) {
    const settings = JSON.parse(saved);
    if (settings.hue !== undefined) applyTheme(settings.hue);
    // Áp dụng các settings khác (nền động, trong suốt...)
  }
}

function applyTheme(newHue) {
  const deltaHue = newHue - BASE_HUE;
  
  // 1. Cập nhật System Tokens
  for (const [token, data] of Object.entries(BASE_TOKENS)) {
    const finalHue = ((data.h + deltaHue) % 360 + 360) % 360;
    
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

  // 2. Cập nhật Blob Background trong bg.js
  if (window.BlobController && window.BlobController.setPalette) {
    window.BlobController.setPalette(newHue);
  }
  
  // 3. Persist vào LocalStorage
  const settings = JSON.parse(localStorage.getItem('theme_settings') || '{}');
  settings.hue = newHue;
  localStorage.setItem('theme_settings', JSON.stringify(settings));
}
```

## 3. Cấu trúc Giao diện (Color Settings Popup)

Sẽ tạo 2 file `color-settings.js` và `color-settings.css`. File JS sẽ tự động inject mã HTML của Popup vào DOM khi được tải (hoặc khi gọi hàm init), tránh việc phải copy-paste cục HTML dài vào cả 2 trang `index.html` và `admin-check.html`.

**Layout Popup:**
- **Backdrop:** Tối mờ, có hiệu ứng blur.
- **Container:** Rộng ~900px, cao ~600px.
- **Cột Trái (Controls):** 
  - Tabs: Đơn giản / Nâng cao.
  - Controls: Color picker (Màu chủ đạo), Toggle (Nền động, Trong suốt), Radio (Theme Tối/Sáng), Slider (Tốc độ nền).
- **Cột Phải (Preview):** 
  - Một khối `div` thu nhỏ dùng `zoom: 0.8` (hoặc cấu trúc flex responsive để tránh overflow/clipping) chứa các UI sample như: Mini Sidebar, Course Card (kèm Progress Bar), Primary/Outline Buttons.

## 4. Tương tác với Blob Background (`bg.js`)

Để điều khiển Blob, `bg.js` sẽ cần expose một số API ra global object (ví dụ `window.BlobController`):
- `BlobController.setPalette(hue)`: Dùng thuật toán lightnessStops để sinh lại màu dựa trên Hue mới.
- `BlobController.setSpeed(multiplier)`: Điều chỉnh hệ số nhân tốc độ.
- `BlobController.toggle(isActive)`: Bật/tắt vòng lặp requestAnimationFrame.

> [!WARNING]
> **Vấn đề Theme Sáng (Light Mode)**
> Theme sáng không thể đạt được chỉ bằng cách thay đổi Hue. Nó yêu cầu đảo ngược hoàn toàn Lightness (Ví dụ chữ trắng `#e2e8f0` -> đen `#1e293b`, nền đen `#020810` -> trắng `#f8fafc`).
> Việc đảo ngược Lightness tự động (L = 100 - L) thường tạo ra kết quả rất xấu và khó kiểm soát độ tương phản.

> [!IMPORTANT]
> **Câu hỏi cho User:**
> 1. Với **Theme Sáng**, bạn muốn tôi tạo một bộ mã Base Lightness cố định (Ví dụ `--bg-light`, `--text-light`...) và chỉ áp dụng Hue Shift trên bộ Lightness đó, hay bạn muốn một công thức tự động tính toán (tuy có rủi ro)?
> 2. Bạn có muốn điều chỉnh thêm bớt token nào trong danh sách tham gia Shift/Không tham gia Shift không (Phần 1)?
