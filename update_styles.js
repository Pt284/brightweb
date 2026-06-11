const fs = require('fs');

// Read files
let styleCss = fs.readFileSync('style.css', 'utf-8');
let adminCss = fs.readFileSync('admin-check.css', 'utf-8');

// Replace :root block in style.css
styleCss = styleCss.replace(/:root\s*\{[\s\S]*?\}\s*\/\* ===/, `:root {
  /* System Backgrounds */
  --color-bg: hsl(213, 78%, 4%);
  --color-bg-alt: hsl(222, 54%, 20%);
  
  /* System Surfaces */
  --color-surface: hsl(223, 52%, 25%);
  --color-surface2: hsl(225, 52%, 29%);
  --color-surface3: hsl(221, 53%, 22%);
  --color-surface-glass: hsla(215, 0%, 100%, 0.06);
  --color-surface-glass-hover: hsla(215, 0%, 100%, 0.1);
  --color-surface-overlay: hsla(214, 78%, 4%, 0.55);
  --color-surface-modal: hsla(222, 54%, 20%, 0.8);
  --color-surface-input: hsla(215, 0%, 0%, 0.3);
  
  /* System Borders */
  --color-border: hsl(222, 45%, 30%);
  --color-border-glass: hsla(215, 0%, 100%, 0.12);
  --color-border-glass-hover: hsla(215, 0%, 100%, 0.2);
  --color-divider: var(--color-border);
  
  /* System Accents */
  --color-accent: hsl(203, 100%, 46%);
  --color-accent-hover: hsl(203, 100%, 38%);
  --color-accent-alpha: hsla(203, 100%, 46%, 0.12);
  --color-accent-text: hsl(201, 100%, 69%);
  
  /* Semantic Colors */
  --color-green: hsl(145, 100%, 39%);
  --color-green-alpha: hsla(145, 100%, 39%, 0.12);
  --color-red: hsl(0, 90%, 71%);
  --color-red-alpha: hsla(0, 90%, 71%, 0.2);
  --color-yellow: hsl(45, 97%, 60%);
  --color-yellow-alpha: hsla(45, 97%, 60%, 0.2);
  --color-info: hsl(214, 97%, 78%);
  --color-info-alpha: hsla(214, 97%, 78%, 0.2);
  
  /* Text */
  --color-text: hsl(214, 32%, 91%);
  --color-text-muted: hsl(215, 25%, 65%);
  --color-text-dim: hsl(213, 27%, 84%);
  --color-text-inverse: hsl(0, 0%, 100%);
  
  /* Buttons */
  --btn-bg: transparent;
  --btn-border: transparent;
  --btn-text: var(--color-text);
  
  /* Progress */
  --progress-track: hsla(0, 0%, 100%, 0.15);
  --progress-fill: hsl(210, 71%, 54%);
  --progress-done: var(--color-green);
  --progress-low: var(--color-yellow);
  
  /* Dimensions & Shadows */
  --radius: 10px;
  --radius-sm: 6px;
  --radius-lg: 16px;
  --sidebar-w: 280px;
  --shadow: 0 4px 24px hsla(0,0%,0%,0.5);
  --shadow-sm: 0 2px 16px hsla(203,100%,46%,0.2);
  --shadow-glass: 0 8px 32px hsla(0,0%,0%,0.35);
  --shadow-glass-hover: 0 12px 40px hsla(203,100%,46%,0.2);
  
  /* Plyr */
  --plyr-color-main: var(--color-accent);
  --plyr-video-background: hsl(0, 0%, 0%);
  --plyr-range-fill-background: var(--color-accent);
  --plyr-video-controls-background: linear-gradient(hsla(0,0%,0%,0), hsla(0,0%,0%,0.85));
  --plyr-control-radius: var(--radius-sm);
  --plyr-font-family: system-ui, sans-serif;
}

/* ===`);

// Replace variables usage
styleCss = styleCss.replace(/html \{ background: #020810; \}/g, 'html { background: var(--color-bg); }');
styleCss = styleCss.replace(/color: var\(--text\);/g, 'color: var(--color-text);');
styleCss = styleCss.replace(/background: var\(--bg\);/g, 'background: var(--color-bg-alt);');
styleCss = styleCss.replace(/var\(--border\)/g, 'var(--color-border)');
styleCss = styleCss.replace(/var\(--accent\)/g, 'var(--color-accent)');
styleCss = styleCss.replace(/var\(--accent-hover\)/g, 'var(--color-accent-hover)');
styleCss = styleCss.replace(/var\(--surface\)/g, 'var(--color-surface)');
styleCss = styleCss.replace(/var\(--surface2\)/g, 'var(--color-surface2)');
styleCss = styleCss.replace(/var\(--surface3\)/g, 'var(--color-surface3)');
styleCss = styleCss.replace(/var\(--text-muted\)/g, 'var(--color-text-muted)');
styleCss = styleCss.replace(/var\(--text-dim\)/g, 'var(--color-text-dim)');
styleCss = styleCss.replace(/var\(--green\)/g, 'var(--color-green)');
styleCss = styleCss.replace(/var\(--red\)/g, 'var(--color-red)');

// Replace hardcoded
styleCss = styleCss.replace(/rgba\(23,39,77,\.8\)/g, 'var(--color-surface-modal)');
styleCss = styleCss.replace(/rgba\(2,8,16,\.55\)/g, 'var(--color-surface-overlay)');
styleCss = styleCss.replace(/rgba\(2,8,16,\.45\)/g, 'var(--color-surface-overlay)');
styleCss = styleCss.replace(/rgba\(2,8,16,\.85\)/g, 'var(--color-surface-modal)');

styleCss = styleCss.replace(/rgba\(255,255,255,\.06\)/g, 'var(--color-surface-glass)');
styleCss = styleCss.replace(/rgba\(255,255,255,\.12\)/g, 'var(--color-border-glass)');
styleCss = styleCss.replace(/rgba\(255,255,255,\.1\)/g, 'var(--color-surface-glass-hover)');
styleCss = styleCss.replace(/rgba\(255,255,255,\.2\)/g, 'var(--color-border-glass-hover)');
styleCss = styleCss.replace(/rgba\(0,145,234,\.12\)/g, 'var(--color-accent-alpha)');
styleCss = styleCss.replace(/rgba\(0,145,234,\.18\)/g, 'var(--color-accent-alpha)');
styleCss = styleCss.replace(/#60c8ff/g, 'var(--color-accent-text)');
styleCss = styleCss.replace(/#fff/g, 'var(--color-text-inverse)');
styleCss = styleCss.replace(/white/g, 'var(--color-text-inverse)');

// Buttons in style.css
styleCss = styleCss.replace(/\.btn \{[\s\S]*?\}\n\.btn-primary \{[\s\S]*?\}\n\.btn-primary:hover \{[\s\S]*?\}\n\n\.btn-outline \{[\s\S]*?\}\n\.btn-outline:hover \{[\s\S]*?\}/, `.btn {
  background: var(--btn-bg, transparent);
  border: 1.5px solid var(--btn-border, transparent);
  color: var(--btn-text, var(--color-text));
  padding: 8px 18px;
  border-radius: var(--radius);
  font-size: .9rem;
  font-weight: 500;
  transition: all 0.2s;
  cursor: pointer;
}
.btn-primary {
  --btn-bg: var(--color-accent);
  --btn-border: var(--color-accent);
  --btn-text: var(--color-text-inverse);
}
.btn-primary:hover {
  --btn-bg: var(--color-accent-hover);
  --btn-border: var(--color-accent-hover);
}
.btn-outline {
  --btn-bg: transparent;
  --btn-border: var(--color-accent);
  --btn-text: var(--color-accent);
}
.btn-outline:hover {
  --btn-bg: var(--color-accent-alpha);
}`);

styleCss = styleCss.replace(/\.btn-watch \{[\s\S]*?\}\n\.btn-watch\.watched \{[\s\S]*?\}/, `.btn-watch {
  background: var(--btn-bg, transparent);
  border: 1.5px solid var(--btn-border, var(--color-green));
  color: var(--btn-text, var(--color-green));
  padding: 8px 20px;
  border-radius: var(--radius);
  font-weight: 500;
  font-size: .9rem;
  cursor: pointer;
  transition: all 0.2s;
  --btn-bg: transparent;
  --btn-border: var(--color-green);
  --btn-text: var(--color-green);
}
.btn-watch.watched {
  --btn-bg: var(--color-green);
  --btn-text: var(--color-text-inverse);
}`);

// Progress Mini Bar replaces
styleCss = styleCss.replace(/rgba\(255,255,255,0\.15\)/g, 'var(--progress-track)');
styleCss = styleCss.replace(/#378ADD/g, 'var(--progress-fill)');
styleCss = styleCss.replace(/#639922/g, 'var(--progress-done)');
styleCss = styleCss.replace(/#EF9F27/g, 'var(--progress-low)');


// Admin check CSS updates
adminCss = adminCss.replace(/var\(--text\)/g, 'var(--color-text)');
adminCss = adminCss.replace(/var\(--text-muted\)/g, 'var(--color-text-muted)');
adminCss = adminCss.replace(/var\(--text-dim\)/g, 'var(--color-text-dim)');
adminCss = adminCss.replace(/var\(--accent\)/g, 'var(--color-accent)');
adminCss = adminCss.replace(/var\(--border\)/g, 'var(--color-border)');
adminCss = adminCss.replace(/#fff/g, 'var(--color-text-inverse)');

adminCss = adminCss.replace(/rgba\(2, 8, 16, 0\.65\)/g, 'var(--color-surface-overlay)');
adminCss = adminCss.replace(/rgba\(255,255,255,0\.03\)/g, 'var(--color-surface-glass)');
adminCss = adminCss.replace(/rgba\(255,255,255,0\.04\)/g, 'var(--color-surface-glass)');
adminCss = adminCss.replace(/rgba\(0,0,0,0\.3\)/g, 'var(--color-surface-input)');
adminCss = adminCss.replace(/rgba\(0,0,0,0\.4\)/g, 'var(--color-surface-input)');
adminCss = adminCss.replace(/rgba\(0,0,0,0\.2\)/g, 'var(--color-surface-input)');

adminCss = adminCss.replace(/\.filter-btn \{[\s\S]*?\}\n\.filter-btn:hover \{[\s\S]*?\}\n\.filter-btn\.active \{[\s\S]*?\}/, `.filter-btn {
  background: var(--btn-bg, transparent);
  border: 1px solid var(--btn-border, var(--color-border));
  color: var(--btn-text, var(--color-text-muted));
  --btn-bg: transparent;
  --btn-border: var(--color-border);
  --btn-text: var(--color-text-muted);
}
.filter-btn:hover {
  --btn-bg: var(--color-surface-glass-hover);
  --btn-text: var(--color-text);
}
.filter-btn.active {
  --btn-bg: var(--color-accent);
  --btn-border: var(--color-accent);
  --btn-text: var(--color-text-inverse);
}`);

adminCss = adminCss.replace(/\.status\.error \{[\s\S]*?\}\n\.status\.warning \{[\s\S]*?\}\n\.status\.info \{[\s\S]*?\}/, `.status.error {
  background: var(--color-red-alpha);
  color: var(--color-red);
  border: 1px solid var(--color-red-alpha);
}
.status.warning {
  background: var(--color-yellow-alpha);
  color: var(--color-yellow);
  border: 1px solid var(--color-yellow-alpha);
}
.status.info {
  background: var(--color-info-alpha);
  color: var(--color-info);
  border: 1px solid var(--color-info-alpha);
}`);

fs.writeFileSync('style.css', styleCss);
fs.writeFileSync('admin-check.css', adminCss);
console.log('Styles updated successfully.');
