export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const owner = 'cym10003-cyber';
  const repo = 'landing-page';
  const path = 'data/briefings.json';
  const token = (process.env.GITHUB_TOKEN || '').trim();

  async function fetchCurrentData() {
    let sha = null;
    let dataObj = null;

    if (token) {
      try {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?t=${Date.now()}`;
        const ghRes = await fetch(url, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-cache'
          }
        });
        if (ghRes.ok) {
          const json = await ghRes.json();
          sha = json.sha || null;
          if (json.content) {
            const contentStr = Buffer.from(json.content, 'base64').toString('utf8');
            dataObj = JSON.parse(contentStr);
          }
        }
      } catch (e) {}
    }

    if (!dataObj) {
      try {
        const rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${path}?t=${Date.now()}`);
        if (rawRes.ok) {
          dataObj = await rawRes.json();
        }
      } catch (e) {}
    }

    if (!dataObj || typeof dataObj !== 'object') {
      dataObj = { updatedAt: Date.now(), memos: [], briefings: [] };
    }
    if (!Array.isArray(dataObj.memos)) dataObj.memos = [];
    if (!Array.isArray(dataObj.briefings)) dataObj.briefings = [];

    return { sha, dataObj };
  }

  async function saveDataToGithub(dataObj, commitMessage) {
    if (!token) {
      return { ok: false, error: 'Missing GITHUB_TOKEN' };
    }
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let sha = null;
        const getRes = await fetch(`${url}?t=${Date.now()}`, { headers });
        if (getRes.ok) {
          const getData = await getRes.json();
          sha = getData.sha || null;
        }

        const contentBase64 = Buffer.from(JSON.stringify(dataObj, null, 2), 'utf8').toString('base64');
        const body = {
          message: commitMessage || 'briefing: update memos and customer briefings [skip ci] [skip vercel]',
          content: contentBase64,
          branch: 'main'
        };
        if (sha) body.sha = sha;

        const putRes = await fetch(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body)
        });
        if (putRes.ok) {
          return { ok: true };
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 600));
    }
    return { ok: false, error: 'Failed after 3 retries' };
  }

  if (req.method === 'GET') {
    const { dataObj } = await fetchCurrentData();
    const id = req.query && req.query.id ? String(req.query.id).trim() : '';

    if (id) {
      const briefing = dataObj.briefings.find(b => String(b.id) === id);
      if (!briefing) {
        return res.status(404).json({ error: 'Briefing not found' });
      }
      const attachedIds = Array.isArray(briefing.attachedMemoIds) ? briefing.attachedMemoIds : [];
      const attachedMemos = dataObj.memos.filter(m => attachedIds.includes(m.id));
      return res.status(200).json({ briefing, attachedMemos });
    }

    return res.status(200).json(dataObj);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const action = body.action || 'save_all';

    if (action === 'save_all') {
      const { dataObj: current } = await fetchCurrentData();
      const updated = {
        updatedAt: Date.now(),
        memos: Array.isArray(body.memos) ? body.memos : current.memos,
        briefings: Array.isArray(body.briefings) ? body.briefings : current.briefings
      };
      const result = await saveDataToGithub(updated, 'briefing: update memos and briefings [skip ci] [skip vercel]');
      return res.status(200).json({ ok: result.ok, data: updated });
    }

    if (action === 'customer_feedback') {
      const { briefingId, itemId, propNo, itemTitle, pickType, customerMemo } = body;
      const { dataObj } = await fetchCurrentData();
      const bIdx = dataObj.briefings.findIndex(b => String(b.id) === String(briefingId));

      const nowStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const pickEntry = {
        id: 'pick_' + Date.now(),
        itemId: itemId || '',
        propNo: propNo || '',
        itemTitle: itemTitle || '',
        pickType: pickType || '1순위 조건 협의 요청',
        customerMemo: customerMemo || '',
        date: nowStr,
        timestamp: Date.now()
      };

      let customerName = '브리핑 고객';
      if (bIdx !== -1) {
        customerName = dataObj.briefings[bIdx].customerName || '브리핑 고객';
        if (!Array.isArray(dataObj.briefings[bIdx].customerPicks)) {
          dataObj.briefings[bIdx].customerPicks = [];
        }
        dataObj.briefings[bIdx].customerPicks.unshift(pickEntry);
        if (dataObj.briefings[bIdx].customerPicks.length > 30) {
          dataObj.briefings[bIdx].customerPicks = dataObj.briefings[bIdx].customerPicks.slice(0, 30);
        }
        dataObj.updatedAt = Date.now();
        await saveDataToGithub(dataObj, `briefing: customer feedback on ${briefingId} [skip ci] [skip vercel]`);
      }

      // Send email alert via FormSubmit so admin gets notified immediately
      try {
        const targetEmail = process.env.ADMIN_NOTIFY_EMAIL || 'cym10003@naver.com';
        await fetch(`https://formsubmit.co/ajax/${targetEmail}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Referer': 'https://www.choi114.com/'
          },
          body: JSON.stringify({
            "_subject": `🔥 [최가네 브리핑 피드백] ${customerName}님이 [매물 ${propNo}] ${pickType}!`,
            "고객명": customerName,
            "브리핑ID": briefingId || '-',
            "선택구분": pickType || '-',
            "매물번호": propNo || '-',
            "매물제목": itemTitle || '-',
            "고객요청메모": customerMemo || '-',
            "선택일시": nowStr,
            "_template": "table",
            "_captcha": "false"
          })
        }).catch(() => {});
      } catch (e) {}

      return res.status(200).json({ ok: true, pick: pickEntry });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
