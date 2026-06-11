with open('admin-check.html', 'r', encoding='utf-8') as f:
    c = f.read()

css_tag = '<link rel="stylesheet" href="color-settings.css">'
js_tag = '<script src="color-settings.js"></script>'

# Remove any existing placements
for tag in [css_tag, '  ' + css_tag]:
    if tag + '\n</head>' in c:
        c = c.replace(tag + '\n</head>', '</head>')
    if tag + '\n  </head>' in c:
        c = c.replace(tag + '\n  </head>', '</head>')

for tag in [js_tag, '  ' + js_tag]:
    if tag + '\n</body>' in c:
        c = c.replace(tag + '\n</body>', '</body>')
    if tag + '\n  </body>' in c:
        c = c.replace(tag + '\n  </body>', '</body>')

# Add correctly
if css_tag not in c:
    c = c.replace('</head>', '  ' + css_tag + '\n</head>')
if js_tag not in c:
    c = c.replace('</body>', '  ' + js_tag + '\n</body>')

with open('admin-check.html', 'w', encoding='utf-8') as f:
    f.write(c)

print('Fixed admin-check.html')

# Check
with open('admin-check.html', 'r', encoding='utf-8') as f:
    c = f.read()
css_pos = c.find('color-settings.css')
js_pos = c.find('color-settings.js')
head_pos = c.find('</head>')
body_pos = c.find('</body>')
print('CSS in head:', css_pos < head_pos)
print('JS in body:', js_pos > head_pos and js_pos < body_pos)
