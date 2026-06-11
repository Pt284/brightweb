with open('index.html', 'r', encoding='utf-8') as f:
    c = f.read()

# Ensure color-settings.css is in </head>
css_tag = '<link rel="stylesheet" href="color-settings.css">'
js_tag = '<script src="color-settings.js"></script>'

# Remove from head if misplaced
if css_tag + '\n</head>' in c:
    c = c.replace(css_tag + '\n</head>', '</head>')
if '  ' + css_tag + '\n</head>' in c:
    c = c.replace('  ' + css_tag + '\n</head>', '</head>')

# Re-add css before </head>
if css_tag not in c:
    c = c.replace('</head>', '  ' + css_tag + '\n</head>')

# Remove JS from head
if js_tag + '\n</head>' in c:
    c = c.replace(js_tag + '\n</head>', '</head>')
if '  ' + js_tag + '\n</head>' in c:
    c = c.replace('  ' + js_tag + '\n</head>', '</head>')

# Ensure JS is before </body>
if js_tag not in c:
    c = c.replace('</body>', '  ' + js_tag + '\n</body>')

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(c)

print('Fixed index.html script placement')
