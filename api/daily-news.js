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
    daegu: {
      label: '대구·경북 지역소식',
      badgeColor: 'emerald',
      query: '("대구 부동산" OR "대구 상권" OR "수성구" 부동산 OR "동대구역" 개발 OR "대구 도시철도" OR "대구 상가" OR "대구 오피스") when:10d'
    },
    commercial: {
      label: '상가·오피스·수익형',
      badgeColor: 'indigo',
      query: '("상업용 부동산" OR "오피스 임대" OR "꼬마빌딩" OR "상가 공실" OR "수익형 부동산" OR "상가임대차") when:10d'
    },
    finance: {
      label: '금리·대출·세무',
      badgeColor: 'amber',
      query: '("기준금리" 부동산 OR "상업용 부동산" 금리 OR "취득세" 부동산 OR "양도세" 부동산 OR "종합부동산세" OR "상가 대출") when:10d'
    },
    policy: {
      label: '부동산 정책·제도',
      badgeColor: 'blue',
      query: '("국토교통부" 부동산 OR "상가건물 임대차보호법" OR "건축물 용도변경" OR "부동산 정책" OR "부동산 규제 완화") when:10d'
    }
  };

  // Noise filter: exclude residential-only / personal credit loan / non-real-estate spam in curated feeds
  const NOISE_TITLE_REGEX = /디딤돌대출|보금자리론|신생아\s*특례|중저신용|신용대출|카드론|현금서비스|청년\s*월세|전세사기|빌라왕|공공데이터\s*개방|청약\s*경쟁률|로또\s*청약|다자녀\s*특공|주담대\s*갈아타기|주식\s*추천|비트코인|가상자산|코인\s*시세|프로야구|연예|드라마|예능/i;
  const SEOUL_APT_ONLY_REGEX = /(서울\s*아파트|강남\s*아파트|강남3구|마용성|노도강|경기\s*아파트|수도권\s*청약|분양가\s*상한제)/i;
  const COMMERCIAL_OR_DAEGU_REGEX = /(대구|수성구|범어|동대구|달구벌|경북|경산|상가|오피스|사무실|빌딩|꼬마빌딩|공실|임대차|권리금|렌트프리|상업용|수익형|상권|용도변경|임대료|소상공인|기준금리|취득세|양도세|종부세|부가세|국토부|도시철도|재건축|재개발)/i;

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

  function cleanHeadlineForSummary(title) {
    return String(title || '')
      .replace(/^\[[^\]]{1,16}\]\s*/g, '')
      .replace(/^[“"'‘]|[”"'’]$/g, '')
      .replace(/\s*\.\.\.\s*/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function computeRelevanceScore(title, catKey, pubTime) {
    const t = String(title || '');
    let score = 40;
    if (/대구|수성구|범어|만촌|동대구|달구벌|반월당|경북|경산/.test(t)) score += 36;
    if (/상가|오피스|사무실|빌딩|꼬마빌딩|공실|상업용|수익형|상권|임대차|권리금|렌트프리|임대료|용도변경/.test(t)) score += 32;
    if (/기준금리|한국은행|취득세|양도세|종부세|부가세|세제|국토부|국토교통부|도시철도|트램|철도|규제\s*완화/.test(t)) score += 20;
    if (catKey === 'daegu' && /대구|경북|수성구/.test(t)) score += 10;
    if (catKey === 'commercial' && /상가|오피스|빌딩|공실|임대/.test(t)) score += 10;
    if (SEOUL_APT_ONLY_REGEX.test(t) && !/상가|오피스|빌딩|대구/.test(t)) score -= 28;
    const ageHours = Math.max(0, (Date.now() - (pubTime || Date.now())) / 3600000);
    if (ageHours <= 24) score += 10;
    else if (ageHours <= 72) score += 5;
    return Math.max(0, Math.min(100, score));
  }

  // Extract concrete article-specific topic key & genuinely distinct 1-line summary + practical commercial broker tip
  function buildArticleSpecificInsight(title, sourceName, catKey) {
    const t = String(title || '');
    const core = cleanHeadlineForSummary(t);
    const shortCore = core.length > 36 ? core.slice(0, 36).trim() + '…' : core;

    const rules = [
      {
        topic: 'daegu_transit',
        test: /(대구|경북|경산|수성).*(철도|지하철|트램|엑스코선|역세권|교통|신공항|도로|개통|착공)/,
        summary: `대구권 교통·인프라 확충 소식(${sourceName})으로, 노선 인근 역세권 상가·사무실의 접근성과 중장기 입지 가치 변화를 주목할 필요가 있습니다.`,
        brokerTip: `교통망 신설·개선 구간은 착공·개통 전후로 임대 문의가 먼저 움직이므로, 핵심 역세권 매물 선점 전략이 유효합니다.`
      },
      {
        topic: 'daegu_commercial',
        test: /(대구|수성구|범어|동대구|동성로|반월당|중구|달서).*(상권|상가|오피스|사무실|임대|공실|창업|빌딩|매매)/,
        summary: `대구 현장 상권·상업용 부동산 동향(${sourceName})으로, 지역 내 임차 수요 이동과 임대료·공실 흐름을 직접 가늠할 수 있는 소식입니다.`,
        brokerTip: `수성구·달구벌대로·동대구역 일대 실거래 및 공실 추이를 반영해, 조건에 맞는 실속 매물·우량 임차인을 맞춤 연결해 드립니다.`
      },
      {
        topic: 'daegu_market',
        test: /(대구|수성구|경북|경산|달성)/,
        summary: `대구·경북 지역 부동산·개발 이슈(${sourceName})로, 주변 상권 유동인구와 지역 부동산 체감 경기 흐름을 함께 살펴볼 만합니다.`,
        brokerTip: `대구 전 지역 개발 호재와 상권 변화는 상가·사무실 입지 선정의 핵심 기준이므로, 현장 기준 시세와 공실 현황을 수시로 안내해 드립니다.`
      },
      {
        topic: 'vacancy_office',
        test: /(공실|오피스|사무실|지식산업센터|공유오피스)/,
        summary: `오피스·상가 공실 및 임차 시장 동향(${sourceName})을 다룬 기사로, 최근 임차인들의 실속형(무권리·인테리어 완비·렌트프리) 선호 흐름이 반영되어 있습니다.`,
        brokerTip: `임대인께는 유연한 렌트프리·업종 다변화로 빠른 공실 해소를, 임차인께는 초기 시설비 부담을 줄이는 알짜 오피스를 우선 추천해 드립니다.`
      },
      {
        topic: 'building_yield',
        test: /(꼬마빌딩|수익형|상업용\s*부동산|빌딩\s*매매|상가\s*매매|임대수익률|캡레이트)/,
        summary: `수익형 빌딩·상업용 부동산 거래 흐름(${sourceName})으로, 매수가 대비 순수익률과 우량 임차인 구성 여부가 자산 가치를 좌우하는 추세입니다.`,
        brokerTip: `매수·매도 검토 시 단순 수익률뿐 아니라 공실 리스크·리모델링 가치·임대차 승계 조건까지 실무 기준으로 꼼꼼히 분석해 드립니다.`
      },
      {
        topic: 'lease_law',
        test: /(상가\s*임대차|임대차\s*보호법|환산보증금|권리금|계약갱신|임대료\s*인상|월세\s*상한)/,
        summary: `상가 임대차 제도 및 계약 조건 관련 소식(${sourceName})으로, 임대인·임차인 모두 갱신요구권·환산보증금·권리금 보호 기준을 사전에 확인해 두셔야 합니다.`,
        brokerTip: `신규 계약 및 재계약 시 법정 임대차 기준과 필수 특약(원상복구·관리비·중도해지 등)을 분쟁 없도록 안전하게 설계해 드립니다.`
      },
      {
        topic: 'usage_change',
        test: /(용도변경|건축법|주차장법|소방|근린생활|업무시설|규제\s*완화|특례)/,
        summary: `건축물 용도변경 및 인허가 제도 변화(${sourceName}) 소식으로, 상가·사무실·병의원 등 업종 전환과 건물 활용도를 높일 수 있는 실무 포인트입니다.`,
        brokerTip: `계약 전 건축물대장상 용도·주차 대수·정화조·용도변경 가능 여부를 사전에 확인해 인허가 차질이 없도록 도와드립니다.`
      },
      {
        topic: 'base_rate',
        test: /(기준금리|한국은행|한은|금통위|금리\s*동결|금리\s*인하|금리\s*인상)/,
        summary: `기준금리 방향성 관련 핵심 소식(${sourceName})으로, 향후 상업용 부동산 담보대출 이자 부담과 수익형 매물 투자 심리에 직접적인 기준이 됩니다.`,
        brokerTip: `금리 변곡점에서는 보유 건물 대환 조건 점검과 임대 보증금·월세 비율 조정을 통해 실질 수익률을 미리 방어하시는 것이 유리합니다.`
      },
      {
        topic: 'tax_policy',
        test: /(취득세|양도세|종부세|종합부동산세|재산세|부가세|부가가치세|세제|절세|증여|상속|중과)/,
        summary: `부동산 세제·과세 기준 변화(${sourceName})를 다룬 소식으로, 매매·임대 계약 전 개인/법인 명의와 세금 부담 구조를 미리 따져보셔야 합니다.`,
        brokerTip: `상가·빌딩 계약 시 포괄양수도·부가세 환급·취득세 중과 배제 여부 등 계약 전 필수 세무 체크포인트를 함께 챙겨드립니다.`
      },
      {
        topic: 'commercial_loan',
        test: /(대출|금융|담보|DSR|LTV|이자|소상공인\s*금융|자금\s*지원)/,
        summary: `금융권 대출·자금 조달 여건 변화(${sourceName}) 소식으로, 사업자·건물주분들의 레버리지 조건과 금융 비용 관리에 참고하실 내용입니다.`,
        brokerTip: `신규 매입·창업 또는 기존 대출 만기 도래 시 금리 및 보증금 조건을 종합 비교해 현금흐름이 가장 안정적인 방향으로 조율해 드립니다.`
      },
      {
        topic: 'redev_policy',
        test: /(정비사업|재건축|재개발|도시정비|국토부|국토교통부|공급대책|부동산\s*정책)/,
        summary: `정부·지자체 부동산 정책 방향(${sourceName})을 담은 소식으로, 향후 개발 구역 지정 및 상권·거래 심리 변화 흐름을 읽는 데 도움이 됩니다.`,
        brokerTip: `정책 발표 전후로 시장 관망세와 급매 출현이 엇갈리는 시기인 만큼, 실제 현장 호가와 거래 분위기를 수시로 브리핑해 드리겠습니다.`
      },
      {
        topic: 'retail_trend',
        test: /(상가|상권|자영업|소상공인|프랜차이즈|카페|식당|매출|임대료)/,
        summary: `상권 및 매장 운영 환경 변화(${sourceName}) 소식으로, 임대료 부담 대비 입지 효율과 업종 적합성을 따지는 실속 중심 흐름이 뚜렷해지고 있습니다.`,
        brokerTip: `매장 확장·이전이나 양도양수 검토 시 유동인구·주차 여건·배후 수요를 현장 기준으로 분석해 실패 확률을 낮춰드립니다.`
      }
    ];

    for (const r of rules) {
      if (r.test.test(t)) {
        return { topic: r.topic, summary: r.summary, brokerTip: r.brokerTip };
      }
    }

    if (catKey === 'daegu') {
      return {
        topic: 'daegu_general',
        summary: `대구·경북 지역 현안("${shortCore}") 관련 소식으로, 지역 상권과 부동산 시장 체감 흐름을 살펴보실 수 있습니다.`,
        brokerTip: `대구 핵심 상권별 실거래 분위기와 알짜 임대·매매 물건 소식을 가장 빠르게 전해드리겠습니다.`
      };
    }
    if (catKey === 'commercial') {
      return {
        topic: 'commercial_general',
        summary: `상업용 부동산 시장 이슈("${shortCore}")로, 상가·오피스 임대차 및 수익형 자산 관리 시 참고하실 만한 내용입니다.`,
        brokerTip: `업종별 맞춤 입지 추천부터 임대차 조건 조율까지 현장 경험 기반으로 꼼꼼히 안내해 드립니다.`
      };
    }
    if (catKey === 'finance') {
      return {
        topic: 'finance_general',
        summary: `부동산 금융·세무 동향("${shortCore}")으로, 자금 계획과 보유 자산 수익률 점검 시 체크하실 소식입니다.`,
        brokerTip: `금리·세무 환경 변화에 맞춘 보증금/월세 비율 및 계약 조건 상담은 언제든 편하게 문의해 주세요.`
      };
    }
    return {
      topic: 'policy_general',
      summary: `부동산 시장 주요 이슈("${shortCore}")로, 향후 거래 분위기 및 임대차 의사결정 시 참고하실 핵심 소식입니다.`,
      brokerTip: `변화하는 시장 흐름 속에서 대표님의 자산 가치와 안전한 계약을 최우선으로 챙겨드리겠습니다.`
    };
  }

  async function fetchCategoryItems(catKey, queryStr, maxItems = 12, isCustom = false) {
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

      while ((match = itemRegex.exec(xmlText)) !== null && items.length < maxItems * 2) {
        const block = match[1];
        const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const rawLink = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const rawPubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        const rawSource = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';

        let cleanTitle = decodeXmlEntities(rawTitle);
        const sourceName = decodeXmlEntities(rawSource) || '경제언론';
        if (cleanTitle.endsWith(` - ${sourceName}`)) {
          cleanTitle = cleanTitle.slice(0, cleanTitle.length - (` - ${sourceName}`).length).trim();
        } else {
          cleanTitle = cleanTitle.replace(/\s+-\s+[^-]+$/, '').trim();
        }

        if (!cleanTitle || cleanTitle.length < 6) continue;

        // Filter out off-topic personal credit loans / residential lottery spam in curated feeds
        if (!isCustom) {
          if (NOISE_TITLE_REGEX.test(cleanTitle)) continue;
          if (SEOUL_APT_ONLY_REGEX.test(cleanTitle) && !COMMERCIAL_OR_DAEGU_REGEX.test(cleanTitle)) continue;
        }

        const pubTime = rawPubDate ? new Date(rawPubDate).getTime() : Date.now();
        const safePubTime = isNaN(pubTime) ? Date.now() : pubTime;
        const kstDate = new Date(safePubTime).toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });

        const catInfo = CATEGORY_CONFIGS[catKey] || { label: '맞춤 검색', badgeColor: 'blue' };
        const insight = buildArticleSpecificInsight(cleanTitle, sourceName, catKey);
        const relevanceScore = computeRelevanceScore(cleanTitle, catKey, safePubTime);

        items.push({
          id: 'news_' + Buffer.from(cleanTitle.slice(0, 24)).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + '_' + items.length,
          category: catKey,
          categoryKey: catKey,
          categoryLabel: catInfo.label,
          title: cleanTitle,
          source: sourceName,
          publisher: sourceName,
          link: rawLink.trim(),
          pubTimestamp: safePubTime,
          dateStr: kstDate,
          topicKey: insight.topic,
          relevanceScore,
          summary: insight.summary,
          brokerTip: insight.brokerTip
        });
      }

      // Sort within each category by relevance score first, then recency
      items.sort((a, b) => (b.relevanceScore - a.relevanceScore) || (b.pubTimestamp - a.pubTimestamp));
      return items.slice(0, maxItems);
    } catch (e) {
      return [];
    }
  }

  try {
    let rawPool = [];
    if (customQuery) {
      rawPool = await fetchCategoryItems('custom', `${customQuery} 부동산 when:14d`, 15, true);
    } else if (category !== 'all' && CATEGORY_CONFIGS[category]) {
      rawPool = await fetchCategoryItems(category, CATEGORY_CONFIGS[category].query, 15, false);
    } else {
      const [dItems, cItems, fItems, pItems] = await Promise.all([
        fetchCategoryItems('daegu', CATEGORY_CONFIGS.daegu.query, 6, false),
        fetchCategoryItems('commercial', CATEGORY_CONFIGS.commercial.query, 6, false),
        fetchCategoryItems('finance', CATEGORY_CONFIGS.finance.query, 6, false),
        fetchCategoryItems('policy', CATEGORY_CONFIGS.policy.query, 6, false)
      ]);
      // Round-robin interleave so '종합 핵심 픽' ALWAYS presents balanced Daegu + Commercial + Finance + Policy!
      const buckets = [dItems, cItems, fItems, pItems];
      const maxLen = Math.max(...buckets.map(b => b.length), 0);
      for (let i = 0; i < maxLen; i++) {
        for (const b of buckets) {
          if (b[i]) rawPool.push(b[i]);
        }
      }
    }

    // Deduplicate by title similarity AND prevent duplicate boilerplate tips in consecutive cards
    const seenTitles = new Set();
    const topicTipCounts = {};
    const uniqueItems = [];

    for (const it of rawPool) {
      const key = it.title.replace(/[^가-힣a-zA-Z0-9]/g, '').slice(0, 16);
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);

      // If same topicKey appears a 2nd/3rd time in one feed, personalize summary with the headline's unique focus so cards never look copy-pasted!
      const tCount = topicTipCounts[it.topicKey] || 0;
      topicTipCounts[it.topicKey] = tCount + 1;
      if (tCount >= 1) {
        const shortT = cleanHeadlineForSummary(it.title);
        const clipped = shortT.length > 34 ? shortT.slice(0, 34).trim() + '…' : shortT;
        it.summary = `[${it.publisher}] '${clipped}' 관련 최근 시장 동향으로, 임대·매매 조건 검토 시 참고하실 만한 체크포인트입니다.`;
      }

      uniqueItems.push(it);
    }

    return res.status(200).json({
      ok: true,
      updatedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      items: uniqueItems.slice(0, 20)
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, items: [] });
  }
}
