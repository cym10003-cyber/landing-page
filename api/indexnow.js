import fs from 'fs';
import path from 'path';

const INDEXNOW_KEY = 'c9b8a7d6e5f4a3b2c1d0e9f8a7b6c5d4';
const SITE_HOST = 'www.choi114.com';
const BASE_URL = `https://${SITE_HOST}`;
const KEY_LOCATION = `${BASE_URL}/${INDEXNOW_KEY}.txt`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let urlList = [];

  try {
    const body = req.body || {};
    const postId = body.postId || req.query?.postId || '';
    const customUrls = Array.isArray(body.urls) ? body.urls : [];

    if (postId) {
      urlList.push(`${BASE_URL}/news-detail?id=${encodeURIComponent(String(postId))}`);
      urlList.push(`${BASE_URL}/property-news`);
      urlList.push(`${BASE_URL}/map`);
      urlList.push(`${BASE_URL}/`);
    }

    if (customUrls.length > 0) {
      customUrls.forEach(u => {
        if (typeof u === 'string' && u.startsWith(BASE_URL)) {
          urlList.push(u);
        }
      });
    }

    // If no specific postId provided (or batch=latest requested), submit core pages + latest 50 public property listings
    if (urlList.length === 0 || req.query?.batch === 'latest') {
      urlList.push(`${BASE_URL}/`);
      urlList.push(`${BASE_URL}/property-news`);
      urlList.push(`${BASE_URL}/map`);
      urlList.push(`${BASE_URL}/about`);

      let posts = null;
      try {
        const ghRes = await fetch(`https://raw.githubusercontent.com/cym10003-cyber/landing-page/main/data/posts.json?t=${Date.now()}`, {
          headers: { 'User-Agent': 'Vercel-Serverless-Function', 'Cache-Control': 'no-cache' }
        });
        if (ghRes.ok) posts = await ghRes.json();
      } catch (e) {}

      if (!posts) {
        const postsPath = path.join(process.cwd(), 'data', 'posts.json');
        if (fs.existsSync(postsPath)) {
          posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
        }
      }

      if (Array.isArray(posts)) {
        posts
          .filter(p => p && p.id && p.isPrivate !== true)
          .slice(0, 50)
          .forEach(p => {
            urlList.push(`${BASE_URL}/news-detail?id=${p.id}`);
          });
      }
    }
  } catch (e) {}

  urlList = [...new Set(urlList)];

  const payload = {
    host: SITE_HOST,
    key: INDEXNOW_KEY,
    keyLocation: KEY_LOCATION,
    urlList
  };

  const endpoints = [
    { name: 'Naver Search Advisor IndexNow', url: 'https://searchadvisor.naver.com/indexnow' },
    { name: 'Global IndexNow (Bing / ChatGPT / Yandex)', url: 'https://api.indexnow.org/indexnow' }
  ];

  const results = [];
  await Promise.all(
    endpoints.map(async (ep) => {
      try {
        const r = await fetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload)
        });
        results.push({ engine: ep.name, status: r.status, ok: r.ok });
      } catch (err) {
        results.push({ engine: ep.name, status: 0, ok: false, error: err.message });
      }
    })
  );

  return res.status(200).json({
    ok: true,
    submittedCount: urlList.length,
    sampleUrls: urlList.slice(0, 5),
    results
  });
}
