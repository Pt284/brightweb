import re

def insert_head(file, line_to_insert):
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()
    if line_to_insert not in content:
        content = content.replace('</head>', f'  {line_to_insert}\n</head>')
        with open(file, 'w', encoding='utf-8') as f:
            f.write(content)

def insert_body(file, line_to_insert):
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()
    if line_to_insert not in content:
        content = content.replace('</body>', f'  {line_to_insert}\n</body>')
        with open(file, 'w', encoding='utf-8') as f:
            f.write(content)

for html_file in ['index.html', 'admin-check.html']:
    insert_head(html_file, '<link rel="stylesheet" href="color-settings.css">')
    insert_body(html_file, '<script src="color-settings.js"></script>')

print('Injected to HTML files')
