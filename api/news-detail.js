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

  // 4. Extract Area & Floor with Smart Pyeong Band Generator
  const mArea = content.match(/(?:전용면적|공급면적|면적|평수)\s*:\s*([^\n]+)/i);
  let areaStr = '';
  if (mArea) {
    const rawA = mArea[1].trim();
    const pMatch = rawA.match(/([0-9.]+\s*평)/);
    if (pMatch) areaStr = pMatch[1].replace(/\s+/g, '');
    else areaStr = rawA.split('/')[0].trim();
  } else {
    const pInContent = (title + ' ' + content).match(/([0-9.]+\s*평)/);
    if (pInContent) areaStr = pInContent[1].replace(/\s+/g, '');
  }

  let pyeongNum = 0;
  let pyeongBandStr = '';
  let upperBandStr = '';
  let fullAreaDisplay = areaStr;

  if (areaStr) {
    const numMatch = areaStr.match(/([0-9.]+)/);
    if (numMatch) {
      pyeongNum = Math.round(parseFloat(numMatch[1]));
      if (pyeongNum >= 10) {
        const decade = Math.floor(pyeongNum / 10) * 10;
        pyeongBandStr = `${decade}평대`;

        // If e.g. 48평, 58평, 28평 (remainder >= 7), also include round-up decade (50평대, 60평대, 30평대)
        if (pyeongNum % 10 >= 7) {
          upperBandStr = `${decade + 10}평대`;
        }

        if (pyeongNum % 10 !== 0) {
          fullAreaDisplay = `${areaStr}(${pyeongBandStr})`;
        }
      }
    }
  }

  const mFloor = content.match(/(?:해당층|층수|층)\s*:\s*([^\n]+)/i);
  let floorStr = '';
  if (mFloor) {
    const rawF = mFloor[1].trim();
    const fMatch = rawF.match(/((?:지하\s*)?[0-9]+층)/);
    if (fMatch) floorStr = fMatch[1].replace(/\s+/g, '');
    else floorStr = rawF.split('/')[0].trim();
  } else {
    const fInContent = (title + ' ' + content).match(/((?:지하\s*)?[0-9]+층)/);
    if (fInContent) floorStr = fInContent[1].replace(/\s+/g, '');
  }

  const specParts = [];
  if (floorStr) specParts.push(floorStr);
  if (fullAreaDisplay) specParts.push(fullAreaDisplay);
  const specStr = specParts.join(' · ');

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

  if (pyeongBandStr) {
    if (dongStr) kwList.push(`${dongStr}${pyeongBandStr}`);
    if (guStr) kwList.push(`${guStr}${pyeongBandStr}`);
  }
  if (upperBandStr) {
    if (dongStr) kwList.push(`${dongStr}${upperBandStr}`);
    if (guStr) kwList.push(`${guStr}${upperBandStr}`);
  }

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

  // Clean Professional High-Ranking Title Format: [키워드] | [지역] [매물종류] (층수·평수 / 가격) - 최가네부동산 010-3548-4000
  let metaTitle = `${targetKw} | ${cleanLoc} ${fullType}`;
  const detailParts = [];
  if (specStr) detailParts.push(specStr);
  if (priceStr) detailParts.push(priceStr);

  if (detailParts.length > 0) {
    metaTitle += ` (${detailParts.join(' / ')})`;
  }
  metaTitle += ' - 최가네부동산';

  // Clean Professional Description Format
  const descParts = [`${targetKw}`, `${cleanLoc} ${fullType}`];
  if (specStr) descParts.push(specStr);
  if (priceStr) descParts.push(`가격: ${priceStr}`);

  const mFeat = [...content.matchAll(/(?:🔎|O|▶)\s*([^\n]+)/g)].map(m => m[1].trim());
  if (mFeat.length > 0) descParts.push(mFeat.slice(0, 2).join(', '));

  const metaDesc = descParts.join(' | ') + ' | 대구 상가·사무실 위치기반 전문! (대표소장 최이명)';

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
            'telephone': '010 - 3548 - 4000',
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

export default async function handler(req, res) {
  const { id } = req.query;
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const htmlPath = path.join(process.cwd(), 'templates', 'news-detail-template.html');
  const postsPath = path.join(process.cwd(), 'data', 'posts.json');

  let html = '';
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (e) {
    return res.status(500).send('Error reading templates/news-detail-template.html template');
  }

  // If there is an ID, find the post
  if (id) {
    try {
      let posts = null;

      // Try fetching fresh posts from GitHub first
      try {
        const ghRes = await fetch(`https://raw.githubusercontent.com/cym10003-cyber/landing-page/main/data/posts.json?t=${Date.now()}&r=${Math.random()}`, {
          headers: {
            'User-Agent': 'Vercel-Serverless-Function',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          }
        });
        if (ghRes.ok) {
          posts = await ghRes.json();
        }
      } catch (ghErr) {
        console.warn('GitHub raw fetch failed, using local posts.json fallback:', ghErr);
      }

      if (!posts && fs.existsSync(postsPath)) {
        posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
      }

      if (posts && Array.isArray(posts)) {
        let post = posts.find(p => p.id.toString() === id.toString());
        if (!post) {
          const cleanId = String(id).replace(/[^0-9]/g, '');
          if (cleanId) {
            post = posts.find(p => {
              const pidStr = String(p.id);
              const titleStr = p.title || '';
              const contentStr = p.content || '';
              return pidStr === cleanId || pidStr.includes(cleanId) ||
                     titleStr.includes(`매물번호:${cleanId}`) || titleStr.includes(`매물번호 : ${cleanId}`) ||
                     contentStr.includes(`매물번호:${cleanId}`) || contentStr.includes(`매물번호 : ${cleanId}`);
            });
          }
        }
        if (post) {
          const host = req.headers.host || 'choi114.com';
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const baseUrl = `${protocol}://${host}`;

          const pid = post.id;
          const { metaTitle, metaDesc, ogImage, postUrl, schemaJsonLd } = parsePostMeta(post, baseUrl);

          // Compile escaped values
          const titleEscaped = metaTitle.replace(/"/g, '&quot;');
          const descEscaped = metaDesc.replace(/"/g, '&quot;');
          const imageEscaped = ogImage.replace(/"/g, '&quot;');
          const urlEscaped = postUrl.replace(/"/g, '&quot;');

          // JSON-LD Script tag string
          const jsonLdScript = `\n<script type="application/ld+json" id="schema-jsonld">\n${JSON.stringify(schemaJsonLd, null, 2)}\n</script>\n`;

          // Inject initial post object script tag string into <head> for 0ms instant client rendering
          const initialPostScript = `\n<script>\nwindow.__INITIAL_POST__ = ${JSON.stringify(post)};\n</script>\n`;
          html = html.replace('</head>', `${jsonLdScript}${initialPostScript}</head>`);

          // Replace meta and title tags dynamically for OpenGraph crawlers
          html = html
            .replace(
              /<title>.*?<\/title>/i,
              `<title>${titleEscaped}</title>`
            )
            .replace(
              /<meta name="description" content="[^"]*"\s*\/?>/i,
              `<meta name="description" content="${descEscaped}" />`
            )
            .replace(
              /<meta property="og:title" content="[^"]*"\s*\/?>/i,
              `<meta property="og:title" content="${titleEscaped}" />`
            )
            .replace(
              /<meta property="og:description" content="[^"]*"\s*\/?>/i,
              `<meta property="og:description" content="${descEscaped}" />`
            )
            .replace(
              /<meta property="og:image" content="[^"]*"\s*\/?>/i,
              `<meta property="og:image" content="${imageEscaped}" />`
            )
            .replace(
              /<meta property="og:url" content="[^"]*"\s*\/?>/i,
              `<meta property="og:url" content="${urlEscaped}" />`
            )
            .replace(
              /<link rel="image_src" href="[^"]*"\s*\/?>/i,
              `<link rel="image_src" href="${imageEscaped}" />`
            )
            .replace(
              /<link rel="canonical" href="[^"]*"\s*\/?>/i,
              `<link rel="canonical" href="${urlEscaped}" />`
            )
            .replace(
              /<meta name="twitter:title" content="[^"]*"\s*\/?>/i,
              `<meta name="twitter:title" content="${titleEscaped}" />`
            )
            .replace(
              /<meta name="twitter:description" content="[^"]*"\s*\/?>/i,
              `<meta name="twitter:description" content="${descEscaped}" />`
            )
            .replace(
              /<meta name="twitter:image" content="[^"]*"\s*\/?>/i,
              `<meta name="twitter:image" content="${imageEscaped}" />`
            );

          // Pre-render Title, Category, and Date in HTML to eliminate 0ms loading text delay
          html = html
            .replace(
              '<span id="post-category" class="bg-dark-chip text-white px-2.5 py-1 rounded text-xs font-semibold">매물리스트</span>',
              `<span id="post-category" class="bg-dark-chip text-white px-2.5 py-1 rounded text-xs font-semibold">${post.category || '일반'}</span>`
            )
            .replace(
              '<h1 id="post-title" class="font-display-hero-mobile md:font-subsection-h3 text-2xl md:text-3xl text-ink font-bold leading-snug">로딩 중...</h1>',
              `<h1 id="post-title" class="font-display-hero-mobile md:font-subsection-h3 text-2xl md:text-3xl text-ink font-bold leading-snug">${post.title}</h1>`
            )
            .replace(
              '<span id="post-date" class="text-xs text-slate-500 font-medium"></span>',
              `<span id="post-date" class="text-xs text-slate-500 font-medium">${post.date || ''}</span>`
            );

          // Parse content into pre-rendered images HTML and clean text HTML
          const isHtmlPost = /<\/?(div|p|span|table|tr|td|th|tbody|thead|style|img|iframe|h[1-6]|ul|ol|li|br|b|i|strong|em|u|a|section|article|header|footer)[\s>\/]/i.test(post.content || '');

          const lines = (post.content || '').split('\n');
          const preImages = [];
          const preText = [];

          let imgIndex = 0;
          for (let line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const mImg = trimmed.match(/!\[.*?\]\((.*?)\)/);
            if (mImg) {
              const imgUrl = mImg[1];
              const loadingAttr = imgIndex === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
              preImages.push(`<img src="${imgUrl}" class="max-w-full h-auto rounded-xl shadow-card-soft border border-hairline my-md mx-auto block" ${loadingAttr} alt="매물 사진" />`);
              imgIndex++;
            } else if (!isHtmlPost) {
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
          if (preTextHtml) {
            html = html.replace('내용을 불러오는 중입니다...', preTextHtml);
          }
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
