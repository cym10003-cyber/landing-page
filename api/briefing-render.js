import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  let id = req.query?.id;
  if (!id && req.url) {
    try {
      const parsedUrl = new URL(req.url, 'https://www.choi114.com');
      id = parsedUrl.searchParams.get('id');
    } catch (e) {}
  }
  if (!id) id = 'sample_vip_01';

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const htmlPath = path.join(process.cwd(), 'briefing.html');
  let html = '';
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (e) {
    return res.status(500).send('Error reading briefing.html template');
  }

  // 1. Fetch or Read Briefing Data
  let briefing = null;
  const localBriefingsPath = path.join(process.cwd(), 'data', 'briefings.json');
  try {
    if (fs.existsSync(localBriefingsPath)) {
      const raw = fs.readFileSync(localBriefingsPath, 'utf8');
      const store = JSON.parse(raw);
      briefing = (store.briefings || []).find(b => String(b.id) === String(id));
    }
  } catch (e) {}

  // If not found in local file, try fetching from GitHub raw (for freshly created briefings)
  if (!briefing) {
    try {
      const ghUrl = `https://raw.githubusercontent.com/cym10003-cyber/landing-page-assets/main/data/briefings.json?t=${Date.now()}`;
      const ghRes = await fetch(ghUrl, { headers: { 'Cache-Control': 'no-cache' } });
      if (ghRes.ok) {
        const store = await ghRes.json();
        briefing = (store.briefings || []).find(b => String(b.id) === String(id));
      }
    } catch (e) {}
  }

  const baseUrl = 'https://www.choi114.com';
  let ogTitle = '🏢 [VIP 고객 맞춤] 상가·사무실 비교 브리핑 리포트 | 최가네부동산';
  let ogDesc = '엄선된 추천 매물 상세 분석 · 초기 필요자금 및 월 실제 고정비 비교 · 공적장부·도면 · 현장 실사진을 전용 브리핑 보드에서 한눈에 확인하세요. (최가네부동산 010-3548-4000)';
  let ogImage = `${baseUrl}/og_briefing.jpg`;
  let pageTitle = '고객 전용 맞춤 매물 브리핑 보드 | 최가네부동산';
  const ogUrl = `${baseUrl}/briefing?id=${encodeURIComponent(id)}`;

  if (briefing) {
    const cName = (briefing.customerName || 'VIP 고객님').trim();
    const bTitle = (briefing.title || '추천 오피스·상가 맞춤 브리핑').trim();
    const items = Array.isArray(briefing.items) ? briefing.items : [];
    const count = items.length;

    pageTitle = `[VIP 맞춤 브리핑] ${cName} 전용 매물 리포트 | 최가네부동산`;
    ogTitle = `🏢 [VIP 맞춤 브리핑] ${cName} 전용 매물 비교 리포트`;

    // Extract first item photo or best photo
    let bestPhoto = '';
    for (const it of items) {
      if (Array.isArray(it.photos) && it.photos.length > 0 && it.photos[0]) {
        bestPhoto = it.photos[0];
        break;
      }
    }
    if (bestPhoto) {
      ogImage = bestPhoto;
    }

    const firstItem = items[0] || {};
    const firstArea = firstItem.area || '';

    const summaryParts = [bTitle];
    if (count > 0) summaryParts.push(`추천 매물 ${count}건`);
    if (firstArea) summaryParts.push(firstArea);
    summaryParts.push('초기자금·월고정비·실사진·공부 완비');
    summaryParts.push('최가네부동산 010-3548-4000');

    ogDesc = summaryParts.join(' · ');
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Construct Dynamic Meta Tags Block
  const ogTagsHtml = `
    <!-- Dynamic Open Graph & Social Preview Tags for SMS / KakaoTalk / iMessage -->
    <title>${esc(pageTitle)}</title>
    <meta name="description" content="${esc(ogDesc)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="최가네부동산 VIP 맞춤 브리핑" />
    <meta property="og:url" content="${esc(ogUrl)}" />
    <meta property="og:title" content="${esc(ogTitle)}" />
    <meta property="og:description" content="${esc(ogDesc)}" />
    <meta property="og:image" content="${esc(ogImage)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${esc(ogTitle)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(ogTitle)}" />
    <meta name="twitter:description" content="${esc(ogDesc)}" />
    <meta name="twitter:image" content="${esc(ogImage)}" />
  `;

  // Replace or inject into <head>
  if (html.includes('<title>')) {
    html = html.replace(/<title>[\s\S]*?<\/title>/i, ogTagsHtml.trim());
  } else {
    html = html.replace('<head>', `<head>\n${ogTagsHtml.trim()}`);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
