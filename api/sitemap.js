import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  const postsPath = path.join(process.cwd(), 'data', 'posts.json');
  let posts = null;

  const token = (process.env.GITHUB_TOKEN || '').trim();
  try {
    const ghApiUrl = `https://api.github.com/repos/cym10003-cyber/landing-page/contents/data/posts.json?t=${Date.now()}`;
    const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Vercel-Serverless-Function' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const apiRes = await fetch(ghApiUrl, { headers, cache: 'no-store' });
    if (apiRes.ok) {
      const apiData = await apiRes.json();
      if (apiData && apiData.content) {
        posts = JSON.parse(Buffer.from(apiData.content, 'base64').toString('utf8'));
      }
    }
  } catch (e) {}

  if (!posts) {
    try {
      const ghRes = await fetch(`https://raw.githubusercontent.com/cym10003-cyber/landing-page/main/data/posts.json?t=${Date.now()}`, {
        headers: { 'User-Agent': 'Vercel-Serverless-Function', 'Cache-Control': 'no-cache' }
      });
      if (ghRes.ok) posts = await ghRes.json();
    } catch (e) {}
  }

  if (!posts) {
    try {
      if (fs.existsSync(postsPath)) {
        posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
      }
    } catch (e) {
      console.error('Error reading posts.json for Sitemap:', e);
    }
  }

  const publicPosts = Array.isArray(posts) ? posts.filter(p => p && p.isPrivate !== true) : [];

  const host = 'www.choi114.com';
  const protocol = 'https';
  const baseUrl = `${protocol}://${host}`;

  // Static & Regional Hub URLs
  const todayStr = new Date().toISOString().split('T')[0];
  const regions = ['수성구', '중구', '달서구', '동구', '북구', '서구', '남구', '달성군', '경산'];
  const regionalHubUrls = regions.map(reg => ({
    loc: `${baseUrl}/property-news?category=${encodeURIComponent('매물리스트')}&region=${encodeURIComponent(reg)}`,
    lastmod: todayStr,
    changefreq: 'daily',
    priority: '0.85'
  }));

  const staticUrls = [
    { loc: `${baseUrl}/`, lastmod: todayStr, changefreq: 'daily', priority: '1.0' },
    { loc: `${baseUrl}/about`, lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.8' },
    { loc: `${baseUrl}/map`, lastmod: todayStr, changefreq: 'daily', priority: '0.9' },
    { loc: `${baseUrl}/property-news`, lastmod: todayStr, changefreq: 'daily', priority: '0.9' },
    ...regionalHubUrls
  ];

  const escXml = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // Dynamic Post URLs (Public listings only, with Image Sitemap tags)
  const postUrls = publicPosts.map(post => {
    const rawTs = Number(post.updatedAt || post.id);
    const pubDate = (!isNaN(rawTs) && rawTs > 1000000000000) ? new Date(rawTs).toISOString().split('T')[0] : todayStr;
    const contentStr = String(post.content || '');
    const mdImgMatches = [...contentStr.matchAll(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/g)].map(m => m[1]);
    const htmlImgMatches = [...contentStr.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
    const uniqueImgs = [...new Set([...mdImgMatches, ...htmlImgMatches])].slice(0, 5);

    return {
      loc: `${baseUrl}/news-detail?id=${post.id}`,
      lastmod: pubDate,
      changefreq: 'weekly',
      priority: '0.8',
      title: post.title || '최가네부동산 실매물',
      images: uniqueImgs
    };
  });

  const allUrls = [...staticUrls, ...postUrls];

  const xmlItems = allUrls.map(item => {
    let itemXml = '  <url>\n';
    itemXml += `    <loc>${escXml(item.loc)}</loc>\n`;
    if (item.lastmod) {
      itemXml += `    <lastmod>${escXml(item.lastmod)}</lastmod>\n`;
    }
    itemXml += `    <changefreq>${item.changefreq}</changefreq>\n`;
    itemXml += `    <priority>${item.priority}</priority>\n`;
    if (Array.isArray(item.images) && item.images.length > 0) {
      item.images.forEach(imgUrl => {
        itemXml += '    <image:image>\n';
        itemXml += `      <image:loc>${escXml(imgUrl)}</image:loc>\n`;
        if (item.title) {
          itemXml += `      <image:title>${escXml(item.title)}</image:title>\n`;
        }
        itemXml += '    </image:image>\n';
      });
    }
    itemXml += '  </url>';
    return itemXml;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${xmlItems}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.status(200).send(xml);
}
