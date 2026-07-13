import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const { id } = req.query;
  const htmlPath = path.join(process.cwd(), 'templates', 'news-detail.html');
  const postsPath = path.join(process.cwd(), 'data', 'posts.json');

  let html = '';
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (e) {
    return res.status(500).send('Error reading templates/news-detail.html template');
  }

  // If there is an ID, find the post
  if (id) {
    try {
      if (fs.existsSync(postsPath)) {
        const posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
        const post = posts.find(p => p.id.toString() === id.toString());
        if (post) {
          // Extract first image
          const firstImgMatch = (post.content || '').match(/!\[.*?\]\((.*?)\)/);
          const ogImage = firstImgMatch ? firstImgMatch[1] : 'https://choi114.com/og_home.jpg';

          // Extract plain text for description
          let plainText = (post.content || '')
            .replace(/!\[.*?\]\(.*?\)/g, '') // remove images
            .replace(/\[(.*?)\]\(.*?\)/g, '$1') // remove links
            .replace(/[#*`_-]/g, '') // remove markdown characters
            .replace(/\s+/g, ' ')
            .trim();
          
          if (plainText.length > 150) {
            plainText = plainText.substring(0, 150) + '...';
          }
          if (!plainText) {
            plainText = '최가네부동산의 대구 전 지역 상업용 매물 상세 정보 및 최신 소식을 확인해 보세요.';
          }

          // Compile replacements
          const titleEscaped = post.title.replace(/"/g, '&quot;');
          const descEscaped = plainText.replace(/"/g, '&quot;');
          const imageEscaped = ogImage.replace(/"/g, '&quot;');
          const urlEscaped = `https://choi114.com/news-detail?id=${id}`;

          // Replace tags
          html = html
            .replace(
              /<title>부동산 뉴스 &amp; 소식 상세 - 최가네부동산공인중개사사무소<\/title>/,
              `<title>${titleEscaped} - 최가네부동산공인중개사사무소</title>`
            )
            .replace(
              /<meta name="description" content="최가네부동산의 대구 상가, 사무실 임대 및 분양 소식 상세 페이지입니다."\s*\/?>/,
              `<meta name="description" content="${descEscaped}" />`
            )
            .replace(
              /<meta property="og:title" content="부동산 뉴스 &amp; 소식 상세 - 최가네부동산공인중개사사무소"\s*\/?>/,
              `<meta property="og:title" content="${titleEscaped}" />`
            )
            .replace(
              /<meta property="og:description" content="최가네부동산의 대구 전 지역 상업용 매물 상세 정보 및 최신 소식을 확인해 보세요."\s*\/?>/,
              `<meta property="og:description" content="${descEscaped}" />`
            )
            .replace(
              /<meta property="og:image" content="https:\/\/choi114.com\/og_home.jpg"\s*\/?>/,
              `<meta property="og:image" content="${imageEscaped}" />`
            )
            .replace(
              /<meta property="og:url" content="https:\/\/choi114.com\/news-detail"\s*\/?>/,
              `<meta property="og:url" content="${urlEscaped}" />`
            )
            .replace(
              /<meta name="twitter:title" content="부동산 뉴스 &amp; 소식 상세 - 최가네부동산공인중개사사무소"\s*\/?>/,
              `<meta name="twitter:title" content="${titleEscaped}" />`
            )
            .replace(
              /<meta name="twitter:description" content="최가네부동산의 최신 소식을 확인해 보세요."\s*\/?>/,
              `<meta name="twitter:description" content="${descEscaped}" />`
            )
            .replace(
              /<meta name="twitter:image" content="https:\/\/choi114.com\/og_home.jpg"\s*\/?>/,
              `<meta name="twitter:image" content="${imageEscaped}" />`
            );
        }
      }
    } catch (err) {
      console.error('Error rewriting news-detail SEO dynamically:', err);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
}
