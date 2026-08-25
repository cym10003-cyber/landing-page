export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const owner = 'cym10003-cyber';
  const repo = 'landing-page';
  const searchLogsPath = 'data/search_logs.json';
  const analyticsPath = 'data/analytics.json';
  const token = (process.env.GITHUB_TOKEN || '').trim();

  // GET: Fetch search logs or full analytics summary from GitHub API (with local file fallback)
  if (req.method === 'GET') {
    const type = req.query?.type || 'search';
    const targetPath = type === 'analytics' ? analyticsPath : searchLogsPath;
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${targetPath}`;
      const headers = { 'Accept': 'application/vnd.github.v3+json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const ghRes = await fetch(`${url}?t=${Date.now()}`, { headers });
      if (ghRes.ok) {
        const data = await ghRes.json();
        if (data && data.content) {
          const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
          const parsed = JSON.parse(contentStr);
          return res.status(200).json(parsed);
        }
      }
    } catch(e) {}

    // Fallback to local filesystem if GitHub API fetch fails or token is missing
    try {
      const localFilePath = path.join(process.cwd(), targetPath);
      if (fs.existsSync(localFilePath)) {
        const fileContent = fs.readFileSync(localFilePath, 'utf8');
        return res.status(200).json(JSON.parse(fileContent));
      }
    } catch(e) {}

    return res.status(200).json(type === 'analytics' ? {} : []);
  }

  // POST: Record pageviews, postviews, or search logs
  if (req.method === 'POST') {
    try {
      const bodyData = req.body || {};
      const { type } = bodyData;

      // Handle pageview and postview recording centrally
      if (type === 'pageview' || type === 'postview') {
        if (!token) return res.status(200).json({ success: true, localOnly: true });

        try {
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${analyticsPath}`;
          const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${token}`
          };

          const getRes = await fetch(url, { headers });
          let sha = null;
          let analytics = { totalPageviews: 0, todayPageviews: 0, todayDate: '', dailyHistory: {} };

          if (getRes.ok) {
            const data = await getRes.json();
            sha = data.sha;
            try {
              const contentStr = Buffer.from(data.content, 'base64').toString('utf8');
              analytics = JSON.parse(contentStr);
            } catch(e) {}
          }

          const todayStr = new Date().toISOString().split('T')[0];
          if (analytics.todayDate !== todayStr) {
            analytics.todayDate = todayStr;
            analytics.todayPageviews = 0;
          }

          if (!analytics.dailyHistory) analytics.dailyHistory = {};
          if (!analytics.dailyHistory[todayStr]) {
            analytics.dailyHistory[todayStr] = { date: todayStr, count: 0, referrers: {}, postViews: {} };
          }

          if (type === 'pageview') {
            analytics.totalPageviews = (analytics.totalPageviews || 0) + 1;
            analytics.todayPageviews = (analytics.todayPageviews || 0) + 1;
            analytics.dailyHistory[todayStr].count = (analytics.dailyHistory[todayStr].count || 0) + 1;

            const referrer = bodyData.referrer || '직접 접속 / 카카오톡 링크';
            if (!analytics.dailyHistory[todayStr].referrers) analytics.dailyHistory[todayStr].referrers = {};
            analytics.dailyHistory[todayStr].referrers[referrer] = (analytics.dailyHistory[todayStr].referrers[referrer] || 0) + 1;
          } else if (type === 'postview' && bodyData.postId) {
            const pid = String(bodyData.postId);
            if (!analytics.dailyHistory[todayStr].postViews) analytics.dailyHistory[todayStr].postViews = {};
            analytics.dailyHistory[todayStr].postViews[pid] = (analytics.dailyHistory[todayStr].postViews[pid] || 0) + 1;
          }

          // Limit history to 60 days
          const dates = Object.keys(analytics.dailyHistory).sort();
          if (dates.length > 60) {
            dates.slice(0, dates.length - 60).forEach(d => delete analytics.dailyHistory[d]);
          }

          const jsonStr = JSON.stringify(analytics, null, 2);
          const contentBase64 = Buffer.from(jsonStr, 'utf8').toString('base64');

          await fetch(url, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `analytics: record ${type}`,
              content: contentBase64,
              ...(sha ? { sha } : {})
            })
          });

          return res.status(200).json({ success: true, analytics });
        } catch(e) {
          console.error("Central analytics update failed:", e);
          return res.status(200).json({ success: true, fallback: true });
        }
      }

      // Handle search log recording (existing query handler)
      const { query, device, timestamp, date } = bodyData;
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
          const url = `https://api.github.com/repos/${owner}/${repo}/contents/${searchLogsPath}`;
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

      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${searchLogsPath}`;
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
