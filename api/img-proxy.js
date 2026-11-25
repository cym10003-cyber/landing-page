const ALLOWED_HOSTS = new Set([
  'www.choi114.com',
  'choi114.com',
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'raw.githubusercontent.com',
  'cdn.statically.io',
  'images.unsplash.com',
  'lh3.googleusercontent.com',
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org'
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const rawUrl = req.query?.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid url parameter' });
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return res.status(400).json({ error: 'Invalid protocol' });
  }

  if (!ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
    return res.status(403).json({ error: 'Host not allowed' });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Choi114BriefingPDF/1.0 (+https://www.choi114.com)',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).end();
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/') && !contentType.includes('octet-stream')) {
      return res.status(415).json({ error: 'Unsupported media type' });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).json({ error: 'Image fetch failed' });
  }
}
