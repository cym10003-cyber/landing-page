import os
import json
from datetime import datetime

domain = 'https://choi114.com'
current_date = datetime.now().strftime('%Y-%m-%d')

static_pages = [
    { 'loc': '/', 'changefreq': 'daily', 'priority': '1.0' },
    { 'loc': '/about', 'changefreq': 'monthly', 'priority': '0.8' },
    { 'loc': '/map', 'changefreq': 'daily', 'priority': '0.9' },
    { 'loc': '/news', 'changefreq': 'daily', 'priority': '0.8' }
]

try:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    posts_path = os.path.join(base_dir, '../data/posts.json')
    posts = []
    
    if os.path.exists(posts_path):
        with open(posts_path, 'r', encoding='utf-8') as f:
            posts = json.load(f)

    xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'

    # Static pages
    for page in static_pages:
        xml += f"  <url>\n"
        xml += f"    <loc>{domain}{page['loc']}</loc>\n"
        xml += f"    <lastmod>{current_date}</lastmod>\n"
        xml += f"    <changefreq>{page['changefreq']}</changefreq>\n"
        xml += f"    <priority>{page['priority']}</priority>\n"
        xml += f"  </url>\n"

    # Dynamic posts
    for post in posts:
        post_date = current_date
        if 'date' in post and post['date']:
            parts = [p.strip() for p in post['date'].split('.') if p.strip()]
            if len(parts) == 3:
                post_date = f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"

        xml += f"  <url>\n"
        xml += f"    <loc>{domain}/news-detail?id={post['id']}</loc>\n"
        xml += f"    <lastmod>{post_date}</lastmod>\n"
        xml += f"    <changefreq>weekly</changefreq>\n"
        xml += f"    <priority>0.7</priority>\n"
        xml += f"  </url>\n"

    xml += '</urlset>\n'

    sitemap_path = os.path.join(base_dir, '../sitemap.xml')
    with open(sitemap_path, 'w', encoding='utf-8') as f:
        f.write(xml)
    print('Sitemap generated successfully via Python at sitemap.xml')
except Exception as e:
    print('Failed to generate sitemap via Python:', e)
