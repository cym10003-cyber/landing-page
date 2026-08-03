module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { type, name, phone, category, location, pyeong, budget, notes } = req.body || {};
    
    const leadTypeStr = type === 'seller' ? '🏢 [건물주] 매물 내놓습니다' : '🔍 [손님] 매물 구합니다';

    const text = `🔔 [최가네부동산] 실시간 매물 의뢰 접수!\n\n` +
      `• 구분: ${leadTypeStr}\n` +
      `• 성함/상호: ${name || '-'}\n` +
      `• 연락처: ${phone || '-'}\n` +
      `• 업종/종류: ${category || '-'}\n` +
      `• 희망위치: ${location || '-'}\n` +
      `• 평수: ${pyeong || '-'}\n` +
      `• 예산: ${budget || '-'}\n` +
      `• 요청사항: ${notes || '-'}\n\n` +
      `📞 바로 전화걸기: ${phone || '-'}\n` +
      `🌐 대시보드: https://www.choi114.com/admin.html`;

    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    const chatId = process.env.TELEGRAM_CHAT_ID || '';

    if (botToken && chatId) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text
        })
      });
    }

    return res.status(200).json({ success: true, message: 'Notification processed successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
