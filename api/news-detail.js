import fs from 'fs';
import path from 'path';

function parsePostMeta(post, baseUrl = 'https://choi114.com') {
  const content = post.content || '';
  const title = post.title || '';
  const address = post.address || '';
  const coords = post.coordinates || [35.8589, 128.632];
  const pid = post.id || '';
  const postUrl = `${baseUrl}/news-detail?id=${pid}`;

  // 1. First image or default
  const firstImgMatch = content.match(/!\[.*?\]\((.*?)\)/);
  const ogImage = firstImgMatch ? firstImgMatch[1] : `${baseUrl}/og_home.jpg`;

  // 2. Extract Location
  let loc = address;
  if (!loc) {
    const mLoc = content.match(/위치\s*:\s*([^\n]+)/);
    if (mLoc) loc = mLoc[1].trim();
  }
  if (!loc) {
    const mTloc = title.match(/(대구\s*[가-힣]+구?\s*[가-힣0-9]+동?)/);
    if (mTloc) loc = mTloc[1].trim();
  }
  if (!loc) loc = '대구';
  const cleanLoc = loc.replace('대구광역시', '대구').trim();

  // 3. Extract Price
  const mDep = content.match(/보증금\s*:\s*([^\n]+)/);
  const deposit = mDep ? mDep[1].trim() : '';

  const mRent = content.match(/월세\s*:\s*([^\n]+)/);
  const rent = mRent ? mRent[1].trim() : '';

  const mSale = content.match(/매매가\s*:\s*([^\n]+)/);
  const sale = mSale ? mSale[1].trim() : '';

  function formatPriceVal(v) {
    return v.replace(/부가세\s*별도/g, '').replace(/만원/g, '만').replace(/원/g, '')
      .replace(/3000만/g, '3천').replace(/5000만/g, '5천').replace(/2000만/g, '2천').replace(/1000만/g, '1천').trim();
  }

  const priceParts = [];
  if (deposit) priceParts.push(`보증금 ${formatPriceVal(deposit)}`);
  if (rent) priceParts.push(`월 ${formatPriceVal(rent)}`);
  if (sale) priceParts.push(`매매가 ${formatPriceVal(sale)}`);
  const priceStr = priceParts.join(' / ');

  // 4. Extract Area
  const mArea = content.match(/(?:전용면적|공급면적)\s*:\s*([^\n]+)/);
  const area = mArea ? mArea[1].trim() : '';

  // 5. Type & Trade
  let pType = '상가/사무실';
  if (/사무실/i.test(title) || /사무실/i.test(content)) pType = '사무실';
  if (/상가/i.test(title) || /상가/i.test(content)) {
    pType = (pType !== '사무실') ? '상가' : '상가·사무실';
  }
  if (/병의원|병원|의원/i.test(title) || /병의원|병원|의원/i.test(content)) pType = '병의원';

  let trade = '임대';
  if (/매매/i.test(title) || /매매/i.test(content) || sale) trade = '매매';
  const fullType = `${pType} ${trade}`;

  // 3-Tier Local Keyword extraction: Dong, Gu, Daegu (e.g. "범어동사무실임대 수성구사무실임대 대구사무실임대")
  const fullLocText = `${cleanLoc} ${title} ${content.slice(0, 150)}`;
  const mGu = fullLocText.match(/(달서구|수성구|중구|서구|북구|동구|남구|달성군)/);
  const mDong = fullLocText.match(/([가-힣]{2,6}(?:동[0-9]*가?|읍|면))/);
  const guStr = mGu ? mGu[1] : '';
  const dongStr = mDong ? mDong[1] : '';

  let mainCategory = '상가';
  if (/상가/i.test(title)) mainCategory = '상가';
  else if (/사무실/i.test(title)) mainCategory = '사무실';
  else if (/공장/i.test(title) || /공장/i.test(content)) mainCategory = '공장';
  else if (/병의원|병원|의원/i.test(title) || /병의원|병원|의원/i.test(content)) mainCategory = '병의원';
  else if (/사무실/i.test(content)) mainCategory = '사무실';

  const kwList = [];
  if (dongStr) kwList.push(`${dongStr}${mainCategory}${trade}`);
  if (guStr) kwList.push(`${guStr}${mainCategory}${trade}`);

  if (trade === '임대') {
    kwList.push('대구상가임대');
    kwList.push('대구사무실임대');
  } else {
    if (mainCategory === '공장') {
      kwList.push('대구공장매매');
    } else {
      kwList.push('대구상가매매');
      kwList.push('대구사무실매매');
    }
  }

  const uniqueKws = [...new Set(kwList)];
  const targetKw = uniqueKws.join(' ');

  // Format Title: [타깃키워드] | [지역] [매물종류] - [가격] | 최가네부동산
  let metaTitle = `${targetKw} | ${cleanLoc} ${fullType}`;
  if (priceStr) metaTitle += ` - ${priceStr}`;
  metaTitle += ' | 최가네부동산';

  // Format Description
  const descParts = [`${targetKw}`, `${cleanLoc} ${fullType}`];
  if (area) descParts.push(`면적: ${area}`);
  if (priceStr) descParts.push(`가격: ${priceStr}`);

  const mFeat = [...content.matchAll(/(?:🔎|O|▶)\s*([^\n]+)/g)].map(m => m[1].trim());
  if (mFeat.length > 0) descParts.push(mFeat.slice(0, 2).join(', '));

  const metaDesc = descParts.join(' | ') + ' | 최가네부동산공인중개사사무소 (대표소장 최이명 010-3548-4000)';

  // RealEstateListing JSON-LD Schema Markup
  const dateStr = post.id ? new Date(Number(post.id)).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

  const schemaJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'RealEstateListing',
        'name': metaTitle,
        'description': metaDesc,
        'url': postUrl,
        'image': [ogImage],
        'datePosted': dateStr,
        'offers': {
          '@type': 'Offer',
          'priceCurrency': 'KRW',
          'price': priceStr || '0',
          'businessFunction': trade === '매매' ? 'http://purl.org/goodrelations/v1#Sell' : 'http://purl.org/goodrelations/v1#LeaseOut',
          'availability': 'https://schema.org/InStock',
          'seller': {
            '@type': 'RealEstateAgent',
            'name': '최가네부동산공인중개사사무소',
            'telephone': '010-3548-4000',
            'image': `${baseUrl}/og_home.jpg`
          }
        },
        'itemOffered': {
          '@type': 'CommercialProperty',
          'name': title,
          'address': {
            '@type': 'PostalAddress',
            'addressLocality': '대구광역시',
            'streetAddress': cleanLoc,
            'addressCountry': 'KR'
          },
          'geo': {
            '@type': 'GeoCoordinates',
            'latitude': coords[0] || 35.8589,
            'longitude': coords[1] || 128.632
          }
        }
      },
      {
        '@type': 'WebSite',
        'name': '최가네부동산공인중개사사무소',
        'alternateName': '최가네부동산',
        'url': baseUrl
      },
      {
        '@type': 'BreadcrumbList',
        'itemListElement': [
          {
            '@type': 'ListItem',
            'position': 1,
            'name': '최가네부동산',
            'item': baseUrl
          },
          {
            '@type': 'ListItem',
            'position': 2,
            'name': '매물리스트',
            'item': `${baseUrl}/property-news?category=매물리스트`
          }
        ]
      }
    ]
  };

  return { metaTitle, metaDesc, ogImage, postUrl, schemaJsonLd };
}

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
          const host = req.headers.host || 'choi114.com';
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const baseUrl = `${protocol}://${host}`;

          const { metaTitle, metaDesc, ogImage, postUrl, schemaJsonLd } = parsePostMeta(post, baseUrl);

          // Compile escaped values
          const titleEscaped = metaTitle.replace(/"/g, '&quot;');
          const descEscaped = metaDesc.replace(/"/g, '&quot;');
          const imageEscaped = ogImage.replace(/"/g, '&quot;');
          const urlEscaped = postUrl.replace(/"/g, '&quot;');

          // JSON-LD Script tag string
          const jsonLdScript = `\n<script type="application/ld+json" id="schema-jsonld">\n${JSON.stringify(schemaJsonLd, null, 2)}\n</script>\n`;

          // Inject JSON-LD Schema Markup into <head>
          html = html.replace('</head>', `${jsonLdScript}</head>`);

          // Replace meta and title tags
          html = html
            .replace(
              /<title>부동산 뉴스 &amp; 소식 상세 - 최가네부동산공인중개사사무소<\/title>/,
              `<title>${titleEscaped}</title>`
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
              /<link rel="canonical" href="https:\/\/choi114.com\/news-detail"\s*\/?>/,
              `<link rel="canonical" href="${urlEscaped}" />`
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

          // Parse content into pre-rendered images HTML and clean text HTML (prevents raw markdown link flashing)
          const lines = (post.content || '').split('\n');
          const preImages = [];
          const preText = [];

          for (let line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const mImg = trimmed.match(/!\[.*?\]\((.*?)\)/);
            if (mImg) {
              const imgUrl = mImg[1];
              preImages.push(`<img src="${imgUrl}" class="max-w-full h-auto rounded-xl shadow-card-soft border border-hairline my-md mx-auto block" loading="lazy" alt="매물 사진" />`);
            } else {
              let cleanText = trimmed
                .replace(/!\[.*?\]\(.*?\)/g, '')
                .replace(/\[(.*?)\]\(.*?\)/g, '$1')
                .replace(/[#*`_-]/g, '')
                .trim();
              if (cleanText) {
                preText.push(`<p style="margin-bottom: 12px; line-height: 1.6;">${cleanText}</p>`);
              }
            }
          }

          const preImagesHtml = preImages.join('\n');
          const preTextHtml = preText.join('\n');

          if (preImagesHtml) {
            html = html.replace(
              '<div id="post-images" class="text-ink leading-relaxed prose prose-blue max-w-none text-base hidden">',
              `<div id="post-images" class="text-ink leading-relaxed prose prose-blue max-w-none text-base">${preImagesHtml}`
            );
          }

          html = html.replace('id="map-link" href="map.html"', `id="map-link" href="map.html?id=${pid}"`);
          html = html.replace('내용을 불러오는 중입니다...', preTextHtml);
        }
      }
    } catch (err) {
      console.error('Error rewriting news-detail SEO dynamically:', err);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=0, max-age=0, must-revalidate, no-store, no-cache');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).send(html);
}
