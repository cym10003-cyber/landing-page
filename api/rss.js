import fs from 'fs';
import path from 'path';

function escapeXml(unsafe) {
  return (unsafe || '').replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export default function handler(req, res) {
  const postsPath = path.join(process.cwd(), 'data', 'posts.json');
  let posts = [];

  try {
    if (fs.existsSync(postsPath)) {
      posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading posts.json for RSS:', e);
  }

  // Get the latest 30 posts
  const latestPosts = posts.slice(0, 30);

  const host = req.headers.host || 'choi114.com';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${protocol}://${host}`;

  const rssItems = latestPosts.map(post => {
    const postUrl = `${baseUrl}/news-detail?id=${post.id}`;
    
    // Convert content to plain text and escape
    let plainText = (post.content || '')
      .replace(/!\[.*?\]\(.*?\)/g, '') // remove images
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // remove links
      .replace(/[#*`_-]/g, '') // remove markdown characters
      .replace(/\s+/g, ' ')
      .trim();

    if (plainText.length > 200) {
      plainText = plainText.substring(0, 200) + '...';
    }

    const pubDate = post.id ? new Date(Number(post.id)).toUTCString() : new Date().toUTCString();

    return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(postUrl)}</link>
      <guid isPermaLink="true">${escapeXml(postUrl)}</guid>
      <description>${escapeXml(plainText)}</description>
      <pubDate>${pubDate}</pubDate>
    </item>`;
  }).join('');

  const nowString = new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>최가네부동산공인중개사사무소</title>
    <link>${baseUrl}</link>
    <description>대구 전 지역 상가, 사무실 임대 및 건물 매매 추천 리스트</description>
    <language>ko-KR</language>
    <lastBuildDate>${nowString}</lastBuildDate>
    <atom:link href="${baseUrl}/rss" rel="self" type="application/rss+xml" />
    ${rssItems}
  </channel>
</rss>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.status(200).send(xml);
}
