import re

with open('style.css', 'r', encoding='utf-8') as f:
    style_css = f.read()

with open('admin-check.css', 'r', encoding='utf-8') as f:
    admin_css = f.read()

root_block = """:root {
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

/* ==="""

style_css = re.sub(r':root\s*\{[\s\S]*?\}\s*/\* ===', root_block, style_css)

# Replacements for style.css
replacements = {
    'html { background: #020810; }': 'html { background: var(--color-bg); }',
    'color: var(--text);': 'color: var(--color-text);',
    'background: var(--bg);': 'background: var(--color-bg-alt);',
    'var(--border)': 'var(--color-border)',
    'var(--accent)': 'var(--color-accent)',
    'var(--accent-hover)': 'var(--color-accent-hover)',
    'var(--surface)': 'var(--color-surface)',
    'var(--surface2)': 'var(--color-surface2)',
    'var(--surface3)': 'var(--color-surface3)',
    'var(--text-muted)': 'var(--color-text-muted)',
    'var(--text-dim)': 'var(--color-text-dim)',
    'var(--green)': 'var(--color-green)',
    'var(--red)': 'var(--color-red)',
    'rgba(23,39,77,.8)': 'var(--color-surface-modal)',
    'rgba(2,8,16,.55)': 'var(--color-surface-overlay)',
    'rgba(2,8,16,.45)': 'var(--color-surface-overlay)',
    'rgba(2,8,16,.85)': 'var(--color-surface-modal)',
    'rgba(255,255,255,.06)': 'var(--color-surface-glass)',
    'rgba(255,255,255,.12)': 'var(--color-border-glass)',
    'rgba(255,255,255,.1)': 'var(--color-surface-glass-hover)',
    'rgba(255,255,255,.2)': 'var(--color-border-glass-hover)',
    'rgba(0,145,234,.12)': 'var(--color-accent-alpha)',
    'rgba(0,145,234,.18)': 'var(--color-accent-alpha)',
    '#60c8ff': 'var(--color-accent-text)',
    '#fff': 'var(--color-text-inverse)',
    'white': 'var(--color-text-inverse)',
    'rgba(255,255,255,0.15)': 'var(--progress-track)',
    '#378ADD': 'var(--progress-fill)',
    '#639922': 'var(--progress-done)',
    '#EF9F27': 'var(--progress-low)',
    'var(--radius)': 'var(--radius)', # ensure no change but keep syntax valid
}

for k, v in replacements.items():
    style_css = style_css.replace(k, v)

# Button refactor
btn_pattern = r'\.btn\s*\{[\s\S]*?\}\s*\.btn-primary\s*\{[\s\S]*?\}\s*\.btn-primary:hover\s*\{[\s\S]*?\}\s*\.btn-outline\s*\{[\s\S]*?\}\s*\.btn-outline:hover\s*\{[\s\S]*?\}'
btn_replace = """.btn {
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
}"""
style_css = re.sub(btn_pattern, btn_replace, style_css)

watch_btn_pattern = r'\.btn-watch\s*\{[\s\S]*?\}\s*\.btn-watch\.watched\s*\{[\s\S]*?\}'
watch_btn_replace = """.btn-watch {
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
}"""
style_css = re.sub(watch_btn_pattern, watch_btn_replace, style_css)


admin_reps = {
    'var(--text)': 'var(--color-text)',
    'var(--text-muted)': 'var(--color-text-muted)',
    'var(--text-dim)': 'var(--color-text-dim)',
    'var(--accent)': 'var(--color-accent)',
    'var(--border)': 'var(--color-border)',
    '#fff': 'var(--color-text-inverse)',
    'rgba(2, 8, 16, 0.65)': 'var(--color-surface-overlay)',
    'rgba(255,255,255,0.03)': 'var(--color-surface-glass)',
    'rgba(255,255,255,0.04)': 'var(--color-surface-glass)',
    'rgba(0,0,0,0.3)': 'var(--color-surface-input)',
    'rgba(0,0,0,0.4)': 'var(--color-surface-input)',
    'rgba(0,0,0,0.2)': 'var(--color-surface-input)',
}
for k, v in admin_reps.items():
    admin_css = admin_css.replace(k, v)

filter_btn_pattern = r'\.filter-btn\s*\{[\s\S]*?\}\s*\.filter-btn:hover\s*\{[\s\S]*?\}\s*\.filter-btn\.active\s*\{[\s\S]*?\}'
filter_btn_replace = """.filter-btn {
  background: var(--btn-bg, transparent);
  border: 1px solid var(--btn-border, var(--color-border));
  color: var(--btn-text, var(--color-text-muted));
  --btn-bg: transparent;
  --btn-border: var(--color-border);
  --btn-text: var(--color-text-muted);
  cursor: pointer;
}
.filter-btn:hover {
  --btn-bg: var(--color-surface-glass-hover);
  --btn-text: var(--color-text);
}
.filter-btn.active {
  --btn-bg: var(--color-accent);
  --btn-border: var(--color-accent);
  --btn-text: var(--color-text-inverse);
}"""
admin_css = re.sub(filter_btn_pattern, filter_btn_replace, admin_css)

status_pattern = r'\.status\.error\s*\{[\s\S]*?\}\s*\.status\.warning\s*\{[\s\S]*?\}\s*\.status\.info\s*\{[\s\S]*?\}'
status_replace = """.status.error {
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
}"""
admin_css = re.sub(status_pattern, status_replace, admin_css)

with open('style.css', 'w', encoding='utf-8') as f:
    f.write(style_css)

with open('admin-check.css', 'w', encoding='utf-8') as f:
    f.write(admin_css)

print("Done")
