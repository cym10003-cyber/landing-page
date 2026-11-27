import fs from 'fs';
import path from 'path';

function extractPropertyNumber(p) {
  if (!p) return '';
  const fullText = ((p.title || '') + ' ' + (p.content || '')).normalize('NFC');
  const m = fullText.match(/매물\s*번호\s*[:：]?\s*([0-9]{3,5})/i);
  if (m) return m[1];
  const m2 = fullText.match(/(?:NO|No|no)\.?\s*([0-9]{3,5})/);
  if (m2) return m2[1];
  return String(p.id || '').slice(-4);
}

function parsePostMeta(post, baseUrl = 'https://www.choi114.com') {
  const rawContent = (post.content || '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const content = rawContent
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ');
  const title = post.title || '';
  const address = post.address || '';
  const coords = post.coordinates || [35.8589, 128.632];
  const pid = post.id || '';
  const postUrl = `${baseUrl}/news-detail?id=${pid}`;

  // 1. First image or default (supports both markdown ![](url) and HTML <img src="url">)
  const firstImgMatch = rawContent.match(/!\[.*?\]\((.*?)\)/) || rawContent.match(/<img[^>]+src=["']([^"']+)["']/i);
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

  function parseKoreanPriceToWon(rawVal) {
    if (!rawVal) return 0;
    const s = String(rawVal).replace(/,/g, '').trim();
    let totalManwon = 0;
    const eokMatch = s.match(/([0-9.]+)\s*억/);
    if (eokMatch) totalManwon += parseFloat(eokMatch[1]) * 10000;
    const cheonMatch = s.match(/([0-9.]+)\s*천/);
    if (cheonMatch) totalManwon += parseFloat(cheonMatch[1]) * 1000;
    const manMatch = s.match(/([0-9.]+)\s*만/);
    if (manMatch) {
      totalManwon += parseFloat(manMatch[1]);
    } else if (!eokMatch && !cheonMatch) {
      const pureNum = s.match(/([0-9.]+)/);
      if (pureNum) totalManwon += parseFloat(pureNum[1]);
    }
    return Math.round(totalManwon * 10000);
  }

  const priceParts = [];
  if (deposit) priceParts.push(`보증금 ${formatPriceVal(deposit)}`);
  if (rent) priceParts.push(`월 ${formatPriceVal(rent)}`);
  if (sale) priceParts.push(`매매가 ${formatPriceVal(sale)}`);
  const priceStr = priceParts.join(' / ');
  const saleWon = parseKoreanPriceToWon(sale);
  const rentWon = parseKoreanPriceToWon(rent);
  const depositWon = parseKoreanPriceToWon(deposit);
  const numericPriceWon = saleWon || rentWon || depositWon || 0;

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
      pyeongNum = Math.floor(parseFloat(numMatch[1]));
      const bandFloor = Math.floor(pyeongNum / 10) * 10;
      if (bandFloor >= 10) {
        pyeongBandStr = `${bandFloor}평대`;
        upperBandStr = `${bandFloor}평`;
      }
      if (!areaStr.includes('평')) {
        fullAreaDisplay = `${areaStr} (${pyeongNum}평)`;
      }
    }
  }

  const mFloor = content.match(/(?:해당층|층수|층)\s*:\s*([^\n]+)/i);
  let floorStr = '';
  if (mFloor) {
    floorStr = mFloor[1].trim().split('/')[0].trim();
    if (!floorStr.includes('층') && /^\d+$/.test(floorStr)) {
      floorStr += '층';
    }
  } else {
    const fInContent = (title + ' ' + content).match(/([0-9]+층|지하[0-9]+층|B[0-9]+층)/i);
    if (fInContent) floorStr = fInContent[1];
  }

  const specParts = [];
  if (floorStr) specParts.push(floorStr);
  if (fullAreaDisplay) specParts.push(fullAreaDisplay);
  const specStr = specParts.join(' ');

  // 5. Intelligent Category & Keyword Generation
  let trade = '임대';
  if (/매매/i.test(title) || /매매가/i.test(content) || sale) trade = '매매';

  let fullType = '상가 임대';
  if (/사무실/i.test(title)) fullType = `사무실 ${trade}`;
  else if (/상가/i.test(title)) fullType = `상가 ${trade}`;
  else if (/공장/i.test(title)) fullType = `공장 ${trade}`;
  else if (/병의원|병원|의원/i.test(title)) fullType = `병의원 ${trade}`;
  else if (/학원/i.test(title)) fullType = `학원 ${trade}`;
  else if (post.category && post.category !== '매물리스트') fullType = `${post.category} ${trade}`;

  const fullLocText = cleanLoc + ' ' + title + ' ' + content;
  const mGu = fullLocText.match(/((?:수성|달서|중|동|서|남|북)구|(?:달성|칠곡)군|경산시)/);
  const mDong = fullLocText.match(/([가-힣]{2,6}(?:동[0-9]*가?|읍|면))/);
  const guStr = mGu ? mGu[1] : '';
  const dongStr = mDong ? mDong[1] : '';

  let mainCategory = '상가';
  if (/사무실/i.test(title)) mainCategory = '사무실';
  else if (/상가/i.test(title)) mainCategory = '상가';
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
    kwList.push('대구상가월세');
    if (guStr) {
      kwList.push(`${guStr}상가임대`);
      kwList.push(`${guStr}사무실임대`);
    }
  } else {
    if (mainCategory === '공장') {
      kwList.push('대구공장매매');
    } else {
      kwList.push('대구상가매매');
      kwList.push('대구사무실매매');
      kwList.push('대구건물매매');
      kwList.push('대구상가건물매매');
      if (guStr) {
        kwList.push(`${guStr}상가매매`);
        kwList.push(`${guStr}건물매매`);
      }
      if (title.includes('상가주택') || content.includes('상가주택')) { kwList.push('대구상가주택매매'); }
      if (cleanLoc.includes('경산') || title.includes('경산')) { kwList.push('경산상가매매'); }
    }
  }

  const uniqueKws = [...new Set(kwList)];
  const titleKw = uniqueKws.slice(0, 3).join(' ');
  const descKw = uniqueKws.slice(0, 4).join(' ');
  const metaKeywords = uniqueKws.slice(0, 10).join(', ') + ', 최가네부동산';

  // Clean Professional High-Ranking Title Format (Concise & Spam-Free: max 3 core keywords)
  let metaTitle = `${titleKw} | ${cleanLoc} ${fullType}`;
  const detailParts = [];
  if (specStr) detailParts.push(specStr);
  if (priceStr) detailParts.push(priceStr);

  if (detailParts.length > 0) {
    metaTitle += ` (${detailParts.join(' / ')})`;
  }
  metaTitle += ' - 최가네부동산';

  // Clean Professional Description Format
  const descParts = [`${descKw}`, `${cleanLoc} ${fullType}`];
  if (specStr) descParts.push(specStr);
  if (priceStr) descParts.push(`가격: ${priceStr}`);

  const mFeat = [...content.matchAll(/(?:🔎|O|▶)\s*([^\n]+)/g)].map(m => m[1].trim());
  if (mFeat.length > 0) descParts.push(mFeat.slice(0, 2).join(', '));

  const metaDesc = descParts.join(' | ') + ' | 대구 전 지역 상가·사무실 임대·매매 전문 최가네부동산 (대표소장 최이명)';

  // RealEstateListing JSON-LD Schema Markup
  const tsNum = Number(post.id);
  const dateStr = (!isNaN(tsNum) && tsNum > 1000000000000) ? new Date(tsNum).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const propNo = extractPropertyNumber(post);
  const featSummary = mFeat.length > 0 ? mFeat.slice(0, 3).join(', ') : `${cleanLoc} 핵심 상권 위치, 즉시 상담 가능`;

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
          'price': String(numericPriceWon),
          'description': priceStr || '상담 문의 (010-3548-4000)',
          'businessFunction': trade === '매매' ? 'http://purl.org/goodrelations/v1#Sell' : 'http://purl.org/goodrelations/v1#LeaseOut',
          'availability': 'https://schema.org/InStock',
          'seller': {
            '@type': 'RealEstateAgent',
            'name': '최가네부동산공인중개사사무소',
            'telephone': '010-3548-4000',
            'image': `${baseUrl}/og_home.jpg`,
            'knowsAbout': [
              '대구 상가 임대', '대구 사무실 임대', '대구 상가 매매', '대구 사무실 매매',
              '대구 건물 매매', '대구 상가건물 매매', '대구 상가주택 매매', '대구 부동산 매매',
              '대구 전지역 상가 임대', '수성구 상가 임대', '달서구 상가 임대', '중구 상가 임대',
              '동구 상가 임대', '북구 상가 임대', '서구 상가 임대', '남구 상가 임대', '달성군 상가 임대',
              '범어동 사무실 임대', '달구벌대로 상가', '경산 상가 매매',
              '대구 상가 월세', '대구 상가 전문 부동산'
            ]
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
            'latitude': coords[0] || 35.8599,
            'longitude': coords[1] || 128.6146
          }
        }
      },
      {
        '@type': 'BreadcrumbList',
        'itemListElement': guStr
          ? [
              {
                '@type': 'ListItem',
                'position': 1,
                'name': '최가네부동산',
                'item': baseUrl
              },
              {
                '@type': 'ListItem',
                'position': 2,
                'name': `대구 ${guStr} 상가·사무실`,
                'item': `${baseUrl}/property-news?category=${encodeURIComponent('매물리스트')}&region=${encodeURIComponent(guStr)}`
              },
              {
                '@type': 'ListItem',
                'position': 3,
                'name': `${cleanLoc} ${fullType} (#${propNo})`,
                'item': postUrl
              }
            ]
          : [
              {
                '@type': 'ListItem',
                'position': 1,
                'name': '최가네부동산',
                'item': baseUrl
              },
              {
                '@type': 'ListItem',
                'position': 2,
                'name': post.category || '매물리스트',
                'item': `${baseUrl}/property-news?category=${encodeURIComponent(post.category || '매물리스트')}`
              },
              {
                '@type': 'ListItem',
                'position': 3,
                'name': metaTitle,
                'item': postUrl
              }
            ]
      },
      {
        '@type': 'FAQPage',
        'mainEntity': [
          {
            '@type': 'Question',
            'name': `${cleanLoc} ${fullType} (매물번호 ${propNo})의 임대·매매 조건과 면적은 어떻게 되나요?`,
            'acceptedAnswer': {
              '@type': 'Answer',
              'text': `매물번호 ${propNo}번은 ${cleanLoc}에 위치한 ${fullType} 실매물로, ${specStr ? `규모는 ${specStr}이며 ` : ''}${priceStr ? `금액 조건은 ${priceStr}입니다.` : '합리적인 조건으로 진행 가능합니다.'} 상세 조건 협의는 최가네부동산(010-3548-4000)으로 문의해 주세요.`
            }
          },
          {
            '@type': 'Question',
            'name': `${cleanLoc} ${fullType} (매물번호 ${propNo})의 주요 특징은 무엇인가요?`,
            'acceptedAnswer': {
              '@type': 'Answer',
              'text': `${featSummary}. 대구 상가·사무실 전문 최가네부동산(대표소장 최이명)이 직접 확인한 100% 실매물입니다.`
            }
          }
        ]
      }
    ]
  };

  return { metaTitle, metaDesc, metaKeywords, ogImage, postUrl, schemaJsonLd, cleanLoc, coords, guStr, dongStr, fullType, trade, mainCategory, pyeongNum, rentWon, saleWon, depositWon, specStr, priceStr, propNo };
}

export default async function handler(req, res) {
  let id = req.query?.id;
  if (!id && req.url) {
    try {
      const parsedUrl = new URL(req.url, 'https://www.choi114.com');
      id = parsedUrl.searchParams.get('id');
    } catch (e) {}
  }

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

      // Tier 1: Try GitHub REST API for real-time un-cached content (data repo first, legacy fallback)
      const token = (process.env.GITHUB_TOKEN || '').trim();
      const dataRepos = ['landing-page-assets', 'landing-page'];
      for (const repoName of dataRepos) {
        if (posts) break;
        try {
          const ghApiUrl = `https://api.github.com/repos/cym10003-cyber/${repoName}/contents/data/posts.json?t=${Date.now()}`;
          const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Vercel-Serverless-Function' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const apiRes = await fetch(ghApiUrl, { headers, cache: 'no-store' });
          if (apiRes.ok) {
            const apiData = await apiRes.json();
            if (apiData && apiData.content) {
              const contentStr = Buffer.from(apiData.content, 'base64').toString('utf8');
              posts = JSON.parse(contentStr);
            }
          }
        } catch (e) {}
      }

      // Tier 2: Try fetching raw posts from GitHub
      if (!posts) {
        for (const repoName of dataRepos) {
          if (posts) break;
          try {
            const ghRes = await fetch(`https://raw.githubusercontent.com/cym10003-cyber/${repoName}/main/data/posts.json?t=${Date.now()}&r=${Math.random()}`, {
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
            console.warn(`GitHub raw fetch failed (${repoName}):`, ghErr);
          }
        }
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
          const host = 'www.choi114.com';
          const protocol = 'https';
          const baseUrl = `${protocol}://${host}`;

          const pid = post.id;
          const { metaTitle, metaDesc, metaKeywords, ogImage, postUrl, schemaJsonLd, cleanLoc, coords, guStr, dongStr, fullType, trade, mainCategory, pyeongNum, rentWon, saleWon, specStr, priceStr } = parsePostMeta(post, baseUrl);

          // Compile escaped values
          const titleEscaped = metaTitle.replace(/"/g, '&quot;');
          const descEscaped = metaDesc.replace(/"/g, '&quot;');
          const imageEscaped = ogImage.replace(/"/g, '&quot;');
          const urlEscaped = postUrl.replace(/"/g, '&quot;');

          // JSON-LD Script tag string
          const jsonLdScript = `\n<script type="application/ld+json" id="schema-jsonld">\n${JSON.stringify(schemaJsonLd, null, 2)}\n</script>\n`;

          // Inject initial post object script tag string, robots directive, and meta keywords into <head>
          const keywordsEscaped = (metaKeywords || '').replace(/"/g, '&quot;');
          const robotsDirective = post.isPrivate === true ? 'noindex, nofollow' : 'index, follow, max-image-preview:large';
          const robotsMeta = `\n<meta name="robots" content="${robotsDirective}" />`;
          const keywordsMeta = `\n<meta name="keywords" content="${keywordsEscaped}" />\n`;
          const initialPostScript = `\n<script>\nwindow.__INITIAL_POST__ = ${JSON.stringify(post)};\n</script>\n`;
          html = html
            .replace(/<meta name="geo\.placename" content="[^"]*"\s*\/?>/i, `<meta name="geo.placename" content="${cleanLoc.replace(/"/g, '&quot;')}" />`)
            .replace(/<meta name="geo\.position" content="[^"]*"\s*\/?>/i, `<meta name="geo.position" content="${coords[0] || 35.8599};${coords[1] || 128.6146}" />`)
            .replace(/<meta name="ICBM" content="[^"]*"\s*\/?>/i, `<meta name="ICBM" content="${coords[0] || 35.8599}, ${coords[1] || 128.6146}" />`)
            .replace('</head>', `${robotsMeta}${keywordsMeta}${jsonLdScript}${initialPostScript}</head>`);

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
          const realPropNo = extractPropertyNumber(post);
          html = html
            .replace(
              /<span id="post-category"[^>]*>.*?<\/span>/i,
              `<span id="post-category" class="bg-dark-chip text-white px-2.5 py-1 rounded text-xs font-semibold whitespace-nowrap">${post.category || '일반'}</span>`
            )
            .replace(
              /<h1 id="post-title"[^>]*>.*?<\/h1>/i,
              `<h1 id="post-title" class="font-display-hero-mobile md:font-subsection-h3 text-2xl md:text-3xl text-ink font-bold leading-snug">${post.title}</h1>`
            )
            .replace(
              /<span id="call-guide-pid"[^>]*>.*?<\/span>/i,
              `<span id="call-guide-pid">${realPropNo}</span>`
            )
            .replace(/<span id="post-date"[^>]*>.*?<\/span>/i, '<span id="post-date" class="hidden"></span>');

          // Parse content into pre-rendered images HTML and clean text HTML
          const isHtmlPost = /<\/?(div|p|span|table|tr|td|th|tbody|thead|style|img|iframe|h[1-6]|ul|ol|li|br|b|i|strong|em|u|a|section|article|header|footer)[\s>\/]/i.test(post.content || '');

          const lines = (post.content || '').split('\n');
          const preImages = [];
          const preText = [];

          let imgIndex = 0;
          for (let line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const imgMatch = trimmed.match(/!\[(.*?)\]\((.*?)\)/);
            if (imgMatch) {
              const rawAlt = (imgMatch[1] || '').trim().replace(/\s*-\s*복사본\s*$/, '').trim();
              const isGenericAlt = !rawAlt
                || /KakaoTalk_|post_img_|01035484000/i.test(rawAlt)
                || /^(image|사진\s*\d*|스크린샷|다운로드|캡처|무제|제목\s*없음|IMG_|DSC|PXL_|Screenshot|photo|pic|BandPhoto|SE-|\d{8}[_-]\d+)/i.test(rawAlt)
                || /\.(jpe?g|png|webp|gif|heic)$/i.test(rawAlt)
                || /^[0-9a-f]{16,}$/i.test(rawAlt)
                || /^[a-zA-Z0-9_\-\.\s()]+$/.test(rawAlt);
              const alt = isGenericAlt
                ? `${cleanLoc} ${fullType}${specStr ? ` (${specStr})` : ''} 실매물 현장사진 ${imgIndex + 1} - 최가네부동산 매물번호 ${realPropNo}`
                : rawAlt;
              const src = imgMatch[2];
              preImages.push(`
                <div class="mb-4 rounded-xl overflow-hidden shadow-card-soft bg-surface-container border border-hairline">
                  <img src="${src}" alt="${alt.replace(/"/g, '&quot;')}" onerror="if(typeof handlePostImgError==='function'){handlePostImgError(this, '${post.id}');}" class="w-full h-auto object-cover max-h-[600px] mx-auto" loading="lazy" />
                </div>
              `);
              imgIndex++;
            } else if (!isHtmlPost) {
              preText.push(`<p class="mb-3">${line}</p>`);
            }
          }

          if (preImages.length > 0) {
            html = html.replace(
              '<div id="post-images" class="text-ink leading-relaxed prose prose-blue max-w-none text-base hidden">',
              `<div id="post-images" class="text-ink leading-relaxed prose prose-blue max-w-none text-base mb-6">\n${preImages.join('\n')}`
            );
          }

          if (preText.length > 0) {
            html = html.replace(
              '<div id="post-text-content" class="text-ink leading-relaxed prose prose-blue max-w-none text-base">\n            내용을 불러오는 중입니다...\n        </div>',
              `<div id="post-text-content" class="text-ink leading-relaxed prose prose-blue max-w-none text-base">\n${preText.join('\n')}\n        </div>`
            );
          } else if (isHtmlPost) {
            const htmlBodyWithoutMdImgs = (post.content || '').replace(/!\[.*?\]\(.*?\)/g, '').trim();
            if (htmlBodyWithoutMdImgs) {
              html = html.replace(
                '<div id="post-text-content" class="text-ink leading-relaxed prose prose-blue max-w-none text-base">\n            내용을 불러오는 중입니다...\n        </div>',
                `<div id="post-text-content" class="text-ink leading-relaxed prose prose-blue max-w-none text-base">\n${htmlBodyWithoutMdImgs}\n        </div>`
              );
            }
          }

          // Pre-render AI/GEO Structured Property Spec Summary Table + Related Internal Links
          // Criteria: 1) Same trade type (임대 only with 임대, 매매 only with 매매)
          //           2) Same Dong (+10) & Gu (+5)
          //           3) Similar area in pyeong (±15평: +8, ±30평: +5, ±50평: +2)
          //           4) Similar monthly rent or sale price (±30%: +7, ±50%: +4)
          //           5) Same property category (+4)
          const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          const allOtherPublic = posts
            .filter(p => p && p.isPrivate !== true && String(p.id) !== String(post.id))
            .map(p => {
              const cm = parsePostMeta(p, baseUrl);
              return { p, cm };
            });

          const sameTradePool = allOtherPublic.filter(item => item.cm.trade === trade);
          const candidatePool = sameTradePool.length >= 6 ? sameTradePool : allOtherPublic;

          const relatedCandidates = candidatePool
            .map(({ p, cm }) => {
              let score = 0;
              // 0. Exact same trade type (임대 vs 매매)
              if (cm.trade === trade) score += 20;

              // 1. Geographic proximity (Dong & Gu)
              const pText = `${p.address || ''} ${p.title || ''}`;
              if (dongStr && (cm.dongStr === dongStr || pText.includes(dongStr))) score += 10;
              if (guStr && (cm.guStr === guStr || pText.includes(guStr))) score += 5;

              // 2. Property category match (사무실 / 상가 / 병의원 / 학원 / 공장)
              if (mainCategory && cm.mainCategory === mainCategory) score += 4;

              // 3. Area (Pyeong) similarity (±15평 / ±30평 / ±50평)
              if (pyeongNum > 0 && cm.pyeongNum > 0) {
                const pDiff = Math.abs(pyeongNum - cm.pyeongNum);
                if (pDiff <= 15) score += 8;
                else if (pDiff <= 30) score += 5;
                else if (pDiff <= 50) score += 2;
              }

              // 4. Price / Monthly Rent similarity (±30% / ±50%)
              if (trade === '임대' && rentWon > 0 && cm.rentWon > 0) {
                const rRatio = Math.abs(rentWon - cm.rentWon) / rentWon;
                if (rRatio <= 0.30) score += 7;
                else if (rRatio <= 0.50) score += 4;
              } else if (trade === '매매' && saleWon > 0 && cm.saleWon > 0) {
                const sRatio = Math.abs(saleWon - cm.saleWon) / saleWon;
                if (sRatio <= 0.30) score += 7;
                else if (sRatio <= 0.50) score += 4;
              }

              return { p, cm, score };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 6);

          const relatedCardsHtml = relatedCandidates.map(({ p: rp, cm }) => {
            const rpNo = cm.propNo || extractPropertyNumber(rp);
            const rpLoc = cm.cleanLoc || (rp.address || '대구').replace('대구광역시', '대구').trim();
            const rpUrl = `${baseUrl}/news-detail?id=${encodeURIComponent(String(rp.id))}`;
            return `
              <a href="${rpUrl}" class="group block p-3.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-[#003891] hover:shadow-sm transition-all no-underline">
                <div class="flex flex-wrap items-center justify-between gap-1.5 mb-1.5">
                  <div class="flex flex-wrap items-center gap-1">
                    <span class="px-2 py-0.5 rounded bg-slate-900 text-white text-[11px] font-black">#${escHtml(rpNo)}</span>
                    <span class="px-2 py-0.5 rounded bg-blue-50 text-[#003891] border border-blue-200 text-[11px] font-extrabold">${escHtml(rpLoc)}</span>
                    ${cm.specStr ? `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-bold">${escHtml(cm.specStr)}</span>` : ''}
                  </div>
                  <span class="text-[11px] font-bold text-slate-400 group-hover:text-[#003891] shrink-0">상세보기 →</span>
                </div>
                <div class="font-bold text-xs sm:text-sm text-slate-900 dark:text-white group-hover:text-[#003891] line-clamp-1 mb-1">
                  ${escHtml(rp.title || '')}
                </div>
                ${cm.priceStr ? `<div class="text-[11px] font-extrabold text-[#003891] dark:text-blue-300">${escHtml(cm.priceStr)}</div>` : ''}
              </a>
            `;
          }).join('');

          const regionLabel = dongStr ? `${guStr} ${dongStr}`.trim() : (guStr || cleanLoc || '대구');
          const bottomSsrHtml = `
            <section aria-label="매물 핵심 스펙 요약" class="bg-surface-container-lowest rounded-xl shadow-card-soft border border-hairline p-5 sm:p-6">
              <div class="flex items-center justify-between gap-2 mb-3 pb-2.5 border-b border-hairline">
                <h2 class="font-bold text-sm sm:text-base text-ink flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-primary text-[19px]">fact_check</span>
                  <span>매물번호 #${escHtml(realPropNo)} 핵심 스펙 요약</span>
                </h2>
                <span class="px-2 py-0.5 rounded bg-blue-50 text-[#003891] text-[11px] font-extrabold">최가네부동산 검증 실매물</span>
              </div>
              <dl class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs sm:text-sm">
                <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700">
                  <dt class="text-[11px] font-bold text-slate-500">매물번호 / 분류</dt>
                  <dd class="font-extrabold text-slate-900 dark:text-white mt-0.5">#${escHtml(realPropNo)} · ${escHtml(fullType)}</dd>
                </div>
                <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700">
                  <dt class="text-[11px] font-bold text-slate-500">소재지 (지역)</dt>
                  <dd class="font-extrabold text-slate-900 dark:text-white mt-0.5">${escHtml(cleanLoc)}</dd>
                </div>
                <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700">
                  <dt class="text-[11px] font-bold text-slate-500">면적 / 해당층</dt>
                  <dd class="font-extrabold text-slate-900 dark:text-white mt-0.5">${escHtml(specStr || '본문 상세 참조')}</dd>
                </div>
                <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700 sm:col-span-2">
                  <dt class="text-[11px] font-bold text-slate-500">임대·매매 금액 조건</dt>
                  <dd class="font-extrabold text-[#003891] dark:text-blue-300 mt-0.5">${escHtml(priceStr || '상담 및 협의 가능 (010-3548-4000)')}</dd>
                </div>
                <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700">
                  <dt class="text-[11px] font-bold text-slate-500">담당 중개사무소</dt>
                  <dd class="font-extrabold text-slate-900 dark:text-white mt-0.5">최가네부동산 (010-3548-4000)</dd>
                </div>
              </dl>
            </section>
            ${relatedCandidates.length > 0 ? `
            <section aria-label="인근 유사 추천 매물" class="bg-surface-container-lowest rounded-xl shadow-card-soft border border-hairline p-5 sm:p-6">
              <div class="flex flex-wrap items-center justify-between gap-2 mb-3.5 pb-2.5 border-b border-hairline">
                <div>
                  <h2 class="font-bold text-sm sm:text-base text-ink flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-primary text-[19px]">apartment</span>
                    <span>${escHtml(regionLabel)} 인근·유사 추천 매물</span>
                  </h2>
                  <p class="text-[11px] text-muted mt-0.5">함께 비교해 보시면 좋은 최가네부동산의 검증된 상가·사무실 실매물입니다.</p>
                </div>
                <div class="flex items-center gap-2 text-xs font-extrabold">
                  <a href="${baseUrl}/property-news?category=${encodeURIComponent('매물리스트')}" class="text-[#003891] hover:underline">전체 매물리스트 →</a>
                  <span class="text-slate-300">|</span>
                  <a href="${baseUrl}/map" class="text-[#003891] hover:underline">지도로 찾기 →</a>
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                ${relatedCardsHtml}
              </div>
            </section>
            ` : ''}
          `;

          html = html.replace(
            '<div id="seo-geo-bottom-sections" class="mt-6 space-y-6 no-print"></div>',
            `<div id="seo-geo-bottom-sections" class="mt-6 space-y-6 no-print">${bottomSsrHtml}</div>`
          );
        }
      }
    } catch (err) {
      console.error('Error pre-rendering news-detail SSR:', err);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
