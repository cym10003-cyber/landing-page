export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const owner = 'cym10003-cyber';
  const repo = 'landing-page';
  const path = 'data/search_logs.json';
  const token = (process.env.GITHUB_TOKEN || '').trim();

  // GET: Fetch search logs from GitHub API
  if (req.method === 'GET') {
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const headers = { 'Accept': 'application/vnd.github.v3+json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const ghRes = await fetch(`${url}?t=${Date.now()}`, { headers });
      if (ghRes.ok) {
        const data = await ghRes.json();
        if (data && data.content) {
          const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
          const logs = JSON.parse(contentStr);
          return res.status(200).json(Array.isArray(logs) ? logs : []);
        }
      }
    } catch(e) {}

    return res.status(200).json([]);
  }

  // POST: Record a new search log
  if (req.method === 'POST') {
    try {
      const { query, device, timestamp, date } = req.body || {};
      if (!query || String(query).trim().length < 2) {
        return res.status(400).json({ error: 'Valid query required' });
      }

      const logObj = {
        query: String(query).trim(),
        device: device === 'mobile' ? 'mobile' : 'desktop',
        timestamp: timestamp || Date.now(),
        date: date || new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
      };

      if (token) {
        try {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
          const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${token}`
          };

          const getRes = await fetch(url, { headers });
          let sha = null;
          let logsList = [];

          if (getRes.ok) {
            const data = await getRes.json();
            sha = data.sha;
            try {
              const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
              logsList = JSON.parse(contentStr);
            } catch(e) {}
          }

          if (!Array.isArray(logsList)) logsList = [];
          
          // Avoid duplicate log if exact same query within 5 seconds
          const lastLog = logsList[0];
          if (!lastLog || lastLog.query !== logObj.query || Math.abs(lastLog.timestamp - logObj.timestamp) > 5000) {
            logsList.unshift(logObj);
            if (logsList.length > 500) logsList.pop();

            const jsonStr = JSON.stringify(logsList, null, 2);
            const contentBase64 = Buffer.from(jsonStr, 'utf8').toString('base64');

            const body = {
              message: `analytics: search log ${logObj.query}`,
              content: contentBase64
            };
            if (sha) body.sha = sha;

            await fetch(url, {
              method: 'PUT',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
          }
        } catch(e) {
          console.error("Analytics save error:", e);
        }
      }

      return res.status(200).json({ success: true, log: logObj });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // DELETE: Clear all search logs
  if (req.method === 'DELETE') {
    try {
      if (!token) return res.status(401).json({ error: 'Token missing' });

      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`
      };

      const getRes = await fetch(url, { headers });
      if (!getRes.ok) return res.status(200).json({ success: true, logs: [] });
      const data = await getRes.json();
      const sha = data.sha;

      const contentBase64 = Buffer.from('[]', 'utf8').toString('base64');

      await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'analytics: clear search logs',
          content: contentBase64,
          sha
        })
      });

      return res.status(200).json({ success: true, logs: [] });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
