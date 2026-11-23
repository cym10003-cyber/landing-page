export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const category = (req.query?.category || 'all').trim();
  const customQuery = (req.query?.q || '').trim();

  const CATEGORY_CONFIGS = {
    policy: {
      label: '부동산 정책·제도',
      badgeColor: 'blue',
      query: '부동산 정책 OR 국토교통부 부동산 OR 상가임대차 OR 부동산 규제 완화 when:7d'
    },
    commercial: {
      label: '상가·오피스·수익형',
      badgeColor: 'indigo',
      query: '상업용 부동산 OR 오피스 임대 OR 꼬마빌딩 OR 상가 공실 OR 상권 동향 when:7d'
    },
    finance: {
      label: '금리·대출·세무',
      badgeColor: 'emerald',
      query: '부동산 금리 OR 대출 금리 OR 취득세 양도세 OR 소상공인 금융지원 when:7d'
    },
    daegu: {
      label: '대구·경북 지역소식',
      badgeColor: 'amber',
      query: '대구 부동산 OR 대구 수성구 OR 대구 상권 OR 대구 도시철도 개발 when:7d'
    }
  };

  function decodeXmlEntities(str) {
    if (!str) return '';
    return String(str)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function generateBrokerCommentary(title, catKey) {
    const t = String(title || '');
    if (t.includes('금리') || t.includes('대출') || t.includes('금융')) {
      return {
        summary: '금융권 대출 금리 및 유동성 변화에 따라 상업용 부동산 레버리지 수익률과 월 이자 부담을 재점검할 시점입니다.',
        brokerTip: '신규 매수나 대환 대출, 임차 보증금 증감 협의 시 금리 추이를 반영하여 가장 유리한 조건으로 조율해 드립니다.'
      };
    }
    if (t.includes('세금') || t.includes('양도') || t.includes('취득') || t.includes('부가세') || t.includes('세제')) {
      return {
        summary: '부동산 세제 및 과세 기준 변동 사항으로, 매도·매수 및 임대차 계약 전 절세 요건을 사전 체크해야 합니다.',
        brokerTip: '개인·법인 계약 형태별 유불리와 부가세·취득세 절감 포인트를 계약 전 꼼꼼히 안내해 드립니다.'
      };
    }
    if (t.includes('상가') || t.includes('오피스') || t.includes('빌딩') || t.includes('공실') || t.includes('임대')) {
      return {
        summary: '상업용 오피스·상가 시장의 임차 수요와 렌트프리·무권리 등 실속형 계약 트렌드가 빠르게 변화하고 있습니다.',
        brokerTip: '임대인께는 우량 임차인 빠른 공실 해소를, 임차인께는 인테리어 완비·렌트프리 알짜 매물을 선점해 드립니다.'
      };
    }
    if (t.includes('대구') || t.includes('수성구') || t.includes('경북') || t.includes('동대구')) {
      return {
        summary: '대구·수성구 지역 내 주요 인프라 및 상권 변화 소식으로, 핵심 역세권 및 대로변 입지 가치를 눈여겨볼 필요가 있습니다.',
        brokerTip: '수성구·달구벌대로·동대구역 일대 검증된 50~300평대 핵심 상가·사무실 실매물을 실시간 브리핑해 드립니다.'
      };
    }
    if (catKey === 'policy') {
      return {
        summary: '정부의 부동산 정책 및 제도 개편에 따라 시장 참여자들의 매수·임차 심리와 거래 흐름에 변화가 예상됩니다.',
        brokerTip: '바뀌는 정책 환경 속에서 대표님의 자산 가치 방어와 안전한 계약 진행을 최가네부동산이 밀착 지원합니다.'
      };
    }
    return {
      summary: '최근 부동산 시장의 주요 이슈와 정책 흐름을 파악하여 임대차 및 매매 의사결정에 참고하실 수 있는 핵심 소식입니다.',
      brokerTip: '상가·사무실 임대 및 빌딩 매매 관련 궁금하신 점은 언제든 편하게 연락 주시면 맞춤 분석해 드립니다.'
    };
  }

  async function fetchCategoryItems(catKey, queryStr, maxItems = 10) {
    try {
      const encoded = encodeURIComponent(queryStr);
      const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=ko&gl=KR&ceid=KR:ko`;
      const response = await fetch(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (!response.ok) return [];
      const xmlText = await response.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      const items = [];
      let match;

      while ((match = itemRegex.exec(xmlText)) !== null && items.length < maxItems) {
        const block = match[1];
        const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const rawLink = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const rawPubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        const rawSource = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';

        let cleanTitle = decodeXmlEntities(rawTitle);
        const sourceName = decodeXmlEntities(rawSource) || '부동산뉴스';
        if (cleanTitle.endsWith(` - ${sourceName}`)) {
          cleanTitle = cleanTitle.slice(0, cleanTitle.length - (` - ${sourceName}`).length).trim();
        } else {
          cleanTitle = cleanTitle.replace(/\s+-\s+[^-]+$/, '').trim();
        }

        if (!cleanTitle || cleanTitle.length < 5) continue;

        const pubTime = rawPubDate ? new Date(rawPubDate).getTime() : Date.now();
        const kstDate = new Date(pubTime).toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });

        const catInfo = CATEGORY_CONFIGS[catKey] || { label: '맞춤 검색', badgeColor: 'blue' };
        const commentary = generateBrokerCommentary(cleanTitle, catKey);

        items.push({
          id: 'news_' + Buffer.from(cleanTitle.slice(0, 24)).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + '_' + items.length,
          category: catKey,
          categoryLabel: catInfo.label,
          title: cleanTitle,
          source: sourceName,
          link: rawLink.trim(),
          pubTimestamp: isNaN(pubTime) ? Date.now() : pubTime,
          dateStr: kstDate,
          summary: commentary.summary,
          brokerTip: commentary.brokerTip
        });
      }
      return items;
    } catch (e) {
      return [];
    }
  }

  try {
    let allItems = [];
    if (customQuery) {
      allItems = await fetchCategoryItems('custom', `${customQuery} 부동산 when:14d`, 15);
    } else if (category !== 'all' && CATEGORY_CONFIGS[category]) {
      allItems = await fetchCategoryItems(category, CATEGORY_CONFIGS[category].query, 15);
    } else {
      const [pItems, cItems, fItems, dItems] = await Promise.all([
        fetchCategoryItems('policy', CATEGORY_CONFIGS.policy.query, 5),
        fetchCategoryItems('commercial', CATEGORY_CONFIGS.commercial.query, 5),
        fetchCategoryItems('finance', CATEGORY_CONFIGS.finance.query, 5),
        fetchCategoryItems('daegu', CATEGORY_CONFIGS.daegu.query, 5)
      ]);
      allItems = [...pItems, ...cItems, ...fItems, ...dItems];
    }

    // Deduplicate by title similarity
    const seenTitles = new Set();
    const uniqueItems = [];
    for (const it of allItems) {
      const key = it.title.replace(/\s+/g, '').slice(0, 18);
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      uniqueItems.push(it);
    }

    uniqueItems.sort((a, b) => (b.pubTimestamp || 0) - (a.pubTimestamp || 0));

    return res.status(200).json({
      ok: true,
      updatedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      items: uniqueItems.slice(0, 20)
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, items: [] });
  }
}
