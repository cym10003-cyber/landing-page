import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const postsPath = path.join(process.cwd(), 'data', 'posts.json');
  let posts = [];

  try {
    if (fs.existsSync(postsPath)) {
      posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading posts.json for Sitemap:', e);
  }

  const host = req.headers.host || 'choi114.com';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${protocol}://${host}`;

  // Static URLs
  const todayStr = new Date().toISOString().split('T')[0];
  const staticUrls = [
    { loc: `${baseUrl}/`, lastmod: todayStr, changefreq: 'daily', priority: '1.0' },
    { loc: `${baseUrl}/about`, lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.8' },
    { loc: `${baseUrl}/map`, lastmod: todayStr, changefreq: 'daily', priority: '0.9' },
    { loc: `${baseUrl}/property-news`, lastmod: todayStr, changefreq: 'daily', priority: '0.8' }
  ];

  // Dynamic Post URLs
  const postUrls = posts.map(post => {
    const pubDate = post.id ? new Date(Number(post.id)).toISOString().split('T')[0] : todayStr;
    return {
      loc: `${baseUrl}/news-detail?id=${post.id}`,
      lastmod: pubDate,
      changefreq: 'weekly',
      priority: '0.7'
    };
  });

  const allUrls = [...staticUrls, ...postUrls];

  const xmlItems = allUrls.map(item => {
    let itemXml = '  <url>\n';
    itemXml += `    <loc>${item.loc}</loc>\n`;
    if (item.lastmod) {
      itemXml += `    <lastmod>${item.lastmod}</lastmod>\n`;
    }
    itemXml += `    <changefreq>${item.changefreq}</changefreq>\n`;
    itemXml += `    <priority>${item.priority}</priority>\n`;
    itemXml += '  </url>';
    return itemXml;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlItems}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.status(200).send(xml);
}
