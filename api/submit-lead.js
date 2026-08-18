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

      // Send Email Notification to cym10003@naver.com & Telegram Notification
      try {
        const targetEmail = process.env.ADMIN_NOTIFY_EMAIL || 'cym10003@naver.com';
        const leadTypeStr = leadObj.type === 'seller' ? '🏢 [건물주/임차인] 매물내놓기' : '🔍 [손님] 매물구함';
        const emailSubject = `🔔 [최가네부동산] 새 ${leadObj.type === 'seller' ? '매물내놓기' : '매물구함'} 접수! (${leadObj.name || '고객'}님)`;
        
        const htmlBody = `
          <div style="font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
            <div style="text-align: center; padding-bottom: 16px; border-bottom: 2px solid #2563eb;">
              <h2 style="color: #1e3a8a; margin: 0; font-size: 20px;">🔔 [최가네부동산] 실시간 매물 의뢰 접수</h2>
              <p style="color: #64748b; font-size: 13px; margin-top: 4px;">홈페이지를 통해 손님이 새로 접수한 매물 의뢰 내역입니다.</p>
            </div>
            
            <table style="width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px;">
              <tr style="background-color: #f8fafc;">
                <td style="padding: 12px; font-weight: bold; width: 32%; border-bottom: 1px solid #e2e8f0; color: #475569;">의뢰 구분</td>
                <td style="padding: 12px; font-weight: bold; color: ${leadObj.type === 'seller' ? '#7c3aed' : '#2563eb'}; border-bottom: 1px solid #e2e8f0;">${leadTypeStr}</td>
              </tr>
              <tr>
                <td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #475569;">성함 / 상호</td>
                <td style="padding: 12px; font-weight: bold; font-size: 16px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${leadObj.name || '-'}</td>
              </tr>
              <tr style="background-color: #f8fafc;">
                <td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #475569;">연락처</td>
                <td style="padding: 12px; font-weight: bold; font-size: 16px; border-bottom: 1px solid #e2e8f0;">
                  <a href="tel:${leadObj.phone}" style="color: #2563eb; text-decoration: none;">📞 ${leadObj.phone || '-'}</a>
                </td>
              </tr>
              <tr>
                <td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #475569;">매물종류 / 업종</td>
                <td style="padding: 12px; font-weight: bold; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${leadObj.category || '-'}</td>
              </tr>
              <tr style="background-color: #f8fafc;">
                <td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #475569;">위치 / 층수 / 평수</td>
                <td style="padding: 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${leadObj.location || '-'} (${leadObj.floor || '전체층'}, ${leadObj.pyeong || '-'})</td>
              </tr>
              <tr>
                <td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #475569;">예산 / 조건 / 권리금</td>
                <td style="padding: 12px; font-weight: bold; color: #059669; border-bottom: 1px solid #e2e8f0;">${leadObj.budget || '-'}</td>
              </tr>
              <tr style="background-color: #fffbeb;">
                <td style="padding: 12px; font-weight: bold; border-bottom: 1px solid #e2e8f0; color: #92400e;">상담 요청 메모</td>
                <td style="padding: 12px; color: #1e293b; border-bottom: 1px solid #e2e8f0; white-space: pre-wrap;">${leadObj.notes || '-'}</td>
              </tr>
              <tr>
                <td style="padding: 12px; font-weight: bold; color: #475569;">접수 일시</td>
                <td style="padding: 12px; color: #64748b; font-size: 13px;">${leadObj.date || new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td>
              </tr>
            </table>

            <div style="margin-top: 24px; text-align: center;">
              <a href="https://www.choi114.com/admin.html" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 12px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 14px;">
                💻 관리자 대시보드 바로가기
              </a>
            </div>
          </div>
        `;

        // Send via FormSubmit directly to cym10003@naver.com
        await fetch(`https://formsubmit.co/ajax/${targetEmail}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://www.choi114.com/'
          },
          body: JSON.stringify({
            "_subject": emailSubject,
            "의뢰구분": leadTypeStr,
            "성함_상호": leadObj.name || '-',
            "연락처": leadObj.phone || '-',
            "매물종류_업종": leadObj.category || '-',
            "위치_층수_평수": `${leadObj.location || '-'} (${leadObj.floor || '전체층'}, ${leadObj.pyeong || '-'})`,
            "예산_조건_권리금": leadObj.budget || '-',
            "상담요청메모": leadObj.notes || '-',
            "접수일시": leadObj.date || new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
            "_template": "table",
            "_captcha": "false"
          })
        }).catch(() => {});

        // Send via Resend API if key is present
        const resendApiKey = process.env.RESEND_API_KEY;
        if (resendApiKey) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: '최가네부동산 <onboarding@resend.dev>',
              to: [targetEmail],
              subject: emailSubject,
              html: htmlBody
            })
          }).catch(() => {});
        }

        // Also Telegram Notification (if token is available)
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

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
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
