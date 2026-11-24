import fs from 'fs';
import path from 'path';

function extractPropNo(p) {
  if (!p) return '';
  const fullText = ((p.title || '') + ' ' + (p.content || '')).normalize('NFC');
  const m = fullText.match(/매물\s*번호\s*[:：]?\s*([0-9]{3,5})/i);
  if (m) return m[1];
  const m2 = fullText.match(/(?:NO|No|no)\.?\s*([0-9]{3,5})/);
  if (m2) return m2[1];
  return String(p.id || '').slice(-4);
}

function summarizePostLine(post, baseUrl) {
  const rawContent = (post.content || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ');

  const propNo = extractPropNo(post);
  const loc = (post.address || '대구').replace('대구광역시', '대구').trim();
  const title = (post.title || '').replace(/\s+/g, ' ').trim();
  const url = `${baseUrl}/news-detail?id=${post.id}`;

  const mDep = rawContent.match(/보증금\s*:\s*([^\n]+)/);
  const mRent = rawContent.match(/월세\s*:\s*([^\n]+)/);
  const mSale = rawContent.match(/매매가\s*:\s*([^\n]+)/);
  const mArea = rawContent.match(/(?:전용면적|공급면적|면적|평수)\s*:\s*([^\n]+)/i);
  const mFloor = rawContent.match(/(?:해당층|층수|층)\s*:\s*([^\n]+)/i);

  const conds = [];
  if (mArea) conds.push(`면적: ${mArea[1].trim().split('/')[0].trim()}`);
  if (mFloor) conds.push(`층수: ${mFloor[1].trim()}`);
  if (mDep) conds.push(`보증금: ${mDep[1].trim()}`);
  if (mRent) conds.push(`월세: ${mRent[1].trim()}`);
  if (mSale) conds.push(`매매가: ${mSale[1].trim()}`);

  const condStr = conds.length > 0 ? conds.join(' / ') : '상세 조건 링크 참조';
  return `- [매물번호 #${propNo}] [${loc}] ${title} (${condStr}) -> ${url}`;
}

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

  if (!posts && fs.existsSync(postsPath)) {
    try {
      posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
    } catch (e) {}
  }

  const publicPosts = Array.isArray(posts) ? posts.filter(p => p && p.isPrivate !== true) : [];
  const baseUrl = 'https://www.choi114.com';

  const lines = [
    '# 최가네부동산공인중개사사무소 실시간 전체 공개 매물 카탈로그 (llms-full.txt)',
    '',
    '- 공식 홈페이지: https://www.choi114.com/',
    '- 대표소장 공인중개사: 최이명 (등록번호: 제27260-2024-00085호)',
    '- 대표 상담전화: 010-3548-4000 / 053-746-7114',
    '- 소재지: 대구광역시 수성구 수성동1가 72-3번지 (대구은행역 2번 출구)',
    `- 실시간 공개 매물 수: 총 ${publicPosts.length}건`,
    '',
    '## 지역별 매물 바로가기 허브 (Regional Property Hubs)',
    '- 대구 수성구 상가·사무실: https://www.choi114.com/property-news?region=수성구',
    '- 대구 중구 상가·사무실: https://www.choi114.com/property-news?region=중구',
    '- 대구 달서구 상가·사무실: https://www.choi114.com/property-news?region=달서구',
    '- 대구 동구 상가·사무실: https://www.choi114.com/property-news?region=동구',
    '- 대구 북구 상가·사무실: https://www.choi114.com/property-news?region=북구',
    '- 대구 서구 상가·사무실: https://www.choi114.com/property-news?region=서구',
    '- 대구 남구 상가·사무실: https://www.choi114.com/property-news?region=남구',
    '- 대구 달성군 상가·사무실: https://www.choi114.com/property-news?region=달성군',
    '- 경산시 상가·사무실: https://www.choi114.com/property-news?region=경산시',
    '',
    '## 실시간 공개 매물 전체 요약 목록 (Active Public Listings)',
    ...publicPosts.map(p => summarizePostLine(p, baseUrl))
  ];

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).send(lines.join('\n'));
}
