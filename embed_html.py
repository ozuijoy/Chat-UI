#!/usr/bin/env python3
"""將HTML內容嵌入到TypeScript文件中"""

import re

# 讀取HTML文件
with open('src/index.html', 'r', encoding='utf-8') as f:
    html_content = f.read()

# 轉義反引號和美元符號
html_content = html_content.replace('\\', '\\\\')
html_content = html_content.replace('`', '\\`')
html_content = html_content.replace('$', '\\$')

# 讀取TypeScript文件
with open('src/index.ts', 'r', encoding='utf-8') as f:
    ts_content = f.read()

# 找到getFrontendHTML函數並替換其內容
pattern = r'(function getFrontendHTML\(\): string \{\s*return `)[\s\S]*?(`;\s*\})'
replacement = r'\1' + html_content + r'\2'

new_ts_content = re.sub(pattern, replacement, ts_content)

# 寫回TypeScript文件
with open('src/index.ts', 'w', encoding='utf-8') as f:
    f.write(new_ts_content)

print("HTML內容已成功嵌入到index.ts中")
print(f"HTML文件大小: {len(html_content)} 字符")
