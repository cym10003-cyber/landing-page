export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const owner = 'cym10003-cyber';
  const repo = 'landing-page';
  const path = 'data/leads.json';
  const token = (process.env.GITHUB_TOKEN || '').trim();

  // GET: Fetch all leads from GitHub REST API (real-time zero CDN caching)
  if (req.method === 'GET') {
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const headers = {
        'Accept': 'application/vnd.github.v3+json'
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const ghRes = await fetch(`${url}?t=${Date.now()}`, { headers });
      if (ghRes.ok) {
        const data = await ghRes.json();
        if (data && data.content) {
          const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
          const leads = JSON.parse(contentStr);
          return res.status(200).json(Array.isArray(leads) ? leads : []);
        }
      }
    } catch(e) {}

    // Fallback to raw GitHub
    try {
      const rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${path}?t=${Date.now()}`);
      if (rawRes.ok) {
        const leads = await rawRes.json();
        return res.status(200).json(Array.isArray(leads) ? leads : []);
      }
    } catch(e) {}

    return res.status(200).json([]);
  }

  // POST: Submit a new lead
  if (req.method === 'POST') {
    try {
      const { type, name, phone, category, location, floor, pyeong, budget, notes } = req.body || {};
      if (!name || !phone) {
        return res.status(400).json({ error: 'Name and phone required' });
      }

      const leadObj = {
        id: Date.now(),
        type: type || 'buyer',
        name: String(name).trim(),
        phone: String(phone).trim(),
        category: String(category || ''),
        location: String(location || ''),
        floor: String(floor || '전체층'),
        pyeong: String(pyeong || ''),
        budget: String(budget || ''),
        notes: String(notes || ''),
        date: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
      };

      // Send Telegram Notification
      try {
        const leadTypeStr = leadObj.type === 'seller' ? '🏢 [건물주/임차인] 매물 내놓습니다' : '🔍 [손님] 매물 구합니다';
        const text = `🔔 [최가네부동산] 실시간 매물 의뢰 접수!\n\n` +
          `• 구분: ${leadTypeStr}\n` +
          `• 성함/상호: ${leadObj.name}\n` +
          `• 연락처: ${leadObj.phone}\n` +
          `• 매물종류/업종: ${leadObj.category}\n` +
          `• 위치/소재지: ${leadObj.location}\n` +
          `• 층수: ${leadObj.floor || '전체층'}\n` +
          `• 평수: ${leadObj.pyeong}\n` +
          `• 조건/권리금: ${leadObj.budget}\n` +
          `• 요청사항: ${leadObj.notes || '-'}\n\n` +
          `📞 바로 전화걸기: ${leadObj.phone}\n` +
          `🌐 대시보드: https://www.choi114.com/admin.html`;

        const defaultTok = Buffer.from('ODk3MjMzMzI4MzpBQUV2Y1FTZ25Cd1dDV1plMllWZDFzV1VfTGR1UWdyLVZfaw==', 'base64').toString('ascii');
        const botToken = process.env.TELEGRAM_BOT_TOKEN || defaultTok;
        const chatId = process.env.TELEGRAM_CHAT_ID || '8970218844';

        if (botToken && chatId) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text })
          }).catch(() => {});
        }
      } catch(e) {}

      // Persist lead to GitHub data/leads.json if GITHUB_TOKEN is available
      if (token) {
        try {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
          const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${token}`
          };

          const getRes = await fetch(url, { headers });
          let sha = null;
          let leadsList = [];

          if (getRes.ok) {
            const data = await getRes.json();
            sha = data.sha;
            try {
              const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
              leadsList = JSON.parse(contentStr);
            } catch(e) {}
          }

          if (!Array.isArray(leadsList)) leadsList = [];
          leadsList.unshift(leadObj);

          const jsonStr = JSON.stringify(leadsList, null, 2);
          const contentBase64 = Buffer.from(jsonStr, 'utf8').toString('base64');

          const body = {
            message: `feat: new customer lead submission by ${leadObj.name}`,
            content: contentBase64
          };
          if (sha) body.sha = sha;

          await fetch(url, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        } catch(e) {
          console.error("GitHub leads save error:", e);
        }
      }

      return res.status(200).json({ success: true, lead: leadObj });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE: Remove lead(s)
  if (req.method === 'DELETE') {
    try {
      const { id } = req.query;
      if (!token) return res.status(401).json({ error: 'Token missing' });

      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`
      };

      const getRes = await fetch(url, { headers });
      if (!getRes.ok) return res.status(404).json({ error: 'File not found' });
      const data = await getRes.json();
      const sha = data.sha;
      const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
      let leadsList = [];
      try {
        leadsList = JSON.parse(contentStr) || [];
      } catch(e) {}

      if (id) {
        leadsList = leadsList.filter(l => String(l.id) !== String(id));
      } else {
        leadsList = [];
      }

      const jsonStr = JSON.stringify(leadsList, null, 2);
      const contentBase64 = Buffer.from(jsonStr, 'utf8').toString('base64');

      const delRes = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: id ? `feat: delete lead ${id}` : 'feat: clear all leads',
          content: contentBase64,
          sha
        })
      });

      if (delRes.ok) {
        return res.status(200).json({ success: true, leads: leadsList });
      } else {
        const errData = await delRes.json();
        return res.status(500).json({ error: errData.message || 'Failed to update GitHub' });
      }
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
