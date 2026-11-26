console.log("Antigravity db.js version: 20261126_v263");
// Force clear localStorage posts cache if version changes to flush stale client isPrivate cache
const APP_VERSION = "20261125_v261";
if (localStorage.getItem('app_version') !== APP_VERSION) {
  localStorage.removeItem('posts_cache');
  localStorage.removeItem('choi_briefings_cache');
  localStorage.setItem('app_version', APP_VERSION);
}
let _config = null;
let _cachedPosts = null;

async function loadConfig() {
  if (_config) return _config;
  let api = {}, file = {};
  try { const r = await fetch('/api/config'); if (r.ok) api = await r.json(); } catch(e) {}
  try { const r = await fetch('config/git_config.json'); if (r.ok) file = await r.json(); } catch(e) {}
  const apiTok = String(api.github_token || '').trim();
  const fileTok = String(file.github_token || '').trim();
  _config = {
    github_token: (apiTok && apiTok !== 'YOUR_GITHUB_TOKEN') ? apiTok : (fileTok !== 'YOUR_GITHUB_TOKEN' ? fileTok : ''),
    github_owner: file.github_owner || '',
    github_repo: file.github_repo || '',
    data_file_path: file.data_file_path || 'data/posts.json',
    admin_password: api.admin_password || file.admin_password || 'admin1234'
  };
  if (_config.github_token) {
    _config.github_token = _config.github_token.replace(/\s+/g, "").trim();
  }
  return _config;
}

function isAdmin() {
  return sessionStorage.getItem('isAdmin') === 'true' || localStorage.getItem('isAdmin') === 'true';
}

function requireAdmin() {
  if (!isAdmin()) {
    window.location.href = 'admin.html';
  }
}

function base64ToUtf8(b64Str) {
  try {
    const cleanB64 = b64Str.replace(/[\r\n\s]/g, '');
    const binary = atob(cleanB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return null;
  }
}

async function getPosts() {
  const config = await loadConfig();
  const hasGit = config.github_token && config.github_owner && config.github_repo;

  let cachedPosts = [];
  try {
    const cached = localStorage.getItem('posts_cache');
    if (cached) cachedPosts = JSON.parse(cached);
  } catch(e) {}

  let remotePosts = null;

  // Tier 1: Try GitHub REST API for un-cached real-time data if token is available
  if (hasGit && config.github_token) {
    try {
      const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/${config.data_file_path}?t=${Date.now()}`;
      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `token ${config.github_token}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      };
      const res = await fetch(url, { headers, cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const decodedStr = base64ToUtf8(data.content);
        if (decodedStr) {
          remotePosts = JSON.parse(decodedStr);
        }
      }
    } catch (e) {
      console.warn("GitHub REST API fetch failed, trying raw CDN:", e);
    }
  }

  // Tier 2: Try fetching raw JSON directly from GitHub main branch if REST API failed or token missing
  if (!remotePosts && hasGit) {
    try {
      const rawUrl = `https://raw.githubusercontent.com/${config.github_owner}/${config.github_repo}/main/${config.data_file_path}?t=${Date.now()}&r=${Math.random()}`;
      const rawRes = await fetch(rawUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      if (rawRes.ok) {
        remotePosts = await rawRes.json();
      }
    } catch (e) {
      console.warn("Raw GitHub fetch failed:", e);
    }
  }

  // Tier 3: Local file fallback
  if (!remotePosts) {
    try {
      const filePath = config.data_file_path.startsWith('/') ? config.data_file_path : '/' + config.data_file_path;
      const res = await fetch(filePath + '?t=' + Date.now());
      if (res.ok) {
        remotePosts = await res.json();
      }
    } catch (e) {}
  }

  if (remotePosts && Array.isArray(remotePosts)) {
    // Exclude locally deleted posts in last 30 min
    try {
      let deletedList = JSON.parse(localStorage.getItem('deleted_post_ids') || '[]');
      const nowTime = Date.now();
      deletedList = deletedList.filter(item => nowTime - item.time < 1800000);
      const deletedSet = new Set(deletedList.map(item => String(item.id)));
      if (deletedSet.size > 0) {
        remotePosts = remotePosts.filter(rp => !deletedSet.has(String(rp.id)));
      }
    } catch(e) {}

    // Only merge very recent local admin edits (within 30 min) so CDN propagation never flickers for the broker,
    // while NEVER allowing stale localStorage caches on other devices/customers to overwrite server isPrivate/post truth!
    if (isAdmin()) {
      let latestSaved = null;
      try {
        const ls = localStorage.getItem('latest_saved_post');
        if (ls) latestSaved = JSON.parse(ls);
      } catch(e) {}

      const now = Date.now();
      const cachedMap = new Map();

      if (Array.isArray(cachedPosts)) {
        for (let cp of cachedPosts) {
          if (cp && cp.id) cachedMap.set(String(cp.id), cp);
        }
      }
      if (latestSaved && latestSaved.id) {
        cachedMap.set(String(latestSaved.id), latestSaved);
      }

      for (let [cpId, cp] of cachedMap.entries()) {
        const idx = remotePosts.findIndex(rp => String(rp.id) === cpId);
        if (idx !== -1) {
          const remoteUpdatedAt = Number(remotePosts[idx].updatedAt || 0);
          const localUpdatedAt = Number(cp.updatedAt || 0);
          if (latestSaved && String(latestSaved.id) === cpId && localUpdatedAt > remoteUpdatedAt && (now - localUpdatedAt < 1800000)) {
            remotePosts[idx] = { ...remotePosts[idx], ...latestSaved };
          } else if (localUpdatedAt > remoteUpdatedAt && (now - localUpdatedAt < 1800000)) {
            remotePosts[idx] = { ...remotePosts[idx], ...cp };
          }
        } else {
          // Brand new post created locally by admin in last 30 min
          const postAge = now - Number(cp.id);
          if (!isNaN(postAge) && postAge < 1800000) {
            remotePosts.unshift(cp);
          }
        }
      }
    }

    try {
      localStorage.setItem('posts_cache', JSON.stringify(remotePosts));
    } catch(e) {}
    _cachedPosts = remotePosts;
    return remotePosts;
  }

  if (cachedPosts.length > 0) {
    _cachedPosts = cachedPosts;
    return _cachedPosts;
  }

  _cachedPosts = [];
  return [];
}

function utf8ToBase64(str) {
  try {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)));
    }
    return btoa(binary);
  } catch(e) {
    return btoa(unescape(encodeURIComponent(str)));
  }
}

async function savePost(postData) {
  const config = await loadConfig();
  const posts = await getPosts();
  let updatedPost = null;

  if (postData.id) {
    let idx = posts.findIndex(p => String(p.id) === String(postData.id));
    if (idx === -1) {
      const cleanId = String(postData.id).replace(/[^0-9]/g, '');
      if (cleanId) {
        idx = posts.findIndex(p => {
          const pidStr = String(p.id);
          const titleStr = p.title || '';
          const contentStr = p.content || '';
          return pidStr === cleanId || pidStr.includes(cleanId) ||
                 titleStr.includes(`매물번호:${cleanId}`) || titleStr.includes(`매물번호 : ${cleanId}`) ||
                 contentStr.includes(`매물번호:${cleanId}`) || contentStr.includes(`매물번호 : ${cleanId}`);
        });
      }
    }

    if (idx !== -1) {
      posts[idx].title = postData.title;
      posts[idx].category = postData.category;
      posts[idx].content = postData.content;
      posts[idx].address = postData.address;
      posts[idx].coordinates = postData.coordinates;
      if (postData.isPrivate !== undefined) posts[idx].isPrivate = postData.isPrivate === true;
      posts[idx].date = postData.date || posts[idx].date || new Date().toLocaleDateString('ko-KR').replace(/\.$/, "");
      posts[idx].updatedAt = Date.now();
      updatedPost = posts[idx];
    } else {
      throw new Error("Post not found");
    }
  } else {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}. ${month}. ${day}`;
    
    updatedPost = {
      id: Date.now().toString(),
      title: postData.title,
      category: postData.category,
      content: postData.content,
      address: postData.address,
      coordinates: postData.coordinates,
      isPrivate: postData.isPrivate === true,
      date: dateStr
    };
    posts.unshift(updatedPost);
  }

  const postsStr = JSON.stringify(posts, null, 2);
  localStorage.setItem('posts_cache', postsStr);
  try {
    localStorage.setItem('latest_saved_post', JSON.stringify(updatedPost));
  } catch(e) {}
  _cachedPosts = posts;

  const hasGit = config.github_token && config.github_owner && config.github_repo;
  if (hasGit) {
    const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/${config.data_file_path}`;
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${config.github_token}`
    };

    let lastErr = null;
    let savedToGit = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Step 1: GET current file SHA
        const getUrl = `${url}?t=${Date.now()}`;
        let sha = null;
        const getRes = await fetch(getUrl, { headers });
        if (getRes.ok) {
          const getData = await getRes.json();
          if (!Array.isArray(getData) && getData.sha) {
            sha = getData.sha;
          }
        }

        // Step 2: PUT updated posts.json
        const base64Content = utf8ToBase64(postsStr);
        const bodyObj = {
          message: postData.id ? `feat: update post ${postData.id}` : `feat: add new post`,
          content: base64Content,
          branch: 'main'
        };
        if (sha) bodyObj.sha = sha;

        const putRes = await fetch(url, {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(bodyObj)
        });

        if (putRes.ok) {
          savedToGit = true;
          try {
            fetch('https://api.vercel.com/v1/integrations/deploy/prj_qegayNObhh5O8C6xc9zyAtGxst2D/rjbOZRIWc3', { method: 'POST' });
          } catch(e) {}
          // Notify Naver & Bing/ChatGPT immediately via IndexNow when a public listing is saved
          if (updatedPost && updatedPost.id && !updatedPost.isPrivate) {
            try {
              fetch('/api/indexnow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postId: updatedPost.id })
              }).catch(() => {});
            } catch(e) {}
          }
          break;
        } else {
          const errorMsg = await putRes.text();
          lastErr = new Error(`GitHub Save Failed (${putRes.status}): ${errorMsg}`);
        }
      } catch (err) {
        lastErr = err;
      }

      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!savedToGit) {
      console.warn("GitHub save failed after 3 attempts, saved to local cache:", lastErr);
    }
  }

  // Auto-sync updated post conditions (보증금, 월세, 공용관리비, 권리금, 매매가, 면적, 층수 등) to existing briefings
  try {
    if (typeof syncUpdatedPostToBriefings === 'function' && updatedPost) {
      await syncUpdatedPostToBriefings(updatedPost);
    }
  } catch (e) {}

  return updatedPost;
}

async function deletePost(id) {
  const config = await loadConfig();
  const posts = await getPosts();
  const filtered = posts.filter(p => String(p.id) !== String(id));
  
  if (posts.length === filtered.length) {
    throw new Error("Post not found");
  }

  // Track deleted IDs in localStorage for 30 minutes to prevent resurrecting deleted posts from stale CDN cache
  try {
    let deletedList = JSON.parse(localStorage.getItem('deleted_post_ids') || '[]');
    deletedList = deletedList.filter(item => Date.now() - item.time < 1800000);
    deletedList.push({ id: String(id), time: Date.now() });
    localStorage.setItem('deleted_post_ids', JSON.stringify(deletedList));
  } catch(e) {}

  const postsStr = JSON.stringify(filtered, null, 2);
  localStorage.setItem('posts_cache', postsStr);
  _cachedPosts = filtered;

  const hasGit = config.github_token && config.github_owner && config.github_repo;
  if (hasGit) {
    const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/${config.data_file_path}`;
    const getUrl = `${url}?t=${Date.now()}`;
    let sha = null;
    
    try {
      const headers = {
        'Accept': 'application/vnd.github.v3+json'
      };
      if (config.github_token) {
        headers['Authorization'] = `token ${config.github_token}`;
      }
      let getRes = await fetch(getUrl, { headers });
      if (getRes.ok) {
        const getData = await getRes.json();
        sha = getData.sha;
      } else {
        throw new Error(`Failed to fetch file metadata (Status: ${getRes.status})`);
      }
    } catch (e) {
      throw new Error(`GitHub Connection Error (SHA Fetch): ${e.message}`);
    }

    if (sha) {
      const base64Content = utf8ToBase64(postsStr);
      const body = {
        message: `feat: delete post ${id}`,
        content: base64Content,
        sha: sha,
        branch: 'main'
      };

      const putRes = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${config.github_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify(body)
      });

      if (!putRes.ok) {
        const errorMsg = await putRes.text();
        throw new Error(`GitHub Delete Failed: ${putRes.status} ${errorMsg}`);
      }
    }
  }
  return true;
}

async function togglePostPrivate(id) {
  const config = await loadConfig();
  const posts = await getPosts();
  const idx = posts.findIndex(p => String(p.id) === String(id));
  if (idx === -1) throw new Error("Post not found");

  const now = Date.now();
  posts[idx].isPrivate = !posts[idx].isPrivate;
  posts[idx].updatedAt = now;
  const isNowPrivate = posts[idx].isPrivate;

  const postsStr = JSON.stringify(posts, null, 2);
  localStorage.setItem('posts_cache', postsStr);
  try {
    localStorage.setItem('latest_saved_post', JSON.stringify(posts[idx]));
  } catch(e) {}
  _cachedPosts = posts;

  const hasGit = config.github_token && config.github_owner && config.github_repo;
  if (hasGit) {
    const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/${config.data_file_path}`;
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${config.github_token}`
    };

    let lastErr = null;
    let savedToGit = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const getUrl = `${url}?t=${Date.now()}`;
        let sha = null;
        const getRes = await fetch(getUrl, { headers });
        if (getRes.ok) {
          const getData = await getRes.json();
          if (!Array.isArray(getData) && getData.sha) {
            sha = getData.sha;
          }
        }

        const base64Content = btoa(unescape(encodeURIComponent(postsStr)));
        const body = {
          message: `feat: toggle private status for post ${id} to ${isNowPrivate}`,
          content: base64Content,
          branch: 'main'
        };
        if (sha) body.sha = sha;

        const putRes = await fetch(url, {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        if (putRes.ok) {
          savedToGit = true;
          break;
        } else {
          const errText = await putRes.text();
          lastErr = new Error(`GitHub API Status ${putRes.status}: ${errText}`);
        }
      } catch (err) {
        lastErr = err;
      }
      await new Promise(r => setTimeout(r, 800));
    }

    if (!savedToGit && lastErr) {
      console.error("Failed to update GitHub posts.json:", lastErr);
    }
  }

  return isNowPrivate;
}

function renderMarkdown(src) {
  if (!src) return '';
  
  // Convert GitHub raw URLs to high-speed jsDelivr CDN URLs for ultra-fast asset loading
  let convertedSrc = src.replace(/raw\.githubusercontent\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/main\//g, 'cdn.jsdelivr.net/gh/$1/$2@main/');

  // If the text contains native HTML tags or uploaded HTML document markup, render HTML directly!
  const isHtml = /<\/?(div|p|span|table|tr|td|th|tbody|thead|style|img|iframe|h[1-6]|ul|ol|li|br|b|i|strong|em|u|a|section|article|header|footer|font|button|form|input|label)[\s>\/]/i.test(convertedSrc);

  if (isHtml) {
    let cleanHtml = convertedSrc;
    let styleBlocks = '';
    const styleMatches = cleanHtml.match(/<style[\s\S]*?>[\s\S]*?<\/style>/gi);
    if (styleMatches) {
      styleBlocks = styleMatches.join('\n');
    }

    if (/<body[\s\S]*?>([\s\S]*?)<\/body>/i.test(cleanHtml)) {
      const match = cleanHtml.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
      if (match) cleanHtml = match[1];
    }
    cleanHtml = cleanHtml
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<\/?html[\s\S]*?>/gi, '')
      .replace(/<head[\s\S]*?>[\s\S]*?<\/head>/gi, '')
      .replace(/<\/?body[\s\S]*?>/gi, '')
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
      .trim();

    // Convert Markdown image syntax ![alt](url) to HTML <img> tags in HTML mode
    cleanHtml = cleanHtml.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
      return `<img src="${url}" onerror="if(typeof handlePostImgError==='function'){handlePostImgError(this);}else if(!this.dataset.retried){this.dataset.retried='1';this.src=this.src.replace('cdn.jsdelivr.net/gh/cym10003-cyber/landing-page-assets@main','raw.githubusercontent.com/cym10003-cyber/landing-page-assets/main');}" alt="${alt || '매물 이미지'}" class="max-w-full h-auto rounded-xl shadow-card-soft border border-hairline my-md mx-auto block" loading="lazy">`;
    });

    // Format any raw unformatted plain text outside HTML tags into clean <p> blocks
    const lastTagIdx = cleanHtml.lastIndexOf('>');
    if (lastTagIdx !== -1 && lastTagIdx < cleanHtml.length - 1) {
      const htmlPart = cleanHtml.substring(0, lastTagIdx + 1);
      const rawTextPart = cleanHtml.substring(lastTagIdx + 1).trim();
      if (rawTextPart) {
        const formattedLines = rawTextPart.split('\n').map(line => {
          const t = line.trim();
          if (!t) return '';
          if (t.startsWith('<') || t.startsWith('!')) return t;
          return `<p style="margin-bottom: 12px; line-height: 1.6;">${t}</p>`;
        }).filter(Boolean).join('\n');
        cleanHtml = htmlPart + '\n\n' + formattedLines;
      }
    }

    const mobileFixStyle = `<style>
.html-post-container .container { max-width: 100% !important; padding: 0 !important; }
@media (max-width: 640px) {
  .blog-container { border-radius: 12px !important; margin: 0 auto !important; border: none !important; box-shadow: none !important; }
  .content-body { padding: 16px 10px !important; }
  .header-banner { padding: 24px 16px !important; }
  .main-title { font-size: 20px !important; }
  .highlight-grid, .hero-highlight-grid, .yield-grid { grid-template-columns: 1fr !important; gap: 10px !important; }
  .highlight-card { padding: 12px 10px !important; }
  .highlight-card .value { font-size: 17px !important; }
  .info-table, .spec-table { display: block !important; width: 100% !important; }
  .info-table tbody, .spec-table tbody { display: block !important; width: 100% !important; }
  .info-table tr, .spec-table tr { display: flex !important; flex-wrap: wrap !important; border-bottom: 1px solid #e2e8f0 !important; padding: 8px 4px !important; }
  .info-table th, .info-table td, .spec-table th, .spec-table td { display: block !important; box-sizing: border-box !important; border: none !important; padding: 4px 6px !important; word-break: keep-all !important; line-height: 1.5 !important; }
  .info-table th, .spec-table th { width: 32% !important; background: transparent !important; color: #475569 !important; font-weight: 700 !important; font-size: 13px !important; }
  .info-table td, .spec-table td { width: 68% !important; color: #0f172a !important; font-size: 13.5px !important; }
  .info-table td[colspan="3"], .spec-table td[colspan="3"] { width: 68% !important; }
  .hero-card { padding: 24px 16px !important; }
  .hero-title { font-size: 20px !important; }
  .section-card { padding: 16px 12px !important; }
  .broker-card { padding: 16px !important; }
  .broker-list li { display: flex !important; align-items: flex-start !important; margin-bottom: 8px !important; }
  .broker-list li strong { width: 72px !important; min-width: 72px !important; flex-shrink: 0 !important; }
  .broker-list li span, .broker-list li a { word-break: keep-all !important; flex: 1 !important; }
  .cta-box { padding: 20px 14px !important; }
  .cta-btn { display: inline-flex !important; align-items: center !important; justify-content: center !important; font-size: 14px !important; padding: 12px 14px !important; width: 100% !important; white-space: nowrap !important; box-sizing: border-box !important; }
}
</style>`;

    return `<div class="html-post-container overflow-x-auto text-ink leading-relaxed space-y-2">${mobileFixStyle}\n${styleBlocks}\n${cleanHtml}</div>`;
  }

  let html = convertedSrc
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // Restore safe <video> tags securely
  html = html.replace(/&lt;video\s+([\s\S]*?)&gt;&lt;\/video&gt;/gi, (match, attrsHtml) => {
    const srcMatch = attrsHtml.match(/src=&quot;([\s\S]*?)&quot;/i);
    const classMatch = attrsHtml.match(/class=&quot;([\s\S]*?)&quot;/i);
    const controls = attrsHtml.toLowerCase().includes('controls');
    const autoplay = attrsHtml.toLowerCase().includes('autoplay');
    const loop = attrsHtml.toLowerCase().includes('loop');
    const muted = attrsHtml.toLowerCase().includes('muted');
    const playsinline = attrsHtml.toLowerCase().includes('playsinline');
    
    if (srcMatch) {
      const src = srcMatch[1].trim();
      if (/^(https?:\/\/|\/)/i.test(src)) {
        const cls = classMatch ? classMatch[1] : 'w-full rounded-xl overflow-hidden shadow-card-soft border border-hairline my-lg';
        let videoTag = `<video src="${src}" controls playsinline webkit-playsinline preload="metadata" class="${cls}" onerror="`;
        videoTag += `console.error('Video load error:', this.error); `;
        videoTag += `const errDiv = document.createElement('div'); `;
        videoTag += `errDiv.style.cssText = 'color: #ba1a1a; background-color: #ffdad6; padding: 12px; border-radius: 8px; font-size: 11px; margin-top: 8px; text-align: center; border: 1px solid #ffb4ab; line-height: 1.4;'; `;
        videoTag += `errDiv.innerText = '동영상 로딩 실패 (에러 코드: ' + (this.error ? this.error.code : '알수없음') + ') \\n주소: ' + this.src; `;
        videoTag += `this.parentNode.insertBefore(errDiv, this.nextSibling);`;
        videoTag += `"></video>`;
        return videoTag;
      }
    }
    return match;
  });

  const safeLink = (url, text) => {
    const cleanUrl = url.trim();
    if (/^(https?:\/\/|mailto:)/i.test(cleanUrl)) {
      return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">${text}</a>`;
    }
    return text;
  };

  let blocks = html.split(/\n\s*\n/);
  let processedBlocks = blocks.map(block => {
    block = block.trim();
    if (!block) return '';

    // Check if the block is a single clean URL on its own line
    const urlPattern = /^(https?:\/\/[^\s]+)$/i;
    if (urlPattern.test(block)) {
      const cleanUrl = block.replace(/&amp;/g, '&').trim();
      let ytVideoId = '';
      if (/youtube\.com/i.test(cleanUrl)) {
        if (cleanUrl.includes('/shorts/')) {
          const match = cleanUrl.match(/\/shorts\/([a-zA-Z0-9_-]{11})/i);
          if (match) ytVideoId = match[1];
        } else {
          const match = cleanUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/i);
          if (match) ytVideoId = match[1];
        }
      } else if (/youtu\.be/i.test(cleanUrl)) {
        const match = cleanUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
        if (match) ytVideoId = match[1];
      }

      if (ytVideoId) {
        return `<div class="relative w-full aspect-video rounded-xl overflow-hidden shadow-card-soft border border-hairline my-lg">
          <iframe class="absolute top-0 left-0 w-full h-full" src="https://www.youtube.com/embed/${ytVideoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
        </div>`;
      }
      return `<div class="link-preview-card my-lg" data-url="${block.trim()}"></div>`;
    }

    if (block.startsWith('```')) {
      const match = block.match(/^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n?```$/);
      if (match) {
        const code = match[2];
        return `<pre class="bg-surface-container p-md rounded-xl my-md overflow-x-auto"><code class="font-mono text-sm text-ink">${code}</code></pre>`;
      }
    }

    if (/^---$/.test(block)) {
      return '<hr class="border-hairline my-lg">';
    }

    if (block.startsWith('&gt;')) {
      const lines = block.split('\n').map(line => line.replace(/^&gt;\s?/, ''));
      return `<blockquote class="border-l-4 border-primary-container pl-md py-xs my-md italic text-muted">${renderInline(lines.join('\n'))}</blockquote>`;
    }

    if (block.startsWith('#')) {
      const match = block.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        const level = match[1].length;
        const text = renderInline(match[2]);
        const classes = [
          '',
          'font-display-hero text-2xl font-bold my-lg',
          'font-section-h2 text-xl font-bold my-md',
          'font-subsection-h3 text-lg font-bold my-sm',
          'text-base font-bold my-sm',
          'text-sm font-bold my-sm',
          'text-xs font-bold my-sm'
        ];
        return `<h${level} class="${classes[level] || ''}">${text}</h${level}>`;
      }
    }

    if (block.startsWith('- ') || block.startsWith('* ')) {
      const items = block.split(/\n(?=[-|\*]\s)/).map(item => {
        const text = item.replace(/^[-|\*]\s+/, '');
        return `<li class="ml-base list-disc">${renderInline(text)}</li>`;
      });
      return `<ul class="my-md space-y-xs">${items.join('')}</ul>`;
    }

    if (/^\d+\.\s+/.test(block)) {
      const items = block.split(/\n(?=\d+\.\s)/).map(item => {
        const text = item.replace(/^\d+\.\s+/, '');
        return `<li class="ml-base list-decimal">${renderInline(text)}</li>`;
      });
      return `<ol class="my-md space-y-xs">${items.join('')}</ol>`;
    }

    return `<p class="leading-relaxed my-md">${renderInline(block)}</p>`;
  });

  function renderInline(text) {
    let parts = text.split('`');
    for (let i = 1; i < parts.length; i += 2) {
      parts[i] = `<code class="bg-surface-container px-xs py-[2px] rounded font-mono text-sm text-error">${parts[i]}</code>`;
    }
    text = parts.join('');

    const htmlPlaceholders = [];
    const imgPlaceholders = [];
    const linkPlaceholders = [];

    // 0. Extract Raw HTML Tags (to protect them from markdown parsing)
    text = text.replace(/<[^>]+>/g, (match) => {
      const idx = htmlPlaceholders.length;
      htmlPlaceholders.push(match);
      return `%%HTMLPLACEHOLDER${idx}%%`;
    });

    // 1. Extract Images
    text = text.replace(/!\[(.*?)\]\((.*?)\)/g, (match, altText, url) => {
      const idx = imgPlaceholders.length;
      imgPlaceholders.push({ altText, url });
      return `%%IMGPLACEHOLDER${idx}%%`;
    });

    // 2. Extract Links
    text = text.replace(/\[(.*?)\]\((.*?)\)/g, (match, linkText, url) => {
      const idx = linkPlaceholders.length;
      linkPlaceholders.push({ linkText, url });
      return `%%LINKPLACEHOLDER${idx}%%`;
    });

    // 3. Process Bold, Italics, Strikethrough
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.*?)__/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    text = text.replace(/_(.*?)_/g, '<em>$1</em>');
    text = text.replace(/~~(.*?)~~/g, '<del>$1</del>');

    // 4. Restore Images
    text = text.replace(/%%IMGPLACEHOLDER(\d+)%%/g, (match, idx) => {
      const { altText, url } = imgPlaceholders[parseInt(idx, 10)];
      const cleanUrl = url.trim();
      if (/^(https?:\/\/|data:image\/)/i.test(cleanUrl)) {
        return `<img src="${cleanUrl}" onerror="if(typeof handlePostImgError==='function'){handlePostImgError(this);}else if(!this.dataset.retried){this.dataset.retried='1';this.src=this.src.replace('cdn.jsdelivr.net/gh/cym10003-cyber/landing-page-assets@main','raw.githubusercontent.com/cym10003-cyber/landing-page-assets/main');}" alt="${altText}" class="max-w-full h-auto rounded-xl shadow-card-soft border border-hairline my-md mx-auto block" />`;
      }
      return `![${altText}](${url})`;
    });

    // 5. Restore Links
    text = text.replace(/%%LINKPLACEHOLDER(\d+)%%/g, (match, idx) => {
      const { linkText, url } = linkPlaceholders[parseInt(idx, 10)];
      return safeLink(url, linkText);
    });

    // 6. Restore Raw HTML Tags
    text = text.replace(/%%HTMLPLACEHOLDER(\d+)%%/g, (match, idx) => {
      return htmlPlaceholders[parseInt(idx, 10)];
    });

    text = text.replace(/\n/g, '<br>');

    return text;
  }

  let result = processedBlocks.join('\n');
  
  // Unescape safe iframe and video elements
  result = result.replace(/&lt;iframe ([\s\S]*?)&gt;&lt;\/iframe&gt;/g, (match, attrs) => {
    return `<iframe ${attrs.replace(/&quot;/g, '"').replace(/&#039;/g, "'")}></iframe>`;
  });
  result = result.replace(/&lt;video ([\s\S]*?)&gt;&lt;\/video&gt;/g, (match, attrs) => {
    return `<video ${attrs.replace(/&quot;/g, '"').replace(/&#039;/g, "'")}></video>`;
  });
  result = result.replace(/&lt;div class=&quot;relative w-full aspect-video rounded-xl overflow-hidden shadow-card-soft border border-hairline my-lg&quot;&gt;/g, '<div class="relative w-full aspect-video rounded-xl overflow-hidden shadow-card-soft border border-hairline my-lg">');
  result = result.replace(/&lt;\/div&gt;/g, '</div>');
  result = result.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>');
  result = result.replace(/&lt;span style=&quot;color:\s*(#[a-fA-F0-9]{3,6}|[a-zA-Z]+);&quot;&gt;([\s\S]*?)&lt;\/span&gt;/g, (match, color, text) => {
    return `<span style="color: ${color};">${text}</span>`;
  });
  
  return result;
}

function markdownToText(src) {
  if (!src) return '';
  let text = src;
  
  // Completely strip image markdown ![altText](url)
  text = text.replace(/!\[(.*?)\]\((.*?)\)/g, '');
  
  // Completely strip HTML tags (like video, iframe, etc.)
  text = text.replace(/<[^>]*>/g, '');

  text = text.replace(/^---[\s\S]*?---/, '');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^>\s+/gm, '');
  text = text.replace(/^---$/gm, '');
  text = text.replace(/^[-*]\s+/gm, '');
  text = text.replace(/^\d+\.\s+/gm, '');
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/__(.*?)__/g, '$1');
  text = text.replace(/_(.*?)_/g, '$1');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/\[(.*?)\]\((.*?)\)/g, '$1');
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

async function uploadImageFile(file) {
  const config = await loadConfig();
  const hasGit = config.github_token && config.github_owner && config.github_repo;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      
      if (hasGit) {
        const base64Content = dataUrl.split(',')[1];
        const rand = Math.random().toString(36).substring(2, 6);
        const safeName = (file.name || 'image.jpg').replace(/[^a-zA-Z0-9.]/g, '_');
        const filename = `post_img_${Date.now()}_${rand}_${safeName}`;
        const url = `https://api.github.com/repos/${config.github_owner}/landing-page-assets/contents/images/${filename}`;
        
        const bodyStr = JSON.stringify({
          message: `feat: upload image ${filename}`,
          content: base64Content,
          branch: 'main'
        });

        const headers = {
          'Authorization': `token ${config.github_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        };
        
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const putRes = await fetch(url, {
              method: 'PUT',
              headers: headers,
              body: bodyStr
            });
            
            if (putRes.ok) {
              const result = await putRes.json();
              const commitSha = (result && result.commit && result.commit.sha) ? result.commit.sha : 'main';
              const rawUrl = `https://cdn.jsdelivr.net/gh/${config.github_owner}/landing-page-assets@${commitSha}/images/${filename}`;
              return resolve(rawUrl);
            } else {
              const errorMsg = await putRes.text();
              lastErr = new Error(`GitHub Upload Failed (${putRes.status}): ${errorMsg}`);
            }
          } catch (err) {
            lastErr = err;
          }
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 800));
          }
        }
        
        console.warn('GitHub image upload failed after 3 attempts, using resilient base64 fallback:', lastErr);
        resolve(dataUrl);
      } else {
        // Local Fallback: return base64 Data URL directly
        resolve(dataUrl);
      }
    };
    reader.onerror = (error) => resolve(URL.createObjectURL(file));
    reader.readAsDataURL(file);
  });
}

async function uploadVideoFile(file) {
  const config = await loadConfig();
  const hasGit = config.github_token && config.github_owner && config.github_repo;

  if (file.size > 50 * 1024 * 1024) {
    throw new Error("파일 크기가 너무 큽니다. 50MB 이하의 동영상 파일만 업로드할 수 있습니다.");
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      
      if (hasGit) {
        const base64Content = dataUrl.split(',')[1];
        const rand = Math.random().toString(36).substring(2, 6);
        const safeName = (file.name || 'video.mp4').replace(/[^a-zA-Z0-9.]/g, '_');
        const filename = `post_vid_${Date.now()}_${rand}_${safeName}`;
        const url = `https://api.github.com/repos/${config.github_owner}/landing-page-assets/contents/videos/${filename}`;
        
        const bodyStr = JSON.stringify({
          message: `feat: upload video ${filename}`,
          content: base64Content,
          branch: 'main'
        });

        const headers = {
          'Authorization': `token ${config.github_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        };

        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const putRes = await fetch(url, {
              method: 'PUT',
              headers: headers,
              body: bodyStr
            });
            
            if (putRes.ok) {
              const result = await putRes.json();
              const commitSha = (result.commit && result.commit.sha) ? result.commit.sha : 'main';
              const rawUrl = `https://cdn.jsdelivr.net/gh/${config.github_owner}/landing-page-assets@${commitSha}/videos/${filename}`;
              return resolve(rawUrl);
            } else {
              const errorMsg = await putRes.text();
              lastErr = new Error(`GitHub Video Upload Failed (${putRes.status}): ${errorMsg}`);
            }
          } catch (err) {
            lastErr = err;
          }
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        console.warn('GitHub video upload failed after 3 attempts, using resilient base64 fallback:', lastErr);
        resolve(dataUrl);
      } else {
        // Local Fallback: return base64 Data URL directly
        resolve(dataUrl);
      }
    };
    reader.onerror = (error) => resolve(URL.createObjectURL(file));
    reader.readAsDataURL(file);
  });
}

async function uploadDocFile(file, prefix = 'doc') {
  const config = await loadConfig();
  const hasGit = config.github_token && config.github_owner && config.github_repo;

  if (file.size > 40 * 1024 * 1024) {
    throw new Error("파일 크기가 너무 큽니다. 40MB 이하의 PDF/문서 파일만 업로드할 수 있습니다.");
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;

      if (hasGit) {
        const base64Content = dataUrl.split(',')[1];
        const rand = Math.random().toString(36).substring(2, 6);
        const extMatch = (file.name || 'document.pdf').match(/\.[a-zA-Z0-9]+$/);
        const ext = extMatch ? extMatch[0].toLowerCase() : '.pdf';
        const safePrefix = String(prefix || 'doc').replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `${safePrefix}_${Date.now()}_${rand}${ext}`;
        const url = `https://api.github.com/repos/${config.github_owner}/landing-page-assets/contents/docs/${filename}`;

        const bodyStr = JSON.stringify({
          message: `feat: upload document ${filename} [skip ci]`,
          content: base64Content,
          branch: 'main'
        });

        const headers = {
          'Authorization': `token ${config.github_token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        };

        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const putRes = await fetch(url, {
              method: 'PUT',
              headers: headers,
              body: bodyStr
            });

            if (putRes.ok) {
              const result = await putRes.json();
              const commitSha = (result.commit && result.commit.sha) ? result.commit.sha : 'main';
              const rawUrl = `https://cdn.jsdelivr.net/gh/${config.github_owner}/landing-page-assets@${commitSha}/docs/${filename}`;
              return resolve(rawUrl);
            } else {
              const errorMsg = await putRes.text();
              lastErr = new Error(`GitHub Doc Upload Failed (${putRes.status}): ${errorMsg}`);
            }
          } catch (err) {
            lastErr = err;
          }
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 800));
          }
        }

        console.warn('GitHub doc upload failed after 3 attempts, using resilient base64 fallback:', lastErr);
        resolve(dataUrl);
      } else {
        resolve(dataUrl);
      }
    };
    reader.onerror = () => resolve(URL.createObjectURL(file));
    reader.readAsDataURL(file);
  });
}
window.uploadDocFile = uploadDocFile;

const OFFICIAL_DOC_CATEGORIES = [
  '건축물대장',
  '토지대장',
  '토지이용계획확인원',
  '지적도등본',
  '등기부등본(건물)',
  '등기부등본(토지)',
  '도면',
  '임대차현황표(수익률표)',
  '실거래가·상권분석',
  '인허가·시설확인서'
];
window.OFFICIAL_DOC_CATEGORIES = OFFICIAL_DOC_CATEGORIES;

// --- Analytics & Logging Helpers ---
function getReferrerSource() {
    const ref = document.referrer || '';
    if (!ref) return '직접 접속 / 카카오톡 링크';
    try {
        const url = new URL(ref);
        const host = url.hostname.toLowerCase();
        if (host.includes('naver.com')) return '네이버 (Naver)';
        if (host.includes('google.com') || host.includes('google.co.kr')) return '구글 (Google)';
        if (host.includes('daum.net') || host.includes('kakao.com')) return '다음 / 카카오';
        if (host.includes('instagram.com') || host.includes('facebook.com')) return 'SNS (인스타/페북)';
        if (host.includes('chatgpt.com')) return 'ChatGPT (AI 추천 검색)';
        if (host.includes('choi114.com') || host.endsWith('vercel.app') || host.includes('vercel.app') || host.includes('localhost') || host.includes('127.0.0.1')) return '내부 이동';
        return host.replace('www.', '');
    } catch(e) {
        return '직접 접속 / 카카오톡 링크';
    }
}

function getKSTDateStr(offsetDays = 0) {
    try {
        const d = new Date();
        if (offsetDays !== 0) {
            d.setDate(d.getDate() + offsetDays);
        }
        return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    } catch(e) {
        const d = new Date(Date.now() + (9 * 3600 * 1000) + (offsetDays * 86400 * 1000));
        return d.toISOString().split('T')[0];
    }
}

function extractExternalSearchInflow() {
    try {
        const ref = document.referrer || '';
        const source = getReferrerSource();
        let shortEngine = '';
        if (source.includes('네이버')) shortEngine = '네이버';
        else if (source.includes('구글')) shortEngine = '구글';
        else if (source.includes('다음')) shortEngine = '다음/카카오';
        else if (source.includes('ChatGPT')) shortEngine = 'ChatGPT';

        const paramNames = ['query', 'q', 'oquery', 'acq', 'n_query', 'utm_term', 'keyword', 'k', 'wd', 'p', 'text'];

        // 1. Check current URL query parameters (e.g. utm_term, n_query, keyword)
        const curParams = new URLSearchParams(window.location.search);
        for (const pName of paramNames) {
            const val = curParams.get(pName);
            if (val && val.trim().length >= 2) {
                return {
                    keyword: val.trim(),
                    source: shortEngine || '검색유입'
                };
            }
        }

        // 2. Check document.referrer query parameters (only real search query parameters)
        if (ref) {
            try {
                const refUrl = new URL(ref);
                for (const pName of paramNames) {
                    const val = refUrl.searchParams.get(pName);
                    if (val && val.trim().length >= 2) {
                        return {
                            keyword: val.trim(),
                            source: shortEngine || '검색유입'
                        };
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

function isAdminOrInternalAnalyticsContext() {
    try {
        const path = (window.location.pathname || '').toLowerCase();
        const search = (window.location.search || '').toLowerCase();
        if (path.includes('admin') || path.includes('news-write') || search.includes('preview=admin')) return true;
        if (typeof isAdmin === 'function' && isAdmin()) return true;
    } catch (e) {}
    return false;
}

function recordPageView() {
    try {
        if (isAdminOrInternalAnalyticsContext()) return;
        const todayStr = getKSTDateStr();

        // 1일 1회 순수 방문자(UV) 판별 및 세션 첫 진입 판별
        let isNewVisitor = false;
        try {
            if (localStorage.getItem('choi_uv_date') !== todayStr) {
                localStorage.setItem('choi_uv_date', todayStr);
                isNewVisitor = true;
            }
        } catch (e) {}

        let isSessionFirst = false;
        try {
            if (!sessionStorage.getItem('choi_session_entered')) {
                sessionStorage.setItem('choi_session_entered', '1');
                isSessionFirst = true;
            }
        } catch (e) { isSessionFirst = true; }

        let pageData = JSON.parse(localStorage.getItem('analytics_page_views') || '{"total":0,"today":0,"date":""}');
        if (pageData.date !== todayStr) {
            pageData.date = todayStr;
            pageData.today = 0;
        }
        pageData.total += 1;
        pageData.today += 1;
        localStorage.setItem('analytics_page_views', JSON.stringify(pageData));

        let dailyHistory = JSON.parse(localStorage.getItem('analytics_daily_history') || '{}');
        if (!dailyHistory[todayStr]) {
            dailyHistory[todayStr] = { date: todayStr, count: 0, uniqueCount: 0, referrers: {}, postViews: {}, searchKeywords: {} };
        }
        dailyHistory[todayStr].count += 1;
        if (isNewVisitor) {
            dailyHistory[todayStr].uniqueCount = (dailyHistory[todayStr].uniqueCount || 0) + 1;
        }

        const rawSource = getReferrerSource();
        // 새로고침이나 같은 세션 내 재접속(referrer 비어있음)을 '직접 접속'으로 중복 부풀리지 않고 '내부 이동'으로 처리
        const source = (rawSource === '직접 접속 / 카카오톡 링크' && !isSessionFirst) ? '내부 이동' : rawSource;
        if (source !== '내부 이동') {
            if (!dailyHistory[todayStr].referrers) dailyHistory[todayStr].referrers = {};
            dailyHistory[todayStr].referrers[source] = (dailyHistory[todayStr].referrers[source] || 0) + 1;

            let shortEngine = '';
            if (source.includes('네이버')) shortEngine = '네이버';
            else if (source.includes('구글')) shortEngine = '구글';
            else if (source.includes('다음')) shortEngine = '다음/카카오';
            else if (source.includes('ChatGPT')) shortEngine = 'AI 검색';

            if (shortEngine) {
                try {
                    sessionStorage.setItem('choi_search_inflow_engine', shortEngine);
                    sessionStorage.setItem('choi_search_inflow_landed', '0');
                } catch (e) {}
            }
        }

        const inflow = (source !== '내부 이동') ? extractExternalSearchInflow() : null;
        if (inflow && inflow.keyword) {
            if (!dailyHistory[todayStr].searchKeywords) dailyHistory[todayStr].searchKeywords = {};
            const kKey = `[${inflow.source}] ${inflow.keyword}`;
            dailyHistory[todayStr].searchKeywords[kKey] = (dailyHistory[todayStr].searchKeywords[kKey] || 0) + 1;
            recordSearchQuery(inflow.keyword, inflow.source);
        }

        const keys = Object.keys(dailyHistory).sort();
        if (keys.length > 30) {
            keys.slice(0, keys.length - 30).forEach(k => delete dailyHistory[k]);
        }
        localStorage.setItem('analytics_daily_history', JSON.stringify(dailyHistory));

        // Sync pageview to server for unified cross-device analytics
        fetch('/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'pageview',
                isNewVisitor,
                referrer: source,
                inflowKeyword: inflow ? inflow.keyword : '',
                inflowSource: inflow ? inflow.source : ''
            })
        }).catch(() => {});
    } catch(e){}
}

try {
    recordPageView();
} catch(e){}

function recordSearchQuery(query, source = '홈페이지 검색') {
    if (!query || typeof query !== 'string') return;
    const cleanQ = query.trim();
    if (cleanQ.length < 2) return;
    try {
        const todayStr = getKSTDateStr();
        const logs = JSON.parse(localStorage.getItem('analytics_search_logs') || '[]');
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const logObj = {
            query: cleanQ,
            source: source || '홈페이지 검색',
            device: isMobile ? 'mobile' : 'desktop',
            timestamp: Date.now(),
            date: new Date().toLocaleString('ko-KR'),
            dateKey: todayStr
        };
        logs.unshift(logObj);
        if (logs.length > 2000) logs.pop();
        localStorage.setItem('analytics_search_logs', JSON.stringify(logs));

        // Sync search log to server for real-time cross-device analytics
        fetch('/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logObj)
        }).catch(() => {});
    } catch(e){}
}

function recordPostView(postId, postTitle) {
    if (!postId) return;
    if (isAdminOrInternalAnalyticsContext()) return;
    try {
        const todayStr = getKSTDateStr();
        
        const views = JSON.parse(localStorage.getItem('analytics_post_views') || '{}');
        if (!views[postId]) {
            views[postId] = { id: postId, title: postTitle || '매물 상세', count: 0, lastViewed: Date.now() };
        }
        views[postId].count += 1;
        views[postId].lastViewed = Date.now();
        if (postTitle) views[postId].title = postTitle;
        localStorage.setItem('analytics_post_views', JSON.stringify(views));

        let dailyHistory = JSON.parse(localStorage.getItem('analytics_daily_history') || '{}');
        if (!dailyHistory[todayStr]) {
            dailyHistory[todayStr] = { date: todayStr, count: 0, referrers: {}, postViews: {}, searchKeywords: {} };
        }
        if (!dailyHistory[todayStr].postViews) dailyHistory[todayStr].postViews = {};
        
        dailyHistory[todayStr].postViews[postId] = (dailyHistory[todayStr].postViews[postId] || 0) + 1;

        const source = getReferrerSource();
        let inflowLandingEngine = '';
        if (source.includes('네이버')) inflowLandingEngine = '네이버';
        else if (source.includes('구글')) inflowLandingEngine = '구글';
        else if (source.includes('다음')) inflowLandingEngine = '다음/카카오';
        else if (source.includes('ChatGPT')) inflowLandingEngine = 'AI 검색';

        if (!inflowLandingEngine) {
            try {
                const sessEng = sessionStorage.getItem('choi_search_inflow_engine') || '';
                const sessLanded = sessionStorage.getItem('choi_search_inflow_landed') || '0';
                if (sessEng && sessLanded === '0') {
                    inflowLandingEngine = sessEng;
                }
            } catch (e) {}
        }

        if (inflowLandingEngine) {
            try {
                sessionStorage.setItem('choi_search_inflow_landed', '1');
            } catch (e) {}
            if (!dailyHistory[todayStr].inflowLandings) dailyHistory[todayStr].inflowLandings = {};
            const lKey = `${inflowLandingEngine}||${postId}`;
            dailyHistory[todayStr].inflowLandings[lKey] = (dailyHistory[todayStr].inflowLandings[lKey] || 0) + 1;
        }

        const inflow = (source !== '내부 이동' && postTitle) ? extractExternalSearchInflow() : null;
        if (inflow && inflow.keyword) {
            if (!dailyHistory[todayStr].searchKeywords) dailyHistory[todayStr].searchKeywords = {};
            const kKey = `[${inflow.source}] ${inflow.keyword}`;
            dailyHistory[todayStr].searchKeywords[kKey] = (dailyHistory[todayStr].searchKeywords[kKey] || 0) + 1;
        }

        localStorage.setItem('analytics_daily_history', JSON.stringify(dailyHistory));

        // Sync postview to server for unified cross-device analytics
        fetch('/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'postview',
                postId,
                postTitle,
                inflowLandingEngine,
                inflowKeyword: inflow ? inflow.keyword : '',
                inflowSource: inflow ? inflow.source : ''
            })
        }).catch(() => {});
    } catch(e){}
}

function getAnalyticsSummary(remoteData = null) {
    try {
        const searchLogs = JSON.parse(localStorage.getItem('analytics_search_logs') || '[]');
        const postViews = JSON.parse(localStorage.getItem('analytics_post_views') || '{}');
        
        let pageData = JSON.parse(localStorage.getItem('analytics_page_views') || '{"total":0,"today":0,"date":""}');
        let dailyHistory = JSON.parse(localStorage.getItem('analytics_daily_history') || '{}');

        if (remoteData && typeof remoteData === 'object') {
            if (remoteData.todayDate) {
                pageData.date = remoteData.todayDate;
                pageData.today = remoteData.todayPageviews || 0;
            }
            if (remoteData.totalPageviews) {
                pageData.total = remoteData.totalPageviews;
            }
            if (remoteData.dailyHistory && typeof remoteData.dailyHistory === 'object') {
                dailyHistory = remoteData.dailyHistory;
            }
        }

        const todayStr = getKSTDateStr();
        if (pageData.date !== todayStr) {
            pageData.date = todayStr;
            pageData.today = (remoteData && remoteData.todayDate === todayStr) ? (remoteData.todayPageviews || 0) : 0;
        }

        const datesList = [];
        for (let i = 6; i >= 0; i--) {
            const ds = getKSTDateStr(-i);
            const entry = dailyHistory[ds] || { date: ds, count: 0, referrers: {}, postViews: {} };
            if (ds === todayStr) {
                entry.count = Math.max(entry.count || 0, pageData.today || 0);
            }
            datesList.push({
                date: ds.slice(5),
                fullDate: ds,
                count: entry.count || 0,
                uniqueCount: entry.uniqueCount || 0,
                referrers: entry.referrers || {},
                postViews: entry.postViews || {}
            });
        }

        // Helper: Format referrer list for a given referrers map (Strictly actual external/first-entry inflows; NEVER inflate with internal page clicks!)
        const calcReferrers = (refMap) => {
            const mapCopy = {};
            let currentSum = 0;
            if (refMap && typeof refMap === 'object') {
                Object.entries(refMap).forEach(([src, count]) => {
                    const c = count || 0;
                    if (c <= 0) return;
                    if (src === '내부 이동' || src.includes('vercel.app') || src.includes('choi114.com') || src.includes('localhost') || src.includes('127.0.0.1')) {
                        return;
                    }
                    let cleanSrc = src;
                    if (cleanSrc.includes('chatgpt.com')) cleanSrc = 'ChatGPT (AI 추천 검색)';
                    mapCopy[cleanSrc] = (mapCopy[cleanSrc] || 0) + c;
                    currentSum += c;
                });
            }

            return Object.entries(mapCopy)
                .filter(([_, count]) => count > 0)
                .map(([source, count]) => ({
                    source,
                    count,
                    pct: currentSum > 0 ? Math.round((count / currentSum) * 100) : 0
                }))
                .sort((a, b) => b.count - a.count);
        };

        // Calculate total 7 days visits
        let total7DaysVisits = 0;
        datesList.forEach(d => { total7DaysVisits += (d.count || 0); });

        // Calculate all time total visits
        let totalAllVisits = pageData.total || 0;
        Object.values(dailyHistory).forEach(day => {
            totalAllVisits = Math.max(totalAllVisits, day.count || 0);
        });

        // All Referrers
        const allRefMap = {};
        let allVisitsSum = 0;
        Object.values(dailyHistory).forEach(day => {
            allVisitsSum += (day.count || 0);
            if (day.referrers) {
                Object.entries(day.referrers).forEach(([src, count]) => {
                    allRefMap[src] = (allRefMap[src] || 0) + count;
                });
            }
        });
        const topReferrersAll = calcReferrers(allRefMap, Math.max(pageData.total || 0, allVisitsSum));

        // 1) Helper to format topViews from a given postViews map
        const calcTopViews = (pvMap) => {
            if (!pvMap || typeof pvMap !== 'object') return [];
            return Object.entries(pvMap)
                .map(([id, count]) => ({
                    id,
                    title: postViews[id] ? postViews[id].title : '매물 상세',
                    count: count || 0
                }))
                .filter(item => item.count > 0)
                .sort((a, b) => b.count - a.count)
                .slice(0, 10);
        };

        const yesterdayStr = getKSTDateStr(-1);
        const day2Str = getKSTDateStr(-2);

        // 2) Today Referrers & Top Views
        const todayEntry = dailyHistory[todayStr] || { count: pageData.today || 0, referrers: {}, postViews: {} };
        const todayVisitCount = Math.max(pageData.today || 0, todayEntry.count || 0);
        const topReferrersToday = calcReferrers(todayEntry.referrers || {}, todayVisitCount);
        const todayTopViews = calcTopViews(todayEntry.postViews || {});

        // 3) Yesterday Referrers & Top Views
        const yesterdayEntry = dailyHistory[yesterdayStr] || { count: 0, referrers: {}, postViews: {} };
        const topReferrersYesterday = calcReferrers(yesterdayEntry.referrers || {}, yesterdayEntry.count || 0);
        const yesterdayTopViews = calcTopViews(yesterdayEntry.postViews || {});

        // 4) 3 Days (Recent 3 days: day2Str, yesterdayStr, todayStr) Referrers & Top Views
        const ref3Map = {};
        const pv3Map = {};
        let total3DaysVisits = 0;
        [day2Str, yesterdayStr, todayStr].forEach(ds => {
            const entry = dailyHistory[ds];
            if (entry) {
                total3DaysVisits += (entry.count || 0);
                if (entry.referrers) {
                    Object.entries(entry.referrers).forEach(([src, count]) => {
                        ref3Map[src] = (ref3Map[src] || 0) + count;
                    });
                }
                if (entry.postViews) {
                    Object.entries(entry.postViews).forEach(([id, count]) => {
                        pv3Map[id] = (pv3Map[id] || 0) + count;
                    });
                }
            }
        });
        const topReferrers3Days = calcReferrers(ref3Map, total3DaysVisits);
        const days3TopViews = calcTopViews(pv3Map);

        // 5) Recent 7 Days Referrers & Top Views
        const ref7Map = {};
        const pv7Map = {};
        datesList.forEach(d => {
            if (d.referrers) {
                Object.entries(d.referrers).forEach(([src, count]) => {
                    ref7Map[src] = (ref7Map[src] || 0) + count;
                });
            }
            if (d.postViews) {
                Object.entries(d.postViews).forEach(([id, count]) => {
                    pv7Map[id] = (pv7Map[id] || 0) + count;
                });
            }
        });
        const topReferrers7Days = calcReferrers(ref7Map, total7DaysVisits);
        const days7TopViews = calcTopViews(pv7Map);

        let mobileCount = 0;
        let desktopCount = 0;

        const getLogDateKey = (log) => {
            if (log && log.dateKey) return log.dateKey;
            if (log && log.timestamp) {
                try {
                    return new Date(Number(log.timestamp)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
                } catch (e) {
                    return new Date(Number(log.timestamp) + 9 * 3600 * 1000).toISOString().split('T')[0];
                }
            }
            return '';
        };

        searchLogs.forEach(log => {
            if (log.device === 'mobile') mobileCount++;
            else desktopCount++;
        });

        // Build Top 50 Search & Inflow Keywords for a given set of dates (null = all time)
        const calcTopQueriesByPeriod = (allowedDatesSet = null) => {
            const kwMap = {}; // key: "source||query" -> { query, source, count }

            const addKw = (rawQuery, rawSource, cnt = 1) => {
                if (!rawQuery || cnt <= 0) return;
                let q = String(rawQuery).trim();
                let src = String(rawSource || '홈페이지 검색').trim();
                const prefixMatch = q.match(/^\[([^\]]+)\]\s*(.+)$/);
                if (prefixMatch) {
                    src = prefixMatch[1].trim();
                    q = prefixMatch[2].trim();
                }
                if (q.length < 2) return;
                // Exclude property post titles that were previously inferred as search queries
                const wordCount = q.split(/\s+/).filter(Boolean).length;
                if (wordCount >= 5 && q.length >= 18) return;
                if (q.includes('최가네부동산') && q.length >= 15) return;
                const mapKey = `${src}||${q}`;
                if (!kwMap[mapKey]) {
                    kwMap[mapKey] = { query: q, source: src, count: 0 };
                }
                kwMap[mapKey].count += cnt;
            };

            // 1) Explicit searchLogs (from website search bar + real URL search parameters)
            searchLogs.forEach(log => {
                if (!log || !log.query) return;
                const dKey = getLogDateKey(log);
                if (allowedDatesSet && !allowedDatesSet.has(dKey)) return;
                addKw(log.query, log.source || '홈페이지 검색', 1);
            });

            return Object.values(kwMap)
                .filter(it => it.count > 0)
                .sort((a, b) => b.count - a.count)
                .slice(0, 50);
        };

        const dates7Set = new Set(datesList.map(d => d.fullDate));
        const dates3Set = new Set([day2Str, yesterdayStr, todayStr]);

        const topQueries = calcTopQueriesByPeriod(null);
        const topQueriesToday = calcTopQueriesByPeriod(new Set([todayStr]));
        const topQueriesYesterday = calcTopQueriesByPeriod(new Set([yesterdayStr]));
        const topQueries3Days = calcTopQueriesByPeriod(dates3Set);
        const topQueries7Days = calcTopQueriesByPeriod(dates7Set);

        // Build Top 50 Search Engine Inflow Landed Properties (네이버·구글 검색 유입 도착 매물 TOP 50)
        const calcInflowLandingsByPeriod = (allowedDatesSet = null) => {
            const landMap = {}; // key: "engine||postId" -> { id, propNo, title, engine, count }

            const resolvePropMeta = (pid) => {
                const pvInfo = postViews[pid];
                let rawTitle = (pvInfo && pvInfo.title && pvInfo.title !== '매물 상세') ? pvInfo.title : '';
                const cleanTitle = rawTitle
                    ? String(rawTitle).replace(/\s*[-|]\s*최가네부동산.*$/i, '').trim()
                    : `매물번호 ${pid} 상세페이지`;
                let propNo = '';
                const mNo = cleanTitle.match(/매물\s*번호\s*[:：]?\s*([0-9]{3,5})/i);
                if (mNo) propNo = mNo[1];
                else if (/^\d{3,5}$/.test(String(pid))) propNo = String(pid);
                else propNo = String(pid).slice(-4);
                return { cleanTitle, propNo, hasRealTitle: Boolean(rawTitle) };
            };

            const addLanding = (engine, pid, cnt = 1) => {
                if (!pid || cnt <= 0) return;
                const { cleanTitle, propNo } = resolvePropMeta(pid);
                const eng = engine || '네이버';
                const key = `${eng}||${pid}`;
                if (!landMap[key]) {
                    landMap[key] = {
                        id: String(pid),
                        propNo,
                        title: cleanTitle,
                        engine: eng,
                        count: 0
                    };
                }
                landMap[key].count += cnt;
            };

            Object.entries(dailyHistory).forEach(([ds, dayEntry]) => {
                if (!dayEntry) return;
                if (allowedDatesSet && !allowedDatesSet.has(ds)) return;

                const hasExplicitLandings = dayEntry.inflowLandings && typeof dayEntry.inflowLandings === 'object' && Object.keys(dayEntry.inflowLandings).length > 0;
                if (hasExplicitLandings) {
                    Object.entries(dayEntry.inflowLandings).forEach(([lKey, cnt]) => {
                        const parts = String(lKey).split('||');
                        if (parts.length >= 2) {
                            addLanding(parts[0], parts.slice(1).join('||'), cnt || 0);
                        }
                    });
                } else if (dayEntry.postViews && typeof dayEntry.postViews === 'object') {
                    // Fallback for historical days before inflowLandings field existed:
                    // if that day had Naver/Google/AI search inflows, attribute viewed properties to the search engine
                    const refs = dayEntry.referrers || {};
                    const naverCnt = (refs['네이버 (Naver)'] || 0);
                    const googleCnt = (refs['구글 (Google)'] || 0);
                    const aiCnt = (refs['ChatGPT (AI 추천 검색)'] || 0);
                    const daumCnt = (refs['다음/카카오 (Daum)'] || 0);
                    const totalSearchRef = naverCnt + googleCnt + aiCnt + daumCnt;

                    if (totalSearchRef > 0) {
                        let dominantEngine = '네이버';
                        if (googleCnt > naverCnt && googleCnt >= aiCnt) dominantEngine = '구글';
                        else if (aiCnt > naverCnt && aiCnt > googleCnt) dominantEngine = 'AI 검색';
                        else if (daumCnt > naverCnt && daumCnt > googleCnt) dominantEngine = '다음/카카오';

                        Object.entries(dayEntry.postViews).forEach(([pid, vCnt]) => {
                            addLanding(dominantEngine, pid, vCnt || 1);
                        });
                    }
                }
            });

            return Object.values(landMap)
                .filter(it => it.count > 0)
                .sort((a, b) => b.count - a.count)
                .slice(0, 50);
        };

        const inflowLandings = calcInflowLandingsByPeriod(null);
        const inflowLandingsToday = calcInflowLandingsByPeriod(new Set([todayStr]));
        const inflowLandingsYesterday = calcInflowLandingsByPeriod(new Set([yesterdayStr]));
        const inflowLandings3Days = calcInflowLandingsByPeriod(dates3Set);
        const inflowLandings7Days = calcInflowLandingsByPeriod(dates7Set);

        const topViews = Object.values(postViews)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        return {
            searchLogs,
            topQueries,
            topQueriesToday,
            topQueriesYesterday,
            topQueries3Days,
            topQueries7Days,
            inflowLandings,
            inflowLandingsToday,
            inflowLandingsYesterday,
            inflowLandings3Days,
            inflowLandings7Days,
            topViews,
            todayTopViews,
            yesterdayTopViews,
            days3TopViews,
            days7TopViews,
            todayDate: todayStr,
            yesterdayDate: yesterdayStr,
            day3Date: day2Str,
            recent7Days: datesList,
            topReferrers: topReferrersAll,
            topReferrersToday,
            topReferrersYesterday,
            topReferrers3Days,
            topReferrers7Days,
            dailyHistory,
            totalSearches: searchLogs.length,
            mobileCount,
            desktopCount,
            totalPageviews: Math.max(pageData.total || 0, allVisitsSum || 0),
            todayPageviews: todayVisitCount,
            todayUniqueVisitors: Math.max((remoteData && remoteData.todayDate === todayStr ? (remoteData.todayUniqueVisitors || 0) : 0), (todayEntry.uniqueCount || 0)),
            postViewsMap: postViews,
            likes: (remoteData && remoteData.likes) ? remoteData.likes : {},
            totalLikes: (remoteData && remoteData.totalLikes) ? remoteData.totalLikes : 0,
            recentLikes: (remoteData && remoteData.recentLikes) ? remoteData.recentLikes : []
        };
    } catch(e) {
        return { searchLogs: [], topQueries: [], topViews: [], todayTopViews: [], yesterdayTopViews: [], days3TopViews: [], days7TopViews: [], todayDate: '', yesterdayDate: '', day3Date: '', recent7Days: [], topReferrers: [], topReferrersToday: [], topReferrersYesterday: [], topReferrers3Days: [], topReferrers7Days: [], dailyHistory: {}, totalSearches: 0, mobileCount: 0, desktopCount: 0, totalPageviews: 0, todayPageviews: 0, postViewsMap: {} };
    }
}

function clearAnalyticsLogs() {
    localStorage.removeItem('analytics_search_logs');
    localStorage.removeItem('analytics_post_views');
    localStorage.removeItem('analytics_page_views');
    localStorage.removeItem('analytics_daily_history');
    fetch('/api/analytics', { method: 'DELETE' }).catch(() => {});
}

// Multi-Device Analytics Sync Helpers
async function syncAnalyticsWithRemote() {
    try {
        const config = await loadConfig();
        let remoteData = null;

        try {
            const res = await fetch('data/analytics.json?t=' + Date.now());
            if (res.ok) {
                remoteData = await res.json();
            }
        } catch(e) {}

        if (!remoteData) return;

        let localPageData = JSON.parse(localStorage.getItem('analytics_page_views') || '{"total":0,"today":0}');
        let localDaily = JSON.parse(localStorage.getItem('analytics_daily_history') || '{}');
        let localLogs = JSON.parse(localStorage.getItem('analytics_search_logs') || '[]');
        let localViews = JSON.parse(localStorage.getItem('analytics_post_views') || '{}');

        // Scrub any vercel or internal referrers from local storage
        if (localDaily && typeof localDaily === 'object') {
            Object.values(localDaily).forEach(day => {
                if (day && day.referrers) {
                    Object.keys(day.referrers).forEach(k => {
                        if (k === '내부 이동' || k.includes('vercel.app') || k.includes('choi114.com') || k.includes('localhost') || k.includes('127.0.0.1')) {
                            delete day.referrers[k];
                        }
                    });
                }
            });
        }

        localPageData.total = Math.max(localPageData.total || 0, remoteData.totalPageviews || 0);

        if (remoteData.dailyHistory) {
            Object.entries(remoteData.dailyHistory).forEach(([date, dayObj]) => {
                if (!localDaily[date]) {
                    localDaily[date] = JSON.parse(JSON.stringify(dayObj));
                    if (localDaily[date].referrers) {
                        Object.keys(localDaily[date].referrers).forEach(k => {
                            if (k === '내부 이동' || k.includes('vercel.app') || k.includes('choi114.com') || k.includes('localhost') || k.includes('127.0.0.1')) {
                                delete localDaily[date].referrers[k];
                            }
                        });
                    }
                } else {
                    localDaily[date].count = Math.max(localDaily[date].count || 0, dayObj.count || 0);
                    if (dayObj.referrers) {
                        if (!localDaily[date].referrers) localDaily[date].referrers = {};
                        Object.entries(dayObj.referrers).forEach(([src, cnt]) => {
                            if (src === '내부 이동' || src.includes('vercel.app') || src.includes('choi114.com') || src.includes('localhost') || src.includes('127.0.0.1')) return;
                            localDaily[date].referrers[src] = Math.max(localDaily[date].referrers[src] || 0, cnt);
                        });
                    }
                    if (dayObj.postViews) {
                        if (!localDaily[date].postViews) localDaily[date].postViews = {};
                        Object.entries(dayObj.postViews).forEach(([id, cnt]) => {
                            localDaily[date].postViews[id] = Math.max(localDaily[date].postViews[id] || 0, cnt);
                        });
                    }
                }
            });
        }

        if (Array.isArray(remoteData.searchLogs)) {
            const existingKeys = new Set(localLogs.map(l => (l.timestamp || 0) + '_' + l.query));
            remoteData.searchLogs.forEach(rl => {
                const key = (rl.timestamp || 0) + '_' + rl.query;
                if (!existingKeys.has(key)) {
                    localLogs.push(rl);
                    existingKeys.add(key);
                }
            });
            localLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        }

        if (remoteData.postViews) {
            Object.entries(remoteData.postViews).forEach(([id, pvObj]) => {
                if (!localViews[id]) {
                    localViews[id] = pvObj;
                } else {
                    localViews[id].count = Math.max(localViews[id].count || 0, pvObj.count || 0);
                    if (pvObj.title) localViews[id].title = pvObj.title;
                }
            });
        }

        localStorage.setItem('analytics_page_views', JSON.stringify(localPageData));
        localStorage.setItem('analytics_daily_history', JSON.stringify(localDaily));
        localStorage.setItem('analytics_search_logs', JSON.stringify(localLogs));
        localStorage.setItem('analytics_post_views', JSON.stringify(localViews));
        // NOTE: Never overwrite remote GitHub analytics.json from client localStorage!
        // All analytics writes (pageview, postview, like, inflowLandings) are handled atomically server-side via /api/analytics.
    } catch(e) {}
}

async function pushAnalyticsToGithub(config, analyticsObj) {
    try {
        const path = 'data/analytics.json';
        const url = `https://api.github.com/repos/${config.github_owner}/landing-page-assets/contents/${path}`;
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `token ${config.github_token}`
        };
        const getRes = await fetch(url, { headers });
        let sha = null;
        if (getRes.ok) {
            const data = await getRes.json();
            sha = data.sha;
        }

        const jsonStr = JSON.stringify(analyticsObj, null, 2);
        const utf8Bytes = new TextEncoder().encode(jsonStr);
        let binary = '';
        for (let i = 0; i < utf8Bytes.length; i++) {
            binary += String.fromCharCode(utf8Bytes[i]);
        }
        const contentBase64 = btoa(binary);

        const body = {
            message: 'stat: sync multi-device analytics data [skip ci] [skip vercel]',
            content: contentBase64
        };
        if (sha) body.sha = sha;

        await fetch(url, {
            method: 'PUT',
            headers: {
                ...headers,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
    } catch(e) {}
}

// Trigger background sync
try { syncAnalyticsWithRemote(); } catch(e) {}

window.recordPageView = recordPageView;
window.recordSearchQuery = recordSearchQuery;
window.recordPostView = recordPostView;
window.getAnalyticsSummary = getAnalyticsSummary;
window.clearAnalyticsLogs = clearAnalyticsLogs;
window.syncAnalyticsWithRemote = syncAnalyticsWithRemote;

window.loadConfig = loadConfig;
window.isAdmin = isAdmin;
window.requireAdmin = requireAdmin;
window.getPosts = getPosts;
window.savePost = savePost;
window.deletePost = deletePost;
window.renderMarkdown = renderMarkdown;
window.markdownToText = markdownToText;
window.uploadImageFile = uploadImageFile;
window.uploadVideoFile = uploadVideoFile;


// =============================================================
// NEW FEATURES: Calculator, Lead Form, Mobile Bottom Bar
// =============================================================

function showFeeCalculator() {}
function closeFeeCalculator() {
    const modal = document.getElementById('fee-calculator-modal');
    if (modal) modal.classList.add('hidden');
}

function switchCalcTab(idx) {
    for (let i = 1; i <= 3; i++) {
        const btn = document.getElementById('calc-tab-' + i);
        const panel = document.getElementById('calc-panel-' + i);
        if (i === idx) {
            btn.className = 'flex-1 py-3 border-b-2 border-[#003891] text-[#003891] dark:text-blue-400 font-bold';
            panel.classList.remove('hidden');
        } else {
            btn.className = 'flex-1 py-3 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200';
            panel.classList.add('hidden');
        }
    }
}

function runFeeCalc() {
    const type = document.getElementById('calc-trade-type').value;
    const depGrp = document.getElementById('calc-deposit-group');
    const rentGrp = document.getElementById('calc-rent-group');
    const priceGrp = document.getElementById('calc-price-group');

    if (type === 'sale') {
        depGrp.classList.add('hidden');
        rentGrp.classList.add('hidden');
        priceGrp.classList.remove('hidden');

        const price = parseFloat(document.getElementById('calc-price').value) || 0;
        const fee = price * 10000 * 0.009;
        document.getElementById('res-calc-trade-val').textContent = price.toLocaleString() + ' 만원';
        document.getElementById('res-calc-fee').textContent = Math.round(fee).toLocaleString() + ' 원 (VAT별도)';
    } else {
        depGrp.classList.remove('hidden');
        rentGrp.classList.remove('hidden');
        priceGrp.classList.add('hidden');

        const dep = parseFloat(document.getElementById('calc-deposit').value) || 0;
        const rent = parseFloat(document.getElementById('calc-rent').value) || 0;

        let tradeVal = dep + (rent * 100);
        if (tradeVal < 5000 && rent > 0) {
            tradeVal = dep + (rent * 70);
        }
        const fee = tradeVal * 10000 * 0.009;

        document.getElementById('res-calc-trade-val').textContent = Math.round(tradeVal).toLocaleString() + ' 만원';
        document.getElementById('res-calc-fee').textContent = Math.round(fee).toLocaleString() + ' 원 (VAT별도)';
    }
}

function runPyeongCalc() {
    const pyeong = parseFloat(document.getElementById('calc-pyeong').value) || 0;
    const rent = parseFloat(document.getElementById('calc-pyeong-rent').value) || 0;
    if (pyeong > 0 && rent > 0) {
        const perPyeong = (rent / pyeong).toFixed(1);
        document.getElementById('res-pyeong-rent').textContent = `평당 ${perPyeong} 만원`;
    } else {
        document.getElementById('res-pyeong-rent').textContent = '0 만원 / 평';
    }
}

function runConvCalc() {
    const dep = parseFloat(document.getElementById('calc-conv-deposit').value) || 0;
    const rate = parseFloat(document.getElementById('calc-conv-rate').value) || 6.0;
    if (dep > 0 && rate > 0) {
        const rentDelta = Math.round((dep * (rate / 100)) / 12);
        document.getElementById('res-conv-rent').textContent = `월 약 ${rentDelta} 만원 변동`;
    } else {
        document.getElementById('res-conv-rent').textContent = '월 0 만원 변동';
    }
}

function showLeadForm(type = 'buyer') {
    let modal = document.getElementById('client-lead-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'client-lead-modal';
        modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center p-2 sm:p-4 bg-black/70 backdrop-blur-sm animate-fadeIn';
        modal.innerHTML = `
        <div class="bg-white dark:bg-[#0d1b3e] text-slate-800 dark:text-slate-100 w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col max-h-[96vh]">
            <div class="bg-[#003891] text-white px-4 py-2.5 sm:px-5 sm:py-3 flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-amber-400 text-[20px]">edit_note</span>
                    <h3 class="text-base sm:text-lg font-extrabold">30초 간편 매물 의뢰 / 내놓기</h3>
                </div>
                <button onclick="closeLeadForm()" class="text-white/80 hover:text-white text-xl font-bold px-1 cursor-pointer">&times;</button>
            </div>

            <div class="flex border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#07102b] text-xs sm:text-sm font-medium">
                <button id="lead-tab-buyer" type="button" onclick="switchLeadTab('buyer')" class="flex-1 py-2 border-b-2 border-[#003891] text-[#003891] dark:text-blue-400 font-bold cursor-pointer text-xs sm:text-sm">🔍 매물 구하기 (손님/매수인)</button>
                <button id="lead-tab-seller" type="button" onclick="switchLeadTab('seller')" class="flex-1 py-2 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer text-xs sm:text-sm">🏢 매물 내놓기 (건물주/임차인)</button>
            </div>

            <form id="lead-submit-form" onsubmit="submitClientLead(event)" class="p-3 sm:p-4 overflow-y-auto space-y-2 text-xs sm:text-sm">
                <input type="hidden" id="lead-type" value="buyer">
                <div class="grid grid-cols-2 gap-2 sm:gap-3">
                    <div>
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200">성함 / 상호 <span class="text-red-500">*</span></label>
                        <input type="text" id="lead-name" required placeholder="예: 홍길동 (최가네치과)" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                    </div>
                    <div>
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200">연락처 <span class="text-red-500">*</span></label>
                        <input type="tel" id="lead-phone" required placeholder="010-0000-0000" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-2 sm:gap-3">
                    <div>
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200" id="lead-category-label">매물 종류</label>
                        <select id="lead-category" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                            <option value="상가">상가</option>
                            <option value="건물">건물</option>
                            <option value="사무실">사무실</option>
                            <option value="공장">공장</option>
                            <option value="창고">창고</option>
                            <option value="토지">토지</option>
                        </select>
                    </div>
                    <div id="lead-industry-container">
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200" id="lead-industry-label">희망 업종</label>
                        <input type="text" id="lead-industry" placeholder="예: 학원, 병의원, 식당 등" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                    </div>
                </div>
                <div>
                    <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200" id="lead-location-label">희망 지역 / 희망 위치</label>
                    <input type="text" id="lead-location" placeholder="예: 수성구 범어동 또는 달구벌대로변" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                </div>
                <div>
                    <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200" id="lead-floor-label">희망 층수 (중복 선택 가능)</label>
                    <div class="grid grid-cols-4 gap-1.5 bg-slate-50 dark:bg-[#142654] p-1.5 sm:p-2 rounded-lg border border-slate-300 dark:border-slate-600 text-xs sm:text-sm font-semibold">
                        <label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" name="lead-floor" value="전체층" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer" onchange="handleFloorClick(this)">
                            <span>전체층</span>
                        </label>
                        <label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" name="lead-floor" value="1층" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer" onchange="handleFloorClick(this)">
                            <span>1층</span>
                        </label>
                        <label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" name="lead-floor" value="지상층(1층제외)" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer" onchange="handleFloorClick(this)">
                            <span>지상층</span>
                        </label>
                        <label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" name="lead-floor" value="지하층" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer" onchange="handleFloorClick(this)">
                            <span>지하층</span>
                        </label>
                    </div>
                </div>
                <div class="grid grid-cols-5 gap-2 sm:gap-3">
                    <div class="col-span-2">
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200 whitespace-nowrap" id="lead-pyeong-label">희망 평수</label>
                        <input type="text" id="lead-pyeong" placeholder="예: 50평대" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                    </div>
                    <div class="col-span-3">
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200 whitespace-nowrap" id="lead-budget-label">예산 / 임대조건 / 매매조건</label>
                        <input type="text" id="lead-budget" placeholder="예: 보증금 5천/월 300 / 매매 15억" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                    </div>
                </div>
                <div>
                    <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200">세부 요청사항</label>
                    <textarea id="lead-notes" rows="1" placeholder="기타 원하시는 조건을 편하게 남겨주세요." class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]"></textarea>
                </div>

                <div class="bg-slate-50 dark:bg-slate-800/80 p-2 sm:p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium space-y-1">
                    <div class="flex items-center gap-1.5">
                        <input type="checkbox" id="lead-privacy-agree" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer" checked>
                        <label for="lead-privacy-agree" class="font-bold text-slate-800 dark:text-slate-200 cursor-pointer leading-tight text-xs sm:text-sm">
                            개인정보 수집 및 이용 동의 <span class="text-red-500">(필수)</span>
                        </label>
                        <button type="button" onclick="openPrivacyModal()" class="text-blue-600 dark:text-blue-400 underline font-semibold text-xs ml-auto cursor-pointer">전문보기</button>
                    </div>
                </div>

                <div class="pt-1 sm:pt-2">
                    <button type="submit" class="w-full py-2.5 sm:py-3 bg-[#003891] hover:bg-blue-800 text-white rounded-xl font-extrabold text-sm sm:text-base shadow-md transition flex items-center justify-center gap-1.5 cursor-pointer">
                        <span class="material-symbols-outlined text-[20px]">send</span> 신속 매물 접수하기
                    </button>
                </div>
            </form>
        </div>`;
        document.body.appendChild(modal);
    }
    switchLeadTab(type);
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

function closeLeadForm() {
    const modal = document.getElementById('client-lead-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

function handleFloorClick(chk) {
    if (chk.value === '전체층' && chk.checked) {
        document.querySelectorAll('input[name="lead-floor"]').forEach(c => {
            if (c.value !== '전체층') c.checked = false;
        });
    } else if (chk.value !== '전체층' && chk.checked) {
        const allChk = document.querySelector('input[name="lead-floor"][value="전체층"]');
        if (allChk) allChk.checked = false;
    }
}

function switchLeadTab(type) {
    const hiddenInput = document.getElementById('lead-type');
    const tabBuyer = document.getElementById('lead-tab-buyer');
    const tabSeller = document.getElementById('lead-tab-seller');
    const catLabel = document.getElementById('lead-category-label');
    const indContainer = document.getElementById('lead-industry-container');
    const locLabel = document.getElementById('lead-location-label');
    const floorLabel = document.getElementById('lead-floor-label');
    const pyeongLabel = document.getElementById('lead-pyeong-label');
    const budgetLabel = document.getElementById('lead-budget-label');

    if (type === 'seller') {
        hiddenInput.value = 'seller';
        tabSeller.className = 'flex-1 py-2 sm:py-2.5 border-b-2 border-[#003891] text-[#003891] dark:text-blue-400 font-bold cursor-pointer';
        tabBuyer.className = 'flex-1 py-2 sm:py-2.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer';
        if (catLabel) catLabel.textContent = '매물 종류';
        if (indContainer) indContainer.style.display = 'none';
        if (locLabel) locLabel.textContent = '매물 소재지 (건물 주소)';
        if (floorLabel) floorLabel.textContent = '층수 (중복 선택 가능)';
        if (pyeongLabel) pyeongLabel.textContent = '평수';
        if (budgetLabel) budgetLabel.textContent = '임대·매매조건 / 권리금 등';
        const sBudgetInput = document.getElementById('lead-budget');
        if (sBudgetInput && !sBudgetInput.value) sBudgetInput.placeholder = '예: 보증금 1억/월 500 / 매매 25억';
    } else {
        hiddenInput.value = 'buyer';
        tabBuyer.className = 'flex-1 py-2 sm:py-2.5 border-b-2 border-[#003891] text-[#003891] dark:text-blue-400 font-bold cursor-pointer';
        tabSeller.className = 'flex-1 py-2 sm:py-2.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer';
        if (catLabel) catLabel.textContent = '매물 종류';
        if (indContainer) indContainer.style.display = 'block';
        if (locLabel) locLabel.textContent = '희망 지역 / 희망 위치';
        if (floorLabel) floorLabel.textContent = '희망 층수 (중복 선택 가능)';
        if (pyeongLabel) pyeongLabel.textContent = '희망 평수';
        if (budgetLabel) budgetLabel.textContent = '예산 / 임대조건 / 매매조건';
        const bBudgetInput = document.getElementById('lead-budget');
        if (bBudgetInput && !bBudgetInput.value) bBudgetInput.placeholder = '예: 보증금 5천/월 300 / 매매 15억';
    }
}

async function submitClientLead(e) {
    e.preventDefault();
    const type = document.getElementById('lead-type').value;
    const name = document.getElementById('lead-name').value.trim();
    const phone = document.getElementById('lead-phone').value.trim();
    const category = document.getElementById('lead-category').value;
    const industryInput = document.getElementById('lead-industry');
    const industry = (industryInput && type === 'buyer') ? industryInput.value.trim() : '';
    const categoryDisplay = industry ? `${category} (희망업종: ${industry})` : category;

    const location = document.getElementById('lead-location').value.trim();
    
    const selectedFloors = Array.from(document.querySelectorAll('input[name="lead-floor"]:checked')).map(c => c.value);
    const floor = selectedFloors.length > 0 ? selectedFloors.join(', ') : '전체층';

    const pyeong = document.getElementById('lead-pyeong').value.trim();
    const budget = document.getElementById('lead-budget').value.trim();
    const notes = document.getElementById('lead-notes').value.trim();

    const agreeCheck = document.getElementById('lead-privacy-agree');
    if (agreeCheck && !agreeCheck.checked) {
        alert('개인정보 수집 및 이용에 동의해 주세요.');
        agreeCheck.focus();
        return;
    }

    if (!name || !phone) return;

    const leadObj = {
        id: Date.now(),
        type,
        name,
        phone,
        category: categoryDisplay,
        industry,
        location,
        floor,
        pyeong,
        budget,
        notes,
        date: new Date().toLocaleString('ko-KR')
    };

    try {
        const leads = JSON.parse(localStorage.getItem('analytics_client_leads') || '[]');
        leads.unshift(leadObj);
        localStorage.setItem('analytics_client_leads', JSON.stringify(leads));

        const leadTypeStr = type === 'seller' ? '🏢 [건물주/임차인] 매물내놓기' : '🔍 [손님] 매물구함';
        const emailSubject = `🔔 [최가네부동산] 새 ${type === 'seller' ? '매물내놓기' : '매물구함'} 접수! (${name}님)`;

        // 1. Direct FormSubmit Email dispatch to cym10003@naver.com
        fetch('https://formsubmit.co/ajax/cym10003@naver.com', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                "_subject": emailSubject,
                "의뢰구분": leadTypeStr,
                "성함_상호": name,
                "연락처": phone,
                "매물종류_업종": categoryDisplay,
                "위치_층수_평수": `${location || '-'} (${floor || '전체층'}, ${pyeong || '-'})`,
                "예산_조건_권리금": budget || '-',
                "상담요청메모": notes || '-',
                "접수일시": leadObj.date,
                "_template": "table",
                "_captcha": "false"
            })
        }).catch(() => {});

        // 2. Vercel Backend Serverless Lead dispatch
        fetch('/api/submit-lead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(leadObj)
        }).catch(() => {});
    } catch(err) {}

    closeLeadForm();
    alert(`[접수 완료] ${name}님, 정상 접수되었습니다!\n대표소장 최이명(010 - 3548 - 4000)이 확인 후 신속하게 연락드리겠습니다.`);
}

function initMobileBottomBar() {
    // Disabled legacy injected navy bar: every public page already renders its own crisp native mobile bottom bar.
    // Keeping this function as a cleanup no-op prevents 2 colliding fixed bottom bars on mobile viewports.
    const existing = document.getElementById('mobile-bottom-bar');
    if (existing) existing.remove();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileBottomBar);
} else {
    initMobileBottomBar();
}

window.showFeeCalculator = showFeeCalculator;
window.closeFeeCalculator = closeFeeCalculator;
window.switchCalcTab = switchCalcTab;
window.runFeeCalc = runFeeCalc;
window.runPyeongCalc = runPyeongCalc;
window.runConvCalc = runConvCalc;
window.showLeadForm = showLeadForm;
window.closeLeadForm = closeLeadForm;
window.switchLeadTab = switchLeadTab;
window.handleFloorClick = handleFloorClick;
window.submitClientLead = submitClientLead;
function quickFilterKeyword(keyword) {
    if (window.location.pathname.includes('property-news.html')) {
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.value = keyword;
            const searchBtn = document.getElementById('search-button');
            if (searchBtn) searchBtn.click();
            else if (typeof filterPosts === 'function') filterPosts();
        }
    } else {
        window.location.href = `property-news.html?search=${encodeURIComponent(keyword)}&v=20260715_v233`;
    }
}
window.quickFilterKeyword = quickFilterKeyword;
window.initMobileBottomBar = initMobileBottomBar;

function openPrivacyModal() {
    let modal = document.getElementById('privacy-policy-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'privacy-policy-modal';
        modal.className = 'fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 transition-opacity duration-300';
        modal.innerHTML = `
        <div class="bg-white dark:bg-[#0b1739] text-slate-900 dark:text-slate-100 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-fade-in">
            <div class="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-slate-50 dark:bg-[#142654]">
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-blue-600 dark:text-blue-400">gavel</span>
                    <h3 class="text-base sm:text-lg font-bold">개인정보 처리방침</h3>
                </div>
                <button onclick="closePrivacyModal()" class="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg transition-colors cursor-pointer">
                    <span class="material-symbols-outlined text-2xl">close</span>
                </button>
            </div>
            <div class="p-5 sm:p-6 overflow-y-auto space-y-5 text-xs sm:text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                <div class="bg-blue-50 dark:bg-blue-950/40 p-3.5 rounded-xl border border-blue-100 dark:border-blue-900 text-blue-900 dark:text-blue-200 font-medium">
                    최가네부동산공인중개사사무소는 「개인정보 보호법」 제30조에 따라 정보주체의 개인정보를 보호하고 이와 관련한 고충을 신속하고 원활하게 처리할 수 있도록 하기 위하여 다음과 같이 개인정보 처리방침을 수립·공개합니다.
                </div>

                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 1. 개인정보의 수집 및 이용 목적
                    </h4>
                    <p>사무소는 다음의 목적을 위하여 최소한의 개인정보를 수집 및 처리합니다. 수집된 개인정보는 지정된 목적 이외의 용도로는 이용되지 않으며, 이용 목적이 변경되는 경우에는 법률에 따라 사전 동의를 받겠습니다.</p>
                    <ul class="list-disc pl-5 mt-1 space-y-0.5 text-slate-600 dark:text-slate-400">
                        <li><b>부동산 매물 상담 및 의뢰 접수</b>: 매물 내놓기/구하기 상담, 매물 현장 안내, 중개 계약 체결 및 계약 이행 관련 연락</li>
                        <li><b>서비스 개선 및 통계</b>: 웹사이트 서비스 이용 통계 분석 및 매물 정보 품질 향상</li>
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 2. 수집하는 개인정보 항목 및 수집 방법
                    </h4>
                    <ul class="list-disc pl-5 space-y-0.5 text-slate-600 dark:text-slate-400">
                        <li><b>직접 수집 항목</b>: 성명(상호명), 연락처(전화번호), 매물 종류, 희망 업종, 매물/희망 위치, 층수, 희망 평수, 예산/임대·매매조건, 세부 요청사항</li>
                        <li><b>자동 수집 항목</b>: 서비스 이용 기록, 접속 디바이스 유형(모바일/PC), 접속 시각, 검색 키워드 로그</li>
                        <li><b>수집 방법</b>: 홈페이지 온라인 매물 접수 폼, 전화 및 방문 상담</li>
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 3. 개인정보의 보유 및 이용 기간
                    </h4>
                    <p>원칙적으로 개인정보의 수집 및 이용 목적이 달성되면 해당 정보를 지체 없이 파기합니다. 단, 관계 법령의 규정에 의하여 보존할 필요가 있는 경우 다음과 같이 보존합니다.</p>
                    <ul class="list-disc pl-5 mt-1 space-y-0.5 text-slate-600 dark:text-slate-400">
                        <li><b>매물 의뢰 및 상담 내역</b>: 의뢰 처리 완료 후 <b>3년</b> (공인중개사법 및 상법 기준)</li>
                        <li><b>부동산 거래 계약 관련 기록</b>: <b>5년</b> (공인중개사법 제26조 시행령)</li>
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 4. 개인정보의 파기절차 및 파기방법
                    </h4>
                    <p>보유기간이 경과하거나 처리목적이 달성된 개인정보는 전자적 복구가 불가능한 기술적 방법을 사용하여 지체 없이 파기합니다.</p>
                </div>

                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 5. 정보주체의 권리·의무 및 행사방법
                    </h4>
                    <p>정보주체는 언제든지 본인의 개인정보 열람, 정정, 삭제, 처리정지 요구 등의 권리를 행사할 수 있으며, 사무소 대표전화(010 - 3548 - 4000)를 통해 요청 시 지체 없이 조치하겠습니다.</p>
                </div>

                <div class="bg-slate-100 dark:bg-slate-800 p-4 rounded-xl space-y-1 text-slate-700 dark:text-slate-300">
                    <h4 class="font-bold text-sm text-slate-900 dark:text-white mb-1">6. 개인정보 보호책임자 안내</h4>
                    <p>• <b>상호명</b>: 최가네부동산공인중개사사무소</p>
                    <p>• <b>대표소장</b>: 최이명 (공인중개사)</p>
                    <p>• <b>연락처</b>: 010 - 3548 - 4000 / 053-746-7114</p>
                    <p>• <b>소재지</b>: 대구광역시 수성구 수성동1가 72-3번지 (대구은행역 2번 출구)</p>
                    <p>• <b>이메일</b>: cym10003@gmail.com</p>
                    <p>• <b>등록번호</b>: 제27260-2024-00085호</p>
                </div>
            </div>
            <div class="p-4 bg-slate-50 dark:bg-[#142654] border-t border-slate-200 dark:border-slate-700 flex justify-end">
                <button onclick="closePrivacyModal()" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm shadow-md transition-colors cursor-pointer">
                    확인 및 닫기
                </button>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
}

function closePrivacyModal() {
    const modal = document.getElementById('privacy-policy-modal');
    if (modal) modal.classList.add('hidden');
}

window.openPrivacyModal = openPrivacyModal;
window.closePrivacyModal = closePrivacyModal;

function openTermsModal() {
    let modal = document.getElementById('terms-of-service-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'terms-of-service-modal';
        modal.className = 'fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 transition-opacity duration-300';
        modal.onclick = (e) => { if (e.target === modal) closeTermsModal(); };
        modal.innerHTML = `
        <div class="bg-white dark:bg-[#0b1739] text-slate-900 dark:text-slate-100 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden" style="word-break: keep-all;">
            <div class="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-slate-50 dark:bg-[#142654]">
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-blue-600 dark:text-blue-400">description</span>
                    <h3 class="text-base sm:text-lg font-bold">홈페이지 이용약관</h3>
                </div>
                <button type="button" onclick="closeTermsModal()" class="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1 rounded-lg transition-colors cursor-pointer">
                    <span class="material-symbols-outlined text-2xl">close</span>
                </button>
            </div>
            <div class="p-5 sm:p-6 overflow-y-auto space-y-5 text-xs sm:text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                <div class="bg-blue-50 dark:bg-blue-950/40 p-3.5 rounded-xl border border-blue-100 dark:border-blue-900 text-blue-900 dark:text-blue-200 font-medium">
                    본 약관은 최가네부동산공인중개사사무소(이하 "사무소")가 운영하는 웹사이트(choi114.com)에서 제공하는 상가·사무실·건물 매물 정보 및 상담 서비스의 이용 조건과 절차를 규정합니다.
                </div>
                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 제1조 (매물 정보의 성격 및 유의사항)
                    </h4>
                    <p>홈페이지에 게시된 모든 매물 정보(면적, 보증금, 월세, 관리비, 권리금, 입주 가능일 등)는 등록 시점을 기준으로 확인된 실매물 정보입니다. 다만 부동산 거래 특성상 실시간 계약 체결 또는 임대인 사정에 따라 조건이 변동될 수 있으므로, 최종 계약 전 반드시 담당 공인중개사의 최신 확인을 거치시기 바랍니다.</p>
                </div>
                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 제2조 (중개보수 및 법정 의무)
                    </h4>
                    <p>사무소의 부동산 중개보수는 「공인중개사법」 및 대구광역시 조례에서 정한 법정 상한 요율 범위 내에서 의뢰인과 상호 협의하여 결정하며, 계약 체결 시 중개대상물 확인·설명서를 성실히 교부합니다.</p>
                </div>
                <div>
                    <h4 class="font-bold text-sm sm:text-base text-slate-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                        <span class="w-1.5 h-4 bg-blue-600 rounded-full inline-block"></span> 제3조 (저작권 및 무단 전재 금지)
                    </h4>
                    <p>본 홈페이지에 게시된 매물 사진, 브리핑 리포트, 분석 문구 및 콘텐츠의 저작권은 사무소에 귀속됩니다. 사전 서면 동의 없이 상업적 목적으로 무단 복제·배포하거나 타 플랫폼에 재게시하는 행위를 금합니다.</p>
                </div>
                <div class="bg-slate-100 dark:bg-slate-800 p-4 rounded-xl space-y-1 text-slate-700 dark:text-slate-300">
                    <h4 class="font-bold text-sm text-slate-900 dark:text-white mb-1">중개사무소 정보</h4>
                    <p>• <b>상호명</b>: 최가네부동산공인중개사사무소 (대표 공인중개사 최이명)</p>
                    <p>• <b>개설등록번호</b>: 제27260-2024-00085호 | 매수신청대리인 등록번호: 12-25-21</p>
                    <p>• <b>소재지</b>: 대구광역시 수성구 수성동1가 72-3번지 (대구은행역 2번 출구)</p>
                    <p>• <b>문의전화</b>: 010-3548-4000 / 053-746-7114</p>
                </div>
            </div>
            <div class="p-4 bg-slate-50 dark:bg-[#142654] border-t border-slate-200 dark:border-slate-700 flex justify-end">
                <button type="button" onclick="closeTermsModal()" class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm shadow-md transition-colors cursor-pointer">
                    확인 및 닫기
                </button>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
}

function closeTermsModal() {
    const modal = document.getElementById('terms-of-service-modal');
    if (modal) modal.classList.add('hidden');
}

window.openTermsModal = openTermsModal;
window.closeTermsModal = closeTermsModal;



// =========================================================================
// 🌟 최가네부동산 관심 매물 찜(♥) & 최근 본 매물 & 플로팅 퀵바 시스템
// =========================================================================

const DB_FALLBACK_IMAGES = [
    "https://lh3.googleusercontent.com/aida-public/AB6AXuCkR-wQyhx_M0SJF0T5FH04XUIMeg6qiswo7SylZDzAmaNZvZNKh-wSI9vVX9PD3ylL4DgGtEcd9m-jU4fF9tHKVSy84-4kUI67OMbysZG-c-eZ-HNPMnu2O57NDO0AJxiPsGRrtHLH_CUoVJXqZF9XBhPBL4bFlBVSwxWLNpZySjR3UivnfVo-2scUE5413YQbsf2XE13SapJwBA4jwKU5GONGrtt6hTLhBS3CDMiaaNXF9Hn9317Qs6JQYBaTuvRjbvGd69nQyzw",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuB7T1E6cl0rIAlxbl18yLfhOQB4k3VKaWB3VtjbIYdLBUrTNQ4y0ON2qZUAzy-BhUUjXPaEppcFn_ufN6HtOAOv75HFW_AwcuuQPz2dEs7LFw7gyvcVwhbxZTYIdAHeiyoKWwNvPRkQg2acdcVJMhUJ5Ad2kp8h5-SpmtpVSySIdc2z-uYYgdn_WziLPNvWmLrDsR7FOQt2cLVbHHlRXuu3q1mET9_mIIY5pV1F5C3dyJcxGE4bJFlWWca1YKr-1LCUSqw3Bz3JAbA",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDSPLN1-SGjcEvbjw9WnBsD6clfPaz-0RsQBNAzLGqKPoDXhrQ-j0UVR2O0Hbx5oPlmkKnIEeZqm8f9gBjahcMmLU9PyBfCBRuwZ6oq62qhPdy2oCCCPIpquntvosL7d_wCt0lmwcFnp_btQnN54oJTlojjqKAuV5vktthcAcSWZr1jmMDyixvnSqlSYJTp_qMsNfopnzjYpJCGf-YbCbS5S0P3P6XMAh-cu7xuwPalCbdUnaJDjoEvXFpwhqKYuuLgb5WBFdxvCew",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuBX-myFJEALqPkFc0UZCHTJBXA6awz2lb1x7CsHBsodkyWcOb4dFyIrQ7miBRsZzkCQsts2rpJQTJ_N47oxy9pqCPTEfNXS3NHKCMkRR70oJMLmv9PL22NpqPbHRPIKlHi-Qs7QQ7TknYmky-L46atqcY8lpca7UO2sMXud3m1jVI3hdBWoATZ_cU4-lSpj9kMOE_jCyevOxw6lK_GnvTrhScMpybyiamp8f-e7gNBHU232V9aXqK1Kl8B_O1atEmar0FARd4PHHPI"
];

function handlePostImgError(el, postId) {
    if (!el) return;
    let step = parseInt(el.dataset.errorStep || '0', 10);
    el.dataset.errorStep = String(step + 1);

    const originalSrc = el.getAttribute('data-original-src') || el.src || '';
    if (!el.getAttribute('data-original-src')) {
        el.setAttribute('data-original-src', originalSrc);
    }

    if (step === 0) {
        if (originalSrc.includes('cdn.jsdelivr.net/gh/')) {
            el.src = originalSrc
                .replace('cdn.jsdelivr.net/gh/cym10003-cyber/landing-page-assets@main', 'raw.githubusercontent.com/cym10003-cyber/landing-page-assets/main')
                .replace('cdn.jsdelivr.net/gh/cym10003-cyber/landing-page@main', 'raw.githubusercontent.com/cym10003-cyber/landing-page/main');
            return;
        } else if (originalSrc.includes('raw.githubusercontent.com/')) {
            el.src = originalSrc
                .replace('raw.githubusercontent.com/cym10003-cyber/landing-page-assets/main', 'cdn.jsdelivr.net/gh/cym10003-cyber/landing-page-assets@main')
                .replace('raw.githubusercontent.com/cym10003-cyber/landing-page/main', 'cdn.jsdelivr.net/gh/cym10003-cyber/landing-page@main');
            return;
        }
    }

    if (step === 1 && originalSrc.includes('landing-page-assets')) {
        const m = originalSrc.match(/images\/[^?#]+/);
        if (m) {
            el.src = `https://fastly.jsdelivr.net/gh/cym10003-cyber/landing-page-assets@main/${m[0]}`;
            return;
        }
    }

    if (step === 2 && originalSrc.includes('landing-page-assets')) {
        const m = originalSrc.match(/images\/[^?#]+/);
        if (m) {
            el.src = `https://cdn.statically.io/gh/cym10003-cyber/landing-page-assets/main/${m[0]}`;
            return;
        }
    }

    el.removeAttribute('alt');
    el.removeAttribute('onerror');
    const key = String(postId || originalSrc || '1');
    const hash = key.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const fallbacks = (typeof DB_FALLBACK_IMAGES !== 'undefined' && Array.isArray(DB_FALLBACK_IMAGES) && DB_FALLBACK_IMAGES.length > 0)
        ? DB_FALLBACK_IMAGES
        : [
            "https://lh3.googleusercontent.com/aida-public/AB6AXuCkR-wQyhx_M0SJF0T5FH04XUIMeg6qiswo7SylZDzAmaNZvZNKh-wSI9vVX9PD3ylL4DgGtEcd9m-jU4fF9tHKVSy84-4kUI67OMbysZG-c-eZ-HNPMnu2O57NDO0AJxiPsGRrtHLH_CUoVJXqZF9XBhPBL4bFlBVSwxWLNpZySjR3UivnfVo-2scUE5413YQbsf2XE13SapJwBA4jwKU5GONGrtt6hTLhBS3CDMiaaNXF9Hn9317Qs6JQYBaTuvRjbvGd69nQyzw"
        ];
    el.src = fallbacks[hash % fallbacks.length];
}
window.handlePostImgError = handlePostImgError;

function extractPostImage(p) {
    if (!p) return DB_FALLBACK_IMAGES[0];
    if (p.image && typeof p.image === 'string' && p.image.startsWith('http') && !p.image.includes('hero.png')) {
        return p.image;
    }
    
    let fullPost = p;
    const pid = String(p.id || '');
    if (!fullPost.content && pid) {
        try {
            const cache = JSON.parse(localStorage.getItem('posts_cache') || '[]');
            const found = cache.find(item => String(item.id) === pid);
            if (found && found.content) fullPost = found;
        } catch(e) {}
    }
    if (!fullPost.content && typeof _cachedPosts !== 'undefined' && Array.isArray(_cachedPosts)) {
        const found = _cachedPosts.find(item => String(item.id) === pid);
        if (found && found.content) fullPost = found;
    }

    const content = fullPost.content || '';
    if (content) {
        const mMd = content.match(/!\[.*?\]\((.*?)\)/);
        if (mMd && mMd[1]) {
            let u = mMd[1].trim();
            if (u.includes('raw.githubusercontent.com')) {
                u = u.replace(/raw\.githubusercontent\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/main\//g, 'cdn.jsdelivr.net/gh/$1/$2@main/');
            }
            return u;
        }
        const mHtml = content.match(/<img[^>]+src=["'](.*?)["']/i);
        if (mHtml && mHtml[1]) {
            let u = mHtml[1].trim();
            if (u.includes('raw.githubusercontent.com')) {
                u = u.replace(/raw\.githubusercontent\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/main\//g, 'cdn.jsdelivr.net/gh/$1/$2@main/');
            }
            return u;
        }
    }

    const code = pid.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return DB_FALLBACK_IMAGES[code % DB_FALLBACK_IMAGES.length];
}
window.extractPostImage = extractPostImage;

function getPropertyDisplayNumber(p) {
    if (!p) return '';
    const fullText = ((p.title || '') + ' ' + (p.content || '')).normalize('NFC');
    const m = fullText.match(/매물\s*번호\s*[:：]?\s*([0-9]{3,5})/i);
    if (m) return m[1];
    const m2 = fullText.match(/(?:NO|No|no)\.?\s*([0-9]{3,5})/);
    if (m2) return m2[1];
    if (p.id && String(p.id).length >= 4) return String(p.id).slice(-4);
    return '';
}
window.getPropertyDisplayNumber = getPropertyDisplayNumber;

function getFavoritePosts() {
    try {
        return JSON.parse(localStorage.getItem('choi_favorite_posts') || '[]');
    } catch(e) {
        return [];
    }
}
window.getFavoritePosts = getFavoritePosts;

function isFavoritePost(id) {
    if (!id) return false;
    const favs = getFavoritePosts();
    return favs.some(item => String(item.id) === String(id));
}
window.isFavoritePost = isFavoritePost;

function getRecentlyViewedPosts() {
    try {
        return JSON.parse(localStorage.getItem('choi_recent_posts') || '[]');
    } catch(e) {
        return [];
    }
}
window.getRecentlyViewedPosts = getRecentlyViewedPosts;

function addRecentlyViewedPost(post) {
    if (!post || !post.id) return;
    try {
        let recents = getRecentlyViewedPosts();
        recents = recents.filter(item => String(item.id) !== String(post.id));
        const propNo = getPropertyDisplayNumber(post);
        const imgUrl = extractPostImage(post);
        recents.unshift({
            id: String(post.id),
            title: post.title || '매물 상세',
            category: post.category || '매물',
            image: imgUrl,
            propNumber: propNo,
            viewedAt: Date.now()
        });
        if (recents.length > 20) recents = recents.slice(0, 20);
        localStorage.setItem('choi_recent_posts', JSON.stringify(recents));
        updateQuickBarBadges();
    } catch(e) {}
}
window.addRecentlyViewedPost = addRecentlyViewedPost;

async function toggleFavoritePost(post) {
    if (!post || !post.id) return false;
    const pid = String(post.id);
    let favs = getFavoritePosts();
    const existingIdx = favs.findIndex(item => String(item.id) === pid);
    const isNowFav = existingIdx === -1;
    const propNo = getPropertyDisplayNumber(post);

    if (isNowFav) {
        const imgUrl = extractPostImage(post);
        favs.unshift({
            id: pid,
            title: post.title || '매물 상세',
            category: post.category || '매물',
            image: imgUrl,
            propNumber: propNo,
            addedAt: Date.now()
        });
        showToast(`❤️ [매물 ${propNo || pid}] 관심 매물로 등록되었습니다!`);
    } else {
        favs.splice(existingIdx, 1);
        showToast(`🤍 [매물 ${propNo || pid}] 관심 매물에서 제외되었습니다.`);
    }

    try {
        localStorage.setItem('choi_favorite_posts', JSON.stringify(favs));
    } catch(e) {}

    updateFavoriteUI(pid, isNowFav);
    updateQuickBarBadges();

    // Send analytics event in background
    try {
        const isMob = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        fetch('/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'like',
                postId: pid,
                action: isNowFav ? 'like' : 'unlike',
                propNumber: propNo,
                title: post.title || '',
                device: isMob ? 'mobile' : 'desktop'
            })
        }).catch(() => {});
    } catch(e) {}

    return isNowFav;
}
window.toggleFavoritePost = toggleFavoritePost;

function toggleFavoriteById(id) {
    if (!id) return;
    const pid = String(id);
    let post = null;
    if (typeof _cachedPosts !== 'undefined' && Array.isArray(_cachedPosts)) {
        post = _cachedPosts.find(p => String(p.id) === pid);
    }
    if (!post) {
        try {
            const cache = JSON.parse(localStorage.getItem('posts_cache') || '[]');
            post = cache.find(p => String(p.id) === pid);
        } catch(e) {}
    }
    if (!post && window._currentPost && String(window._currentPost.id) === pid) {
        post = window._currentPost;
    }
    if (!post) {
        post = { id: pid, title: '매물 상세' };
    }
    toggleFavoritePost(post);
}
window.toggleFavoriteById = toggleFavoriteById;

function updateFavoriteUI(pid, isFav) {
    const btns = document.querySelectorAll(`.fav-btn-${pid}`);
    btns.forEach(btn => {
        const icon = btn.querySelector('.material-symbols-outlined') || btn;
        if (isFav) {
            btn.classList.add('text-rose-500');
            btn.classList.remove('text-slate-400');
            if (icon.tagName === 'SPAN') {
                icon.innerText = 'favorite';
                icon.style.fontVariationSettings = "'FILL' 1";
                icon.style.color = '#f43f5e';
            }
        } else {
            btn.classList.remove('text-rose-500');
            btn.classList.add('text-slate-400');
            if (icon.tagName === 'SPAN') {
                icon.innerText = 'favorite';
                icon.style.fontVariationSettings = "'FILL' 0";
                icon.style.color = '';
            }
        }
        btn.classList.add('scale-125');
        setTimeout(() => btn.classList.remove('scale-125'), 200);
    });

    const detailFavBtn = document.getElementById('detail-fav-btn');
    if (detailFavBtn && window._currentDetailPostId && String(window._currentDetailPostId) === String(pid)) {
        const icon = document.getElementById('detail-fav-icon');
        const text = document.getElementById('detail-fav-text');
        if (isFav) {
            detailFavBtn.className = "inline-flex items-center justify-center gap-1.5 bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border-2 border-rose-400 dark:border-rose-600 px-3 py-2 rounded-xl font-black text-xs sm:text-sm shadow-sm transition-all h-9 whitespace-nowrap cursor-pointer active:scale-95";
            if (icon) { icon.innerText = 'favorite'; icon.style.fontVariationSettings = "'FILL' 1"; }
            if (text) text.innerText = '찜 완료 ♥';
        } else {
            detailFavBtn.className = "inline-flex items-center justify-center gap-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-600 hover:border-rose-300 hover:text-rose-600 px-3 py-2 rounded-xl font-bold text-xs sm:text-sm shadow-xs transition-all h-9 whitespace-nowrap cursor-pointer active:scale-95";
            if (icon) { icon.innerText = 'favorite'; icon.style.fontVariationSettings = "'FILL' 0"; }
            if (text) text.innerText = '관심 매물 찜';
        }
    }
}
window.updateFavoriteUI = updateFavoriteUI;

function updateQuickBarBadges() {
    const favCount = getFavoritePosts().length;
    const recCount = getRecentlyViewedPosts().length;
    
    const favBadge = document.getElementById('quickbar-fav-count');
    const recBadge = document.getElementById('quickbar-recent-count');
    if (favBadge) favBadge.innerText = favCount;
    if (recBadge) recBadge.innerText = recCount;

    const modalFavCount = document.getElementById('modal-fav-count');
    const modalRecCount = document.getElementById('modal-recent-count');
    if (modalFavCount) modalFavCount.innerText = favCount;
    if (modalRecCount) modalRecCount.innerText = recCount;
}
window.updateQuickBarBadges = updateQuickBarBadges;

function showToast(msg) {
    let toast = document.getElementById('choi-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'choi-toast';
        toast.className = 'fixed top-5 left-1/2 -translate-x-1/2 z-[99999] bg-slate-900/95 dark:bg-white text-white dark:text-slate-900 px-5 py-3 rounded-full shadow-2xl text-xs sm:text-sm font-bold flex items-center gap-2 transition-all duration-300 opacity-0 pointer-events-none transform -translate-y-4 backdrop-blur-md border border-white/20 dark:border-slate-800';
        document.body.appendChild(toast);
    }
    toast.innerHTML = msg;
    toast.classList.remove('opacity-0', '-translate-y-4', 'pointer-events-none');
    toast.classList.add('opacity-100', 'translate-y-0');
    clearTimeout(window._toastTimeout);
    window._toastTimeout = setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-y-0');
        toast.classList.add('opacity-0', '-translate-y-4', 'pointer-events-none');
    }, 2800);
}
window.showToast = showToast;

// --- Floating Quick Bar & Drawer Modal Injection ---
function initFloatingQuickBar() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes('admin') || path.includes('news-write')) return;
    if (document.getElementById('floating-quick-bar')) return;

    // 1. Floating Pill Widget Button (Cleared cleanly above mobile bottom bar, footer Agent Login, and Leaflet map attribution)
    const isMapPage = path.includes('/map') || path.endsWith('map.html');
    const bar = document.createElement('div');
    bar.id = 'floating-quick-bar';
    bar.className = isMapPage
        ? 'fixed bottom-[76px] right-3 md:bottom-11 md:right-4 z-40 flex items-center gap-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md px-3 py-2 rounded-full shadow-xl border border-slate-200 dark:border-slate-700 hover:scale-105 active:scale-95 transition-all cursor-pointer no-print select-none'
        : 'fixed bottom-[76px] right-3 md:bottom-6 md:right-6 z-40 flex items-center gap-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md px-3.5 py-2.5 rounded-full shadow-xl border border-slate-200 dark:border-slate-700 hover:scale-105 active:scale-95 transition-all cursor-pointer no-print select-none';
    bar.innerHTML = `
        <div onclick="openQuickBarModal('fav')" class="flex items-center gap-1.5 text-xs font-black text-rose-600 dark:text-rose-400 cursor-pointer" title="관심 찜 목록 보기">
            <span class="material-symbols-outlined text-[19px]" style="font-variation-settings: 'FILL' 1; color:#f43f5e;">favorite</span>
            <span>찜 <span id="quickbar-fav-count" class="bg-rose-500 text-white text-[10px] px-1.5 py-0.2 rounded-full font-black">0</span></span>
        </div>
        <div class="h-3.5 w-px bg-slate-200 dark:bg-slate-700"></div>
        <div onclick="openQuickBarModal('recent')" class="flex items-center gap-1 text-xs font-bold text-slate-700 dark:text-slate-300 cursor-pointer" title="최근 본 매물 보기">
            <span class="material-symbols-outlined text-[19px] text-slate-500">history</span>
            <span>최근 <span id="quickbar-recent-count" class="bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-[10px] px-1.5 py-0.2 rounded-full font-bold">0</span></span>
        </div>
    `;
    document.body.appendChild(bar);

    // 2. Quick Bar Modal Dialog (Bottom-sheet on mobile, Centered dialog on PC)
    const modal = document.createElement('div');
    modal.id = 'quickbar-modal';
    modal.className = 'fixed inset-0 bg-black/60 z-[9999] backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 transition-opacity duration-300 opacity-0 pointer-events-none no-print';
    modal.onclick = (e) => { if (e.target === modal) closeQuickBarModal(); };
    modal.innerHTML = `
        <div class="bg-white dark:bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl max-h-[85vh] sm:max-h-[80vh] flex flex-col shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-800 transform translate-y-8 sm:translate-y-0 transition-transform duration-300">
            <!-- Header -->
            <div class="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-850">
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-rose-500 text-[24px]" style="font-variation-settings: 'FILL' 1;">favorite</span>
                    <h3 class="font-extrabold text-base sm:text-lg text-slate-900 dark:text-white">관심 & 최근 본 매물</h3>
                </div>
                <button onclick="closeQuickBarModal()" class="w-8 h-8 rounded-full hover:bg-slate-200 dark:hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer">
                    <span class="material-symbols-outlined text-[20px]">close</span>
                </button>
            </div>

            <!-- Tabs -->
            <div class="grid grid-cols-2 border-b border-slate-200 dark:border-slate-800 text-xs sm:text-sm font-bold bg-slate-100 dark:bg-slate-900">
                <button id="modal-tab-fav-btn" onclick="switchQuickBarTab('fav')" class="py-3 px-2 flex items-center justify-center gap-1.5 border-b-2 border-rose-500 text-rose-600 dark:text-rose-400 bg-white dark:bg-slate-900 cursor-pointer transition-all">
                    <span class="material-symbols-outlined text-[17px]" style="font-variation-settings: 'FILL' 1;">favorite</span>
                    <span>관심 매물 (<span id="modal-fav-count">0</span>)</span>
                </button>
                <button id="modal-tab-recent-btn" onclick="switchQuickBarTab('recent')" class="py-3 px-2 flex items-center justify-center gap-1.5 border-b-2 border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer transition-all">
                    <span class="material-symbols-outlined text-[17px]">history</span>
                    <span>최근 본 매물 (<span id="modal-recent-count">0</span>)</span>
                </button>
            </div>

            <!-- Content Area -->
            <div class="flex-1 overflow-y-auto p-4 space-y-3 min-h-[220px]" id="quickbar-modal-content">
                <!-- Dynamically populated -->
            </div>

            <!-- Modal Action Footer (for Favorites) -->
            <div id="quickbar-fav-footer" class="p-3.5 sm:p-4 bg-slate-50 dark:bg-slate-850 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row gap-2">
                <button onclick="consultFavoritesKakao()" class="flex-1 py-3 px-3 rounded-xl bg-[#fee500] hover:bg-[#fdd835] text-[#191600] font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition-all cursor-pointer border border-[#d4be00]">
                    <span class="material-symbols-outlined text-[18px]">chat</span>
                    <span>선택한 매물 묶어서 카톡 문의하기</span>
                </button>
                <a href="tel:010-3548-4000" class="py-3 px-4 rounded-xl bg-[#003891] hover:bg-blue-800 text-white font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition-all no-underline">
                    <span class="material-symbols-outlined text-[18px] text-amber-300">call</span>
                    <span>전화 상담</span>
                </a>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    updateQuickBarBadges();
}

let _currentQuickBarTab = 'fav';

function openQuickBarModal(tab = 'fav') {
    const modal = document.getElementById('quickbar-modal');
    if (!modal) return;
    _currentQuickBarTab = tab;
    modal.classList.remove('opacity-0', 'pointer-events-none');
    modal.classList.add('opacity-100');
    const dialog = modal.querySelector('.transform');
    if (dialog) dialog.classList.remove('translate-y-8');
    switchQuickBarTab(tab);
}
window.openQuickBarModal = openQuickBarModal;

function closeQuickBarModal() {
    const modal = document.getElementById('quickbar-modal');
    if (!modal) return;
    modal.classList.add('opacity-0', 'pointer-events-none');
    modal.classList.remove('opacity-100');
    const dialog = modal.querySelector('.transform');
    if (dialog) dialog.classList.add('translate-y-8');
}
window.closeQuickBarModal = closeQuickBarModal;

function switchQuickBarTab(tab) {
    _currentQuickBarTab = tab;
    const favBtn = document.getElementById('modal-tab-fav-btn');
    const recBtn = document.getElementById('modal-tab-recent-btn');
    const footer = document.getElementById('quickbar-fav-footer');
    updateQuickBarBadges();

    if (tab === 'fav') {
        if (favBtn) {
            favBtn.className = "py-3 px-2 flex items-center justify-center gap-1.5 border-b-2 border-rose-500 text-rose-600 dark:text-rose-400 bg-white dark:bg-slate-900 cursor-pointer transition-all";
        }
        if (recBtn) {
            recBtn.className = "py-3 px-2 flex items-center justify-center gap-1.5 border-b-2 border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer transition-all";
        }
        if (footer) footer.classList.remove('hidden');
        renderQuickBarFavorites();
    } else {
        if (recBtn) {
            recBtn.className = "py-3 px-2 flex items-center justify-center gap-1.5 border-b-2 border-blue-600 text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-900 cursor-pointer transition-all";
        }
        if (favBtn) {
            favBtn.className = "py-3 px-2 flex items-center justify-center gap-1.5 border-b-2 border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer transition-all";
        }
        if (footer) footer.classList.add('hidden');
        renderQuickBarRecents();
    }
}
window.switchQuickBarTab = switchQuickBarTab;

function renderQuickBarFavorites() {
    const container = document.getElementById('quickbar-modal-content');
    const footer = document.getElementById('quickbar-fav-footer');
    if (footer) footer.classList.remove('hidden');
    if (!container) return;
    const favs = getFavoritePosts();

    if (!favs || favs.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 px-4 flex flex-col items-center justify-center gap-3">
                <div class="w-16 h-16 rounded-full bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-500">
                    <span class="material-symbols-outlined text-[32px]">favorite_border</span>
                </div>
                <h4 class="font-bold text-slate-800 dark:text-slate-200 text-base">아직 찜한 관심 매물이 없습니다</h4>
                <p class="text-xs text-slate-500 max-w-xs leading-relaxed">
                    매물 사진 우측 상단의 하트(♥)를 누르면 관심 매물에 쏙 담아 한 번에 비교 상담받으실 수 있습니다!
                </p>
                <a href="property-news.html?v=20260715_v233" onclick="closeQuickBarModal()" class="mt-2 px-5 py-2.5 rounded-xl bg-[#003891] text-white font-bold text-xs shadow-md no-underline hover:bg-blue-800 transition-all">
                    매물리스트 보러가기
                </a>
            </div>
        `;
        return;
    }

    // Auto-repair missing or broken images for existing stored favorites
    let needsSave = false;
    favs.forEach(item => {
        if (!item.image || item.image.includes('hero.png')) {
            item.image = extractPostImage(item);
            needsSave = true;
        }
    });
    if (needsSave) {
        try { localStorage.setItem('choi_favorite_posts', JSON.stringify(favs)); } catch(e) {}
    }

    container.innerHTML = `
        <div class="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-100 dark:border-slate-800">
            <label class="flex items-center gap-1.5 font-bold cursor-pointer text-slate-700 dark:text-slate-300">
                <input type="checkbox" id="fav-select-all" checked onchange="toggleAllFavCheckboxes(this.checked)" class="w-4 h-4 rounded text-rose-600 cursor-pointer">
                <span>전체 선택 (${favs.length}건)</span>
            </label>
            <button onclick="clearAllFavorites()" class="text-slate-400 hover:text-rose-500 transition-colors cursor-pointer text-[11px]">
                전체 비우기
            </button>
        </div>
        <div class="space-y-2.5">
            ${favs.map(item => `
                <div class="flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70 hover:border-rose-300 transition-all">
                    <input type="checkbox" name="fav-item-check" value="${item.id}" checked class="w-4 h-4 rounded text-rose-600 shrink-0 cursor-pointer">
                    <img src="${item.image}" alt="" class="w-16 h-16 rounded-xl object-cover shrink-0 bg-slate-100 border border-slate-200 dark:border-slate-700 shadow-xs" onerror="handlePostImgError(this, '${item.id}')" loading="lazy">
                    <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                        <div class="flex items-center gap-1.5">
                            <span class="text-[11px] font-black text-[#003891] dark:text-blue-300 bg-blue-50 dark:bg-blue-950 px-1.5 py-0.2 rounded border border-blue-200 dark:border-blue-800">
                                매물번호: ${item.propNumber || item.id}
                            </span>
                        </div>
                        <a href="news-detail.html?id=${item.id}" onclick="closeQuickBarModal()" class="font-bold text-xs sm:text-sm text-slate-900 dark:text-white hover:text-blue-600 truncate no-underline">
                            ${item.title}
                        </a>
                    </div>
                    <button type="button" onclick="removeFavoriteItem('${item.id}')" class="text-slate-400 hover:text-rose-500 p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0 cursor-pointer" title="삭제">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>
            `).join('')}
        </div>
    `;
}

function renderQuickBarRecents() {
    const container = document.getElementById('quickbar-modal-content');
    if (!container) return;
    const recents = getRecentlyViewedPosts();

    if (!recents || recents.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 px-4 flex flex-col items-center justify-center gap-3">
                <div class="w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center text-blue-600">
                    <span class="material-symbols-outlined text-[32px]">history</span>
                </div>
                <h4 class="font-bold text-slate-800 dark:text-slate-200 text-base">최근 둘러본 매물이 없습니다</h4>
                <p class="text-xs text-slate-500 max-w-xs leading-relaxed">
                    관심 있는 매물 상세페이지를 방문하시면 이곳에 자동으로 최근 본 목록이 기록됩니다!
                </p>
                <a href="property-news.html?v=20260715_v233" onclick="closeQuickBarModal()" class="mt-2 px-5 py-2.5 rounded-xl bg-[#003891] text-white font-bold text-xs shadow-md no-underline hover:bg-blue-800 transition-all">
                    매물리스트 보러가기
                </a>
            </div>
        `;
        return;
    }

    // Auto-repair missing or broken images for existing stored recents
    let needsSave = false;
    recents.forEach(item => {
        if (!item.image || item.image.includes('hero.png')) {
            item.image = extractPostImage(item);
            needsSave = true;
        }
    });
    if (needsSave) {
        try { localStorage.setItem('choi_recent_posts', JSON.stringify(recents)); } catch(e) {}
    }

    container.innerHTML = `
        <div class="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-100 dark:border-slate-800">
            <span class="font-bold text-slate-700 dark:text-slate-300">최근 둘러본 매물 (${recents.length}건)</span>
            <button onclick="clearAllRecents()" class="text-slate-400 hover:text-rose-500 transition-colors cursor-pointer text-[11px]">
                기록 삭제
            </button>
        </div>
        <div class="space-y-2.5">
            ${recents.map(item => {
                const isFav = isFavoritePost(item.id);
                return `
                    <div class="flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/70 hover:border-blue-300 transition-all">
                        <img src="${item.image}" alt="" class="w-16 h-16 rounded-xl object-cover shrink-0 bg-slate-100 border border-slate-200 dark:border-slate-700 shadow-xs" onerror="handlePostImgError(this, '${item.id}')" loading="lazy">
                        <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                            <span class="text-[11px] font-black text-[#003891] dark:text-blue-300 bg-blue-50 dark:bg-blue-950 px-1.5 py-0.2 rounded border border-blue-200 dark:border-blue-800 w-fit">
                                매물번호: ${item.propNumber || item.id}
                            </span>
                            <a href="news-detail.html?id=${item.id}" onclick="closeQuickBarModal()" class="font-bold text-xs sm:text-sm text-slate-900 dark:text-white hover:text-blue-600 truncate no-underline">
                                ${item.title}
                            </a>
                        </div>
                        <button type="button" onclick="toggleFavoriteById('${item.id}'); renderQuickBarRecents();" class="p-2 rounded-xl bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:scale-105 active:scale-95 transition-all shadow-xs shrink-0 cursor-pointer" title="${isFav ? '관심 매물 해제' : '관심 매물 등록'}">
                            <span class="material-symbols-outlined text-[19px] ${isFav ? 'text-rose-500' : 'text-slate-400'}" style="font-variation-settings: 'FILL' ${isFav ? 1 : 0};">favorite</span>
                        </button>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function toggleAllFavCheckboxes(checked) {
    const checkboxes = document.querySelectorAll('input[name="fav-item-check"]');
    checkboxes.forEach(cb => cb.checked = checked);
}
window.toggleAllFavCheckboxes = toggleAllFavCheckboxes;

function removeFavoriteItem(id) {
    toggleFavoriteById(id);
    renderQuickBarFavorites();
}
window.removeFavoriteItem = removeFavoriteItem;

function clearAllFavorites() {
    if (!confirm('관심 매물 목록을 모두 비우시겠습니까?')) return;
    localStorage.removeItem('choi_favorite_posts');
    updateQuickBarBadges();
    renderQuickBarFavorites();
    showToast('관심 매물 목록이 모두 비워졌습니다.');
}
window.clearAllFavorites = clearAllFavorites;

function clearAllRecents() {
    localStorage.removeItem('choi_recent_posts');
    updateQuickBarBadges();
    renderQuickBarRecents();
    showToast('최근 본 매물 기록이 삭제되었습니다.');
}
window.clearAllRecents = clearAllRecents;

let _lastKakaoMsg = '';

function consultFavoritesKakao() {
    const checkedBoxes = Array.from(document.querySelectorAll('input[name="fav-item-check"]:checked'));
    const favs = getFavoritePosts();
    const selected = favs.filter(item => checkedBoxes.some(cb => cb.value === String(item.id)));

    if (selected.length === 0) {
        alert('상담받으실 관심 매물을 1개 이상 선택해 주세요.');
        return;
    }

    let msg = `안녕하세요! 최가네부동산(choi114.com)에서 관심 매물을 보고 문의드립니다.\n\n[문의 관심 매물 ${selected.length}건]\n`;
    selected.forEach((item, idx) => {
        msg += `${idx + 1}. [매물번호: ${item.propNumber || item.id}] ${item.title}\n`;
    });
    msg += `\n위 매물들에 대해 비교 상담 및 방문 안내 부탁드립니다!`;

    _lastKakaoMsg = msg;

    // 1. Copy to clipboard immediately
    let copySuccess = false;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(msg);
            copySuccess = true;
        } else {
            const ta = document.createElement('textarea');
            ta.value = msg;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            copySuccess = document.execCommand('copy');
            document.body.removeChild(ta);
        }
    } catch(e) {}

    // 2. Open Kakao in new tab
    const kakaoUrl = 'https://open.kakao.com/o/smt2j0Ri';
    try {
        window.open(kakaoUrl, '_blank');
    } catch(e) {}

    // 3. Immediately switch modal to persistent, step-by-step guidance screen
    showKakaoCopyGuideView(selected, msg);
}
window.consultFavoritesKakao = consultFavoritesKakao;

function showKakaoCopyGuideView(selected, msg) {
    const container = document.getElementById('quickbar-modal-content');
    const footer = document.getElementById('quickbar-fav-footer');
    if (footer) footer.classList.add('hidden'); // hide default footer while guide is shown
    if (!container) return;

    // Escape HTML for safe preview
    const escapedMsg = msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    container.innerHTML = `
        <div class="py-1 px-1 flex flex-col gap-3">
            <!-- Large Attention Banner -->
            <div class="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/60 border-2 border-amber-400 dark:border-amber-600 shadow-sm flex items-start gap-3">
                <div class="w-11 h-11 rounded-2xl bg-[#fee500] text-[#191600] flex items-center justify-center shrink-0 shadow-xs border border-[#d4be00]">
                    <span class="material-symbols-outlined text-[26px]">content_copy</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 mb-1">
                        <span class="bg-[#fee500] text-[#191600] text-[10px] font-black px-2 py-0.5 rounded-full border border-[#d4be00]">복사 완료</span>
                        <span class="text-xs font-bold text-amber-900 dark:text-amber-200">매물 ${selected.length}건 묶음</span>
                    </div>
                    <h4 class="font-extrabold text-sm sm:text-base text-slate-900 dark:text-white leading-snug">
                        상담 내용이 복사되었습니다! 🎉
                    </h4>
                    <p class="text-xs text-slate-700 dark:text-slate-300 mt-1 leading-relaxed">
                        새로 열린 카카오톡 대화창에서 <b>[붙여넣기]</b>만 하시면 아래 내용이 전송됩니다.
                    </p>
                </div>
            </div>

            <!-- Visual 2-Step How-To Cards -->
            <div class="grid grid-cols-2 gap-2 text-xs">
                <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex flex-col gap-1 shadow-xs">
                    <span class="font-black text-[#003891] dark:text-blue-300 flex items-center gap-1">
                        <span class="material-symbols-outlined text-[16px]">desktop_windows</span> PC 이용 손님
                    </span>
                    <span class="text-slate-600 dark:text-slate-300 font-medium leading-tight">
                        카톡 대화창 클릭 후 키보드에서 <b>Ctrl + V</b> 누르기
                    </span>
                </div>
                <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex flex-col gap-1 shadow-xs">
                    <span class="font-black text-[#003891] dark:text-blue-300 flex items-center gap-1">
                        <span class="material-symbols-outlined text-[16px]">smartphone</span> 모바일 손님
                    </span>
                    <span class="text-slate-600 dark:text-slate-300 font-medium leading-tight">
                        채팅 입력창을 1초간 꾹 누른 뒤 <b>[붙여넣기]</b> 터치
                    </span>
                </div>
            </div>

            <!-- Copied Message Preview Box -->
            <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between text-xs">
                    <span class="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1">
                        <span class="material-symbols-outlined text-[15px] text-slate-500">assignment</span>
                        복사된 상담 문구 미리보기
                    </span>
                    <button type="button" onclick="recopyKakaoMessage()" class="text-xs font-bold text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5 cursor-pointer">
                        <span class="material-symbols-outlined text-[14px]">refresh</span> 내용 다시 복사
                    </button>
                </div>
                <div id="kakao-preview-box" class="p-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-mono leading-relaxed whitespace-pre-wrap select-all max-h-36 overflow-y-auto border border-slate-200 dark:border-slate-700">
${escapedMsg}
                </div>
            </div>

            <!-- Action Buttons -->
            <div class="flex flex-col gap-2 pt-1">
                <button type="button" onclick="openKakaoDirectly()" class="w-full py-3 px-3 rounded-xl bg-[#fee500] hover:bg-[#fdd835] text-[#191600] font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer border border-[#d4be00]">
                    <span class="material-symbols-outlined text-[18px]">chat</span>
                    <span>카카오톡 대화창 바로가기 (창 다시 열기)</span>
                </button>
                <div class="flex gap-2">
                    <button type="button" onclick="renderQuickBarFavorites()" class="flex-1 py-2.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold text-xs flex items-center justify-center gap-1 transition-all cursor-pointer">
                        <span class="material-symbols-outlined text-[15px]">arrow_back</span>
                        <span>목록으로 돌아가기</span>
                    </button>
                    <button type="button" onclick="closeQuickBarModal()" class="py-2.5 px-4 rounded-xl bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 font-bold text-xs transition-all cursor-pointer">
                        확인 및 닫기
                    </button>
                </div>
            </div>
        </div>
    `;
}
window.showKakaoCopyGuideView = showKakaoCopyGuideView;

function recopyKakaoMessage() {
    if (!_lastKakaoMsg) return;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(_lastKakaoMsg);
        } else {
            const ta = document.createElement('textarea');
            ta.value = _lastKakaoMsg;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        showToast('📋 상담 내용이 다시 복사되었습니다! 카톡에 붙여넣기하세요.');
    } catch(e) {}
}
window.recopyKakaoMessage = recopyKakaoMessage;

function openKakaoDirectly() {
    window.open('https://open.kakao.com/o/smt2j0Ri', '_blank');
}
window.openKakaoDirectly = openKakaoDirectly;

// Auto-initialize Quick Bar when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFloatingQuickBar);
} else {
    initFloatingQuickBar();
}

// =========================================================================
// 🗂️ 최가네부동산 『메모창고 & 손님 맞춤 브리핑 보드』 코어 엔진 (db.js)
// =========================================================================

function parseKoreanMoneyToManwon(rawStr) {
    if (!rawStr) return 0;
    const s = String(rawStr).replace(/,/g, '').trim();
    if (!s || s.includes('무권리') || s.includes('없음') || s.includes('해당없음')) return 0;

    let total = 0;
    const eokMatch = s.match(/(\d+(?:\.\d+)?)\s*억/);
    if (eokMatch) {
        total += parseFloat(eokMatch[1]) * 10000;
    }
    const afterEok = eokMatch ? s.slice(s.indexOf('억') + 1) : s;
    const cheonMatch = afterEok.match(/(\d+(?:\.\d+)?)\s*천/);
    if (cheonMatch) {
        total += parseFloat(cheonMatch[1]) * 1000;
    }
    const baekMatch = afterEok.match(/(\d+(?:\.\d+)?)\s*백/);
    if (baekMatch) {
        total += parseFloat(baekMatch[1]) * 100;
    }
    const manMatch = afterEok.match(/(\d+(?:\.\d+)?)\s*만/);
    if (manMatch && !cheonMatch && !baekMatch) {
        total += parseFloat(manMatch[1]);
    }
    if (total === 0) {
        const plainNum = s.match(/(\d+(?:\.\d+)?)/);
        if (plainNum) total = parseFloat(plainNum[1]);
    }
    return Math.round(total * 10) / 10;
}
window.parseKoreanMoneyToManwon = parseKoreanMoneyToManwon;

function extractAllPostImages(post, maxCount = 8) {
    if (!post) return [];
    const urls = [];
    const content = post.content || '';
    const mdRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = mdRegex.exec(content)) !== null) {
        let u = m[1].trim();
        if (u.includes('raw.githubusercontent.com')) {
            u = u.replace(/raw\.githubusercontent\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/main\//g, 'cdn.jsdelivr.net/gh/$1/$2@main/');
        }
        if (u && !urls.includes(u)) urls.push(u);
        if (urls.length >= maxCount) break;
    }
    if (urls.length < maxCount) {
        const htmlRegex = /<img[^>]+src=["']([^"']+)["']/gi;
        while ((m = htmlRegex.exec(content)) !== null) {
            let u = m[1].trim();
            if (u.includes('raw.githubusercontent.com')) {
                u = u.replace(/raw\.githubusercontent\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/main\//g, 'cdn.jsdelivr.net/gh/$1/$2@main/');
            }
            if (u && !urls.includes(u)) urls.push(u);
            if (urls.length >= maxCount) break;
        }
    }
    if (urls.length === 0) {
        urls.push(extractPostImage(post));
    }
    return urls;
}
window.extractAllPostImages = extractAllPostImages;

function normalizeBriefingBadgeLabel(raw) {
    if (!raw) return '';
    let s = String(raw).replace(/^[🚗🛗🚻🎁✨🔨⚡🛣️❄️🔥💧🏢☀️]\s*/u, '').trim();
    if (s === '즉시입주') s = '즉시입주 가능';
    if (s === '대로변/역세권') s = '대로변/코너';
    return s;
}
window.normalizeBriefingBadgeLabel = normalizeBriefingBadgeLabel;

function parsePostToBriefingItem(post) {
    if (!post) return null;
    try {
        const content = String(post.content || '').normalize('NFC');
        const title = String(post.title || '').normalize('NFC');
        const propNo = (typeof getPropertyDisplayNumber === 'function' ? getPropertyDisplayNumber(post) : '') || String(post.id || '').slice(-4);

        const getLineVal = (labelPattern) => {
            try {
                const re = new RegExp(`(?:✅|•|-)?\\s*(?:${labelPattern})\\s*[:：]\\s*([^\\n\\r]+)`, 'i');
                const m = content.match(re);
                return (m && m[1]) ? m[1].trim() : '';
            } catch (e) {
                return '';
            }
        };

        const locLine = getLineVal('위치|소재지') || post.address || '';
        const jeonyongLine = getLineVal('전용면적');
        const gonggeupLine = getLineVal('공급면적');
        const generalAreaLine = getLineVal('면적');
        const daejiLine = getLineVal('대지면적');
        const yeonLine = getLineVal('연면적');

        let areaStr = '';
        if (jeonyongLine) {
            const py = jeonyongLine.match(/약?\s*\d+(?:\.\d+)?\s*평/);
            areaStr = py ? `전용 ${py[0]}` : jeonyongLine.split('(')[0].trim();
        } else if (daejiLine || yeonLine) {
            const dPy = daejiLine ? daejiLine.match(/약?\s*\d+(?:\.\d+)?\s*평/) : null;
            const yPy = yeonLine ? yeonLine.match(/약?\s*\d+(?:\.\d+)?\s*평/) : null;
            areaStr = [dPy ? `대지 ${dPy[0]}` : '', yPy ? `연면적 ${yPy[0]}` : ''].filter(Boolean).join(' / ');
        } else if (generalAreaLine) {
            const py = generalAreaLine.match(/약?\s*\d+(?:\.\d+)?\s*평/);
            areaStr = py ? py[0] : generalAreaLine.split('(')[0].trim();
        } else if (gonggeupLine) {
            areaStr = gonggeupLine.split('(')[0].trim();
        }

        const curFloor = getLineVal('해당\\s*층수|해당층');
        const totFloor = getLineVal('총\\s*층수|총층');
        let floorStr = curFloor || totFloor || '';
        if (curFloor && totFloor && curFloor !== totFloor) {
            floorStr = `${curFloor} / 총 ${totFloor}`;
        }

        const depLine = getLineVal('보증금');
        const rentLine = getLineVal('월세|임대료');
        const maintLine = getLineVal('공용관리비|관리비');
        const premLine = getLineVal('권리금(?:\\(시설비\\))?');
        const saleLine = getLineVal('매매가|매매금액');
        const tradeLine = getLineVal('거래형태');

        const isSale = (tradeLine && tradeLine.includes('매매')) || title.includes('매매') || Boolean(saleLine);
        const deposit = parseKoreanMoneyToManwon(depLine);
        const rent = parseKoreanMoneyToManwon(rentLine);
        const managementFee = parseKoreanMoneyToManwon(maintLine);
        const premium = parseKoreanMoneyToManwon(premLine);
        const salePrice = parseKoreanMoneyToManwon(saleLine);

        const isRentVat = !rentLine || (!rentLine.includes('부가세포함') && !rentLine.includes('VAT포함'));
        const isMaintVat = maintLine.includes('부가세') || maintLine.includes('VAT') || maintLine.includes('별도');

        let premiumText = '무권리';
        if (premLine) {
            if (premLine.includes('무권리') || premLine.includes('없음')) premiumText = '무권리';
            else if (premium > 0) premiumText = '';
            else premiumText = premLine;
        }

        // Auto-detect commercial badges (expanded 18 items)
        const badges = [];
        const fullText = title + '\n' + content;
        const parkLine = getLineVal('주차');
        if (fullText.includes('주차편리') || fullText.includes('주차 매우') || fullText.includes('고정주차') || /[5-9]\d대|[1-9]\d\d대/.test(parkLine)) {
            badges.push('주차 편함');
        }
        const elevLine = getLineVal('엘리베이터');
        if ((elevLine && !elevLine.toLowerCase().includes('x') && !elevLine.includes('없음')) || fullText.includes('엘리베이터 완비') || fullText.includes('승강기 유')) {
            badges.push('엘리베이터 유');
        }
        const bathLine = getLineVal('화장실');
        if (fullText.includes('내부화장실') || (bathLine && bathLine.includes('내부'))) {
            badges.push('내부화장실');
        } else if (fullText.includes('외부화장실') || (bathLine && (bathLine.includes('외부') || bathLine.includes('복도')))) {
            badges.push('외부화장실');
        }
        if (fullText.includes('냉난방') || fullText.includes('에어컨') || fullText.includes('천장형')) {
            badges.push('냉난방기 있음');
        }
        if (fullText.includes('무권리') || premium === 0) {
            if (!isSale) badges.push('무권리');
        }
        if (fullText.includes('렌트프리')) {
            badges.push('렌트프리 협의');
        }
        if (fullText.includes('인테리어') || fullText.includes('시설완비')) {
            badges.push('인테리어 완비');
        }
        if (fullText.includes('룸') || fullText.includes('칸막이') || fullText.includes('강의실') || fullText.includes('원장실')) {
            badges.push('룸/칸막이 완비');
        }
        if (fullText.includes('탕비실') || fullText.includes('싱크대')) {
            badges.push('탕비실/싱크대');
        }
        if (fullText.includes('즉시 입주') || fullText.includes('즉시입주') || fullText.includes('공실')) {
            badges.push('즉시입주 가능');
        }
        if (fullText.includes('대로변') || fullText.includes('코너')) {
            badges.push('대로변/코너');
        }
        if (fullText.includes('역세권') || fullText.includes('출구')) {
            badges.push('역세권');
        }
        if (curFloor.includes('1층') || title.includes('1층')) {
            badges.push('1층 상가');
        }
        if (fullText.includes('층고') || fullText.includes('노출천장')) {
            badges.push('높은 층고/노출천장');
        }
        if (fullText.includes('테라스') || fullText.includes('베란다')) {
            badges.push('테라스/베란다');
        }
        if (fullText.includes('무상철거') || fullText.includes('원상복구')) {
            badges.push('무상철거/원상복구 협의');
        }

        // Extract clean summary comment from ⭐매물특징⭐
        let autoComment = '';
        const featMatch = content.match(/⭐매물특징⭐([\s\S]*?)(?:📢|🏢|💼|$)/);
        if (featMatch && featMatch[1]) {
            const lines = featMatch[1]
                .split('\n')
                .map(l => l.replace(/🔎/g, '•').trim())
                .filter(l => l && !l.includes('편하게 연락주시면'));
            autoComment = lines.slice(0, 3).join('\n');
        }

        const cleanTitle = title
            .replace(/매물번호\s*[:：]?\s*\d+/gi, '')
            .replace(/대구(상가|사무실|건물|상가주택)(임대|매매)/g, '')
            .replace(/\s+/g, ' ')
            .trim() || title;

        return {
            itemId: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            postId: String(post.id || ''),
            propNo: String(propNo || ''),
            tradeType: isSale ? 'sale' : 'rent',
            title: cleanTitle,
            address: locLine || post.address || '대구광역시',
            currentFloor: curFloor || '-',
            totalFloor: totFloor || '-',
            floor: floorStr || '-',
            area: areaStr || '-',
            deposit,
            rent,
            rentVat: Boolean(isRentVat),
            managementFee,
            maintVat: Boolean(isMaintVat),
            premium,
            premiumText,
            salePrice,
            badges,
            agentComment: autoComment,
            photos: extractAllPostImages(post, 15),
            officialDocs: Array.isArray(post.officialDocs) ? post.officialDocs : [],
            coordinates: Array.isArray(post.coordinates) ? post.coordinates : []
        };
    } catch (err) {
        console.error('parsePostToBriefingItem fallback:', err);
        return {
            itemId: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            postId: String(post.id || ''),
            propNo: String(post.id || '').slice(-4),
            tradeType: (post.title || '').includes('매매') ? 'sale' : 'rent',
            title: String(post.title || '추천 매물'),
            address: String(post.address || '대구광역시'),
            currentFloor: '-',
            totalFloor: '-',
            floor: '-',
            area: '-',
            deposit: 0,
            rent: 0,
            managementFee: 0,
            premium: 0,
            premiumText: '무권리',
            salePrice: 0,
            badges: [],
            agentComment: '',
            photos: extractAllPostImages(post, 15),
            coordinates: Array.isArray(post.coordinates) ? post.coordinates : []
        };
    }
}
window.parsePostToBriefingItem = parsePostToBriefingItem;

function syncBriefingItemsWithPosts(briefingsList, postsList) {
    if (!Array.isArray(briefingsList) || !Array.isArray(postsList) || postsList.length === 0) return false;
    let anyChanged = false;

    const postById = new Map();
    const postByPropNo = new Map();
    postsList.forEach(p => {
        if (!p) return;
        if (p.id) postById.set(String(p.id), p);
        const pNo = typeof getPropertyDisplayNumber === 'function' ? getPropertyDisplayNumber(p) : '';
        if (pNo) postByPropNo.set(String(pNo).trim(), p);
    });

    briefingsList.forEach(b => {
        if (!b || !Array.isArray(b.items)) return;
        b.items.forEach(item => {
            if (!item || item.autoSyncPost === false) return;
            let matchedPost = null;
            if (item.postId && postById.has(String(item.postId))) {
                matchedPost = postById.get(String(item.postId));
            } else if (item.propNo && postByPropNo.has(String(item.propNo).trim())) {
                matchedPost = postByPropNo.get(String(item.propNo).trim());
            }
            if (!matchedPost) return;

            const latest = parsePostToBriefingItem(matchedPost);
            if (!latest) return;

            // Sync financial & spec conditions if post has valid parsed numbers
            if (latest.deposit > 0 || latest.rent > 0 || latest.salePrice > 0) {
                if (item.deposit !== latest.deposit) { item.deposit = latest.deposit; anyChanged = true; }
                if (item.rent !== latest.rent) { item.rent = latest.rent; anyChanged = true; }
                if (item.managementFee !== latest.managementFee) { item.managementFee = latest.managementFee; anyChanged = true; }

                // Safe premium sync:
                // Only overwrite if the post itself has an explicit parsed positive premium (latest.premium > 0),
                // or if the post explicitly says '무권리'/'없음' AND item does NOT have a positive premium manually set!
                if (latest.premium > 0) {
                    if (item.premium !== latest.premium) { item.premium = latest.premium; anyChanged = true; }
                    if (latest.premiumText && item.premiumText !== latest.premiumText) { item.premiumText = latest.premiumText; anyChanged = true; }
                } else if (latest.premiumText && (latest.premiumText.includes('무권리') || latest.premiumText.includes('없음'))) {
                    if (!item.premium || item.premium === 0) {
                        if (item.premium !== 0) { item.premium = 0; anyChanged = true; }
                        if (item.premiumText !== '무권리') { item.premiumText = '무권리'; anyChanged = true; }
                    }
                }
                // If post has non-numeric text like '문의 (적극협의 가능)' or '협의', latest.premium is 0.
                // In this case, NEVER overwrite a positive item.premium (>0) or user custom text!

                if (item.salePrice !== latest.salePrice) { item.salePrice = latest.salePrice; anyChanged = true; }
                if (item.tradeType !== latest.tradeType) { item.tradeType = latest.tradeType; anyChanged = true; }
            }
            if (latest.area && latest.area !== '-' && item.area !== latest.area) {
                // Keep supply area if item already had supply area and latest only parsed jeonyong, unless base pyeong changed
                const curPy = (item.area || '').match(/\d+(?:\.\d+)?/);
                const newPy = (latest.area || '').match(/\d+(?:\.\d+)?/);
                if (!curPy || !newPy || curPy[0] !== newPy[0]) {
                    item.area = latest.area;
                    anyChanged = true;
                }
            }
            if (latest.currentFloor && latest.currentFloor !== '-' && item.currentFloor !== latest.currentFloor) {
                item.currentFloor = latest.currentFloor;
                anyChanged = true;
            }
            if (latest.totalFloor && latest.totalFloor !== '-' && (!item.totalFloor || item.totalFloor === '-')) {
                item.totalFloor = latest.totalFloor;
                anyChanged = true;
            }
            if (Array.isArray(latest.coordinates) && latest.coordinates.length === 2) {
                item.coordinates = latest.coordinates;
            }
        });
    });

    return anyChanged;
}
window.syncBriefingItemsWithPosts = syncBriefingItemsWithPosts;

async function syncUpdatedPostToBriefings(updatedPost) {
    if (!updatedPost) return;
    try {
        const store = await getBriefingData(false);
        if (!store || !Array.isArray(store.briefings)) return;
        const changed = syncBriefingItemsWithPosts(store.briefings, [updatedPost]);
        if (changed) {
            await saveBriefingData(store);
        }
    } catch (e) {}
}
window.syncUpdatedPostToBriefings = syncUpdatedPostToBriefings;

async function getBriefingData(autoSyncWithPosts = true) {
    let remoteData = null;

    // 1. Try serverless API /api/briefing (zero cache)
    try {
        const res = await fetch('/api/briefing?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
            remoteData = await res.json();
        }
    } catch (e) {}

    // 2. Fallback to GitHub REST API directly if config token exists
    if (!remoteData) {
        try {
            const config = await loadConfig();
            if (config.github_token && config.github_owner && config.github_repo) {
                const ghRes = await fetch(`https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/data/briefings.json?t=${Date.now()}`, {
                    headers: {
                        'Accept': 'application/vnd.github.v3+json',
                        'Authorization': `token ${config.github_token}`
                    },
                    cache: 'no-store'
                });
                if (ghRes.ok) {
                    const d = await ghRes.json();
                    const str = base64ToUtf8(d.content);
                    if (str) remoteData = JSON.parse(str);
                }
            }
        } catch (e) {}
    }

    // 3. Fallback to local file
    if (!remoteData) {
        try {
            const fRes = await fetch('data/briefings.json?t=' + Date.now());
            if (fRes.ok) remoteData = await fRes.json();
        } catch (e) {}
    }

    // Check if localStorage has a newer version saved within last 20 sec
    try {
        const localRaw = localStorage.getItem('choi_briefings_cache');
        if (localRaw) {
            const localData = JSON.parse(localRaw);
            if (localData && localData.updatedAt) {
                if (!remoteData || (localData.updatedAt > (remoteData.updatedAt || 0) && Date.now() - localData.updatedAt < 20000)) {
                    // Merge customerPicks from remoteData if any arrived
                    if (remoteData && Array.isArray(remoteData.briefings) && Array.isArray(localData.briefings)) {
                        localData.briefings.forEach(lb => {
                            const rb = remoteData.briefings.find(r => String(r.id) === String(lb.id));
                            if (rb && Array.isArray(rb.customerPicks) && rb.customerPicks.length > (lb.customerPicks || []).length) {
                                lb.customerPicks = rb.customerPicks;
                            }
                        });
                    }
                    remoteData = localData;
                }
            }
        }
    } catch (e) {}

    if (!remoteData || typeof remoteData !== 'object') {
        remoteData = { updatedAt: Date.now(), memos: [], briefings: [] };
    }
    if (!Array.isArray(remoteData.memos)) remoteData.memos = [];
    if (!Array.isArray(remoteData.briefings)) remoteData.briefings = [];

    // Automatically sync briefing items with latest homepage posts (보증금, 월세, 공용관리비, 권리금, 매매가, 면적, 층수 등)
    if (autoSyncWithPosts) {
        try {
            const posts = await getPosts();
            if (Array.isArray(posts) && posts.length > 0) {
                syncBriefingItemsWithPosts(remoteData.briefings, posts);
            }
        } catch (e) {}
    }

    try {
        localStorage.setItem('choi_briefings_cache', JSON.stringify(remoteData));
    } catch (e) {}

    return remoteData;
}
window.getBriefingData = getBriefingData;

async function saveBriefingData(dataObj) {
    dataObj.updatedAt = Date.now();
    try {
        localStorage.setItem('choi_briefings_cache', JSON.stringify(dataObj));
    } catch (e) {}

    let savedServer = false;
    try {
        const res = await fetch('/api/briefing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'save_all',
                memos: dataObj.memos,
                briefings: dataObj.briefings
            })
        });
        if (res.ok) {
            const j = await res.json();
            if (j && j.ok) savedServer = true;
        }
    } catch (e) {}

    if (!savedServer) {
        try {
            const config = await loadConfig();
            if (config.github_token && config.github_owner && config.github_repo) {
                const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/data/briefings.json`;
                const headers = {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `token ${config.github_token}`,
                    'Content-Type': 'application/json'
                };
                let sha = null;
                const getRes = await fetch(`${url}?t=${Date.now()}`, { headers });
                if (getRes.ok) {
                    const gd = await getRes.json();
                    sha = gd.sha || null;
                }
                const body = {
                    message: 'briefing: update memos and customer briefings [skip ci] [skip vercel]',
                    content: utf8ToBase64(JSON.stringify(dataObj, null, 2)),
                    branch: 'main'
                };
                if (sha) body.sha = sha;
                await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
            }
        } catch (e) {}
    }

    return dataObj;
}
window.saveBriefingData = saveBriefingData;

const DAEGU_LANDMARK_COORDS = {
    '범어네거리': [35.8593, 128.6253], '범어역': [35.8593, 128.6253], '수성구청역': [35.8586, 128.6306],
    '만촌역': [35.8586, 128.6455], '수성시장역': [35.8599, 128.6138], '대구은행역': [35.8608, 128.6042],
    '경대병원역': [35.8624, 128.6001], '반월당역': [35.8658, 128.5933], '중앙로역': [35.8712, 128.5945],
    '동대구역': [35.8778, 128.6285], '신매역': [35.8409, 128.7052], '고산역': [35.8423, 128.6924],
    '대공원역': [35.8427, 128.6788], '범물역': [35.8213, 128.6392], '지산역': [35.8245, 128.6331],
    '수성못역': [35.8318, 128.6225], '황금역': [35.8459, 128.6245], '어린이세상역': [35.8515, 128.6248],
    '감삼역': [35.8517, 128.5467], '두류역': [35.8568, 128.5552], '죽전역': [35.8501, 128.5365],
    '알파시티': [35.8370, 128.6819], '수성알파시티': [35.8370, 128.6819],
    '범어동': [35.8595, 128.6280], '만촌동': [35.8588, 128.6450], '수성동1가': [35.8590, 128.6060],
    '수성동2가': [35.8570, 128.6130], '수성동3가': [35.8560, 128.6190], '수성동4가': [35.8620, 128.6130],
    '수성동': [35.8585, 128.6130], '황금동': [35.8455, 128.6250], '중동': [35.8440, 128.6140],
    '상동': [35.8330, 128.6130], '파동': [35.8150, 128.6130], '두산동': [35.8310, 128.6230],
    '지산동': [35.8235, 128.6360], '범물동': [35.8190, 128.6430], '시지동': [35.8420, 128.6930],
    '신매동': [35.8405, 128.7055], '노변동': [35.8415, 128.7020], '사월동': [35.8390, 128.7150],
    '대흥동': [35.8370, 128.6819], '삼덕동': [35.8645, 128.6040], '동인동': [35.8700, 128.6060],
    '동성로': [35.8685, 128.5960], '남산동': [35.8610, 128.5880], '대봉동': [35.8575, 128.6005],
    '신천동': [35.8740, 128.6260], '효목동': [35.8780, 128.6420], '신암동': [35.8840, 128.6240],
    '산격동': [35.8990, 128.6080], '침산동': [35.8890, 128.5890], '칠성동': [35.8800, 128.5980],
    '대명동': [35.8460, 128.5790], '봉덕동': [35.8410, 128.5980], '이천동': [35.8520, 128.6010],
    '두류동': [35.8550, 128.5550], '감삼동': [35.8505, 128.5430], '죽전동': [35.8515, 128.5350],
    '용산동': [35.8565, 128.5290], '장기동': [35.8465, 128.5260], '본리동': [35.8390, 128.5370],
    '상인동': [35.8180, 128.5370], '진천동': [35.8135, 128.5230], '월성동': [35.8255, 128.5260],
    '이곡동': [35.8540, 128.5100], '호산동': [35.8420, 128.4880], '내당동': [35.8610, 128.5620]
};

async function geocodeKoreanAddressToCoords(addressStr, fallbackHint = '') {
    const raw = String(addressStr || '').trim();
    const hint = String(fallbackHint || '').trim();
    if (!raw && !hint) return null;

    let normalized = raw;
    // If address has Gu + lot number without Dong (e.g. "대구광역시 수성구 206-3"), infer Dong from hint or default to 범어동
    if (/구\s+\d+(?:-\d+)?/.test(normalized) && !/[가-힣]+(?:동|리|가|로|길)\s+\d+/.test(normalized)) {
        const dongMatch = (raw + ' ' + hint).match(/(범어동|만촌동|수성동[1-4]?가?|황금동|지산동|두산동|상동|중동|신매동|노변동|시지동|대흥동|신천동|신암동|남산동|삼덕동|동인동|대봉동|두류동|감삼동|죽전동|산격동|침산동|대명동|봉덕동)/);
        const inferredDong = dongMatch ? dongMatch[1] : '범어동';
        normalized = normalized.replace(/(구)\s+(\d+(?:-\d+)?)/, `$1 ${inferredDong} $2`);
    }

    // Extract clean address up to lot number or road number (strip trailing building names like "메타타워V")
    let cleanLotAddr = normalized.replace(/(\d+(?:-\d+)?)\s+[^\d].*$/, '$1').trim();
    if (!cleanLotAddr.includes('대구') && !cleanLotAddr.includes('경산') && !cleanLotAddr.includes('경북')) {
        cleanLotAddr = '대구광역시 ' + cleanLotAddr;
    }

    const hasSpecificNumber = /\d+/.test(cleanLotAddr);

    // 1. Try ArcGIS World Geocoder (100% precision on Korean lot numbers & road addresses)
    if (hasSpecificNumber) {
        try {
            const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&singleLine=${encodeURIComponent(cleanLotAddr)}&countryCode=KOR&maxLocations=1`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                const cand = data && data.candidates && data.candidates[0];
                if (cand && cand.score >= 85 && cand.location) {
                    return [Number(cand.location.y), Number(cand.location.x)];
                }
            }
        } catch (e) {}
    }

    // 2. Check specific landmarks/stations/dongs in combined text if no lot number or if lot lookup missed
    const combined = `${normalized} ${hint}`;
    for (const [kw, coords] of Object.entries(DAEGU_LANDMARK_COORDS)) {
        if (combined.includes(kw)) {
            return [coords[0], coords[1]];
        }
    }

    // 3. Fallback to ArcGIS general query
    try {
        const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&singleLine=${encodeURIComponent(cleanLotAddr)}&countryCode=KOR&maxLocations=1`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            const cand = data && data.candidates && data.candidates[0];
            if (cand && cand.location) {
                return [Number(cand.location.y), Number(cand.location.x)];
            }
        }
    } catch (e) {}

    return null;
}
window.geocodeKoreanAddressToCoords = geocodeKoreanAddressToCoords;

function isDummyDefaultCoordinate(coords) {
    if (!Array.isArray(coords) || coords.length !== 2) return true;
    const lat = Number(coords[0]);
    const lng = Number(coords[1]);
    if (isNaN(lat) || isNaN(lng)) return true;
    return Math.abs(lat - 35.8581) < 0.00015 && Math.abs(lng - 128.6205) < 0.00015;
}
window.isDummyDefaultCoordinate = isDummyDefaultCoordinate;

async function resolveBriefingItemsMissingCoords(briefingObj) {
    if (!briefingObj || !Array.isArray(briefingObj.items)) return false;
    let changed = false;
    for (const item of briefingObj.items) {
        if (!item) continue;
        const isStealth = String(item.itemId || '').startsWith('stealth_') || !item.postId;
        const needsGeocode = isDummyDefaultCoordinate(item.coordinates) || (isStealth && item._lastGeocodedAddr && item._lastGeocodedAddr !== item.address);
        if (needsGeocode && (item.address || item.title)) {
            const resolved = await geocodeKoreanAddressToCoords(item.address, `${item.title || ''} ${briefingObj.title || ''}`);
            if (resolved) {
                item.coordinates = resolved;
                item._lastGeocodedAddr = item.address;
                changed = true;
            }
        }
    }
    return changed;
}
window.resolveBriefingItemsMissingCoords = resolveBriefingItemsMissingCoords;

// =========================================================================
// 🟢 네이버 블로그 상위노출 (C-Rank & DIA+ 최적화 · 블로그지수 안전모드) 원고 생성기
// =========================================================================

let _currentNaverBlogPost = null;
let _currentNaverBlogSafetyMode = 'dual_guide'; // 'dual_guide' (🖥️ 보조모니터 보고 타이핑용 서술 대본 + 사진 위치 가이드 — 기본값) | 'skeleton' (핵심 뼈대만)
let _currentNaverBlogLinkMode = 'text'; // 'text' (🛡️ 안전 텍스트 안내 - 클릭링크 0개) | 'single' (🔗 상세링크 1개만) | 'none' (🚫 안내 숨김)
let _currentNaverBlogVariationSeed = 0;
let _currentNaverBlogSelectedTitleIdx = 0;
let _lastGeneratedBlogData = null;

const DAEGU_GEO_LANDMARKS = [
    { name: '봉산육거리 인근 대로변', shortName: '봉산육거리', lat: 35.8624, lng: 128.5989 },
    { name: '반월당네거리·반월당역 인근', shortName: '반월당역', lat: 35.8653, lng: 128.5934 },
    { name: '계산오거리 인근 대로변', shortName: '계산오거리', lat: 35.8669, lng: 128.5902 },
    { name: '명덕네거리·명덕역 인근', shortName: '명덕역', lat: 35.8576, lng: 128.5913 },
    { name: '건들바위네거리·건들바위역 인근', shortName: '건들바위역', lat: 35.8549, lng: 128.5979 },
    { name: '삼덕네거리·경대병원역 인근', shortName: '경대병원역', lat: 35.8634, lng: 128.6061 },
    { name: '동인네거리 인근 대로변', shortName: '동인네거리', lat: 35.8698, lng: 128.6058 },
    { name: '중앙네거리·중앙로역 인근', shortName: '중앙로역', lat: 35.8708, lng: 128.5950 },
    { name: '대구역네거리·대구역 인근', shortName: '대구역', lat: 35.8760, lng: 128.5960 },
    { name: '대구은행역·수성교 인근 달구벌대로변', shortName: '대구은행역', lat: 35.8599, lng: 128.6146 },
    { name: '수성네거리 인근 달구벌대로변', shortName: '수성네거리', lat: 35.8589, lng: 128.6186 },
    { name: '범어네거리·범어역 인근 달구벌대로변', shortName: '범어네거리·범어역', lat: 35.8588, lng: 128.6256 },
    { name: '수성구청역 인근 달구벌대로변', shortName: '수성구청역', lat: 35.8583, lng: 128.6306 },
    { name: '만촌네거리·만촌역 인근 달구벌대로변', shortName: '만촌네거리·만촌역', lat: 35.8576, lng: 128.6382 },
    { name: '담티역 인근 달구벌대로변', shortName: '담티역', lat: 35.8571, lng: 128.6476 },
    { name: '동성학교네거리 인근 대로변', shortName: '동성학교네거리', lat: 35.8550, lng: 128.6138 },
    { name: '수성시장네거리·수성시장역 인근', shortName: '수성시장역', lat: 35.8548, lng: 128.6102 },
    { name: '수성구민운동장역 인근', shortName: '수성구민운동장역', lat: 35.8505, lng: 128.6165 },
    { name: '황금네거리·황금역 인근 동대구로변', shortName: '황금네거리·황금역', lat: 35.8458, lng: 128.6226 },
    { name: '두산오거리 인근 동대구로변', shortName: '두산오거리', lat: 35.8336, lng: 128.6231 },
    { name: '수성못오거리·들안길 인근', shortName: '수성못·들안길', lat: 35.8295, lng: 128.6215 },
    { name: '지산네거리·지산역 인근', shortName: '지산역', lat: 35.8256, lng: 128.6331 },
    { name: '범물네거리·범물역 인근', shortName: '범물역', lat: 35.8213, lng: 128.6401 },
    { name: '신천네거리·신천역 인근', shortName: '신천역', lat: 35.8722, lng: 128.6175 },
    { name: '동대구역네거리·동대구역 인근', shortName: '동대구역', lat: 35.8778, lng: 128.6285 },
    { name: '큰고개오거리·아양교역 인근', shortName: '아양교역', lat: 35.8855, lng: 128.6365 },
    { name: '율하역·율하네거리 인근', shortName: '율하역', lat: 35.8662, lng: 128.6930 },
    { name: '두류네거리·두류역 인근 달구벌대로변', shortName: '두류네거리·두류역', lat: 35.8576, lng: 128.5562 },
    { name: '감삼네거리·감삼역 인근 달구벌대로변', shortName: '감삼역', lat: 35.8549, lng: 128.5488 },
    { name: '죽전네거리·죽전역 인근 달구벌대로변', shortName: '죽전네거리·죽전역', lat: 35.8531, lng: 128.5378 },
    { name: '용산역 인근', shortName: '용산역', lat: 35.8515, lng: 128.5260 },
    { name: '성서산업단지역 인근', shortName: '성서산업단지역', lat: 35.8513, lng: 128.5045 },
    { name: '계명대역 인근 달구벌대로변', shortName: '계명대역', lat: 35.8520, lng: 128.4870 },
    { name: '본리네거리 인근 대로변', shortName: '본리네거리', lat: 35.8388, lng: 128.5380 },
    { name: '상인네거리·상인역 인근 월배로변', shortName: '상인네거리·상인역', lat: 35.8188, lng: 128.5376 },
    { name: '월배역 인근 월배로변', shortName: '월배역', lat: 35.8135, lng: 128.5322 },
    { name: '진천네거리·진천역 인근', shortName: '진천역', lat: 35.8080, lng: 128.5265 },
    { name: '대곡역 인근', shortName: '대곡역', lat: 35.8015, lng: 128.5135 },
    { name: '성당네거리·서부정류장역 인근', shortName: '서부정류장역', lat: 35.8371, lng: 128.5582 },
    { name: '송현역 인근 월배로변', shortName: '송현역', lat: 35.8315, lng: 128.5512 },
    { name: '월촌역 인근 월배로변', shortName: '월촌역', lat: 35.8255, lng: 128.5440 },
    { name: '안지랑네거리·안지랑역 인근 대명로변', shortName: '안지랑역', lat: 35.8398, lng: 128.5735 },
    { name: '앞산네거리·현충로역 인근 대명로변', shortName: '현충로역', lat: 35.8430, lng: 128.5815 },
    { name: '영대병원네거리·영대병원역 인근', shortName: '영대병원역', lat: 35.8476, lng: 128.5870 },
    { name: '교대역·명덕로 인근', shortName: '교대역', lat: 35.8525, lng: 128.5900 },
    { name: '대명역 인근 대명로변', shortName: '대명역', lat: 35.8390, lng: 128.5655 },
    { name: '봉덕네거리 인근 대로변', shortName: '봉덕네거리', lat: 35.8422, lng: 128.5985 },
    { name: '반고개역 인근 달구벌대로변', shortName: '반고개역', lat: 35.8625, lng: 128.5715 },
    { name: '내당네거리·내당역 인근 달구벌대로변', shortName: '내당역', lat: 35.8602, lng: 128.5635 },
    { name: '청라언덕역·신남네거리 인근 달구벌대로변', shortName: '청라언덕역', lat: 35.8655, lng: 128.5815 },
    { name: '서문시장역 인근 대로변', shortName: '서문시장역', lat: 35.8691, lng: 128.5818 },
    { name: '달성네거리·달성공원역 인근', shortName: '달성네거리', lat: 35.8732, lng: 128.5800 },
    { name: '태평네거리 인근 태평로변', shortName: '태평네거리', lat: 35.8768, lng: 128.5872 },
    { name: '북구청네거리·북구청역 인근', shortName: '북구청역', lat: 35.8842, lng: 128.5825 },
    { name: '원대오거리·원대역 인근', shortName: '원대오거리', lat: 35.8810, lng: 128.5735 },
    { name: '만평네거리·만평역 인근', shortName: '만평역', lat: 35.8880, lng: 128.5625 },
    { name: '침산네거리 인근 침산로변', shortName: '침산네거리', lat: 35.8895, lng: 128.5915 },
    { name: '복현오거리 인근 대로변', shortName: '복현오거리', lat: 35.8955, lng: 128.6205 },
    { name: '칠성시장역 인근 대로변', shortName: '칠성시장역', lat: 35.8762, lng: 128.6062 },
    { name: '태전네거리·태전역 인근 칠곡중앙대로변', shortName: '태전역', lat: 35.9255, lng: 128.5480 },
    { name: '칠곡네거리·구암역 인근', shortName: '구암역', lat: 35.9365, lng: 128.5555 },
    { name: '팔거역·동천역(칠곡3지구) 인근', shortName: '팔거역', lat: 35.9435, lng: 128.5615 },
    { name: '정평역 인근 달구벌대로변', shortName: '정평역', lat: 35.8342, lng: 128.7185 },
    { name: '임당역·임당네거리 인근', shortName: '임당역', lat: 35.8315, lng: 128.7325 },
    { name: '영남대역 인근 대학로변', shortName: '영남대역', lat: 35.8285, lng: 128.7495 }
];

function findNearestDaeguLandmarkByCoords(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lat = Number(coords[0]);
    const lng = Number(coords[1]);
    if (isNaN(lat) || isNaN(lng) || isDummyDefaultCoordinate(coords)) return null;

    let best = null;
    let minMeters = Infinity;
    const toRad = (deg) => (deg * Math.PI) / 180;

    for (const lm of DAEGU_GEO_LANDMARKS) {
        const dLat = toRad(lm.lat - lat);
        const dLng = toRad(lm.lng - lng);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(toRad(lat)) * Math.cos(toRad(lm.lat)) *
                  Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distM = 6371000 * c;
        if (distM < minMeters) {
            minMeters = distM;
            best = { ...lm, distanceMeters: Math.round(distM) };
        }
    }
    // Use coordinate landmark if within 950m of a known Daegu intersection or station
    if (best && best.distanceMeters <= 950) {
        return best;
    }
    return null;
}

function extractNaverBlogSpecs(post) {
    if (!post) return null;
    const fullRawContent = String(post.content || '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/[ \t]+/g, ' ');

    // CRITICAL: Strip out '🏬주요중개 이력🏬' and '🏬개업공인중개사 정보🏬' BEFORE parsing property specs or location!
    const rawContent = fullRawContent.split(/🏬\s*주요\s*중개\s*이력|주요\s*중개\s*이력|🏬\s*개업공인중개사\s*정보|개업공인중개사\s*정보/)[0];

    const title = String(post.title || '').replace(/\s+/g, ' ').trim();
    const propNo = (typeof getPropertyDisplayNumber === 'function' ? getPropertyDisplayNumber(post) : '') || String(post.id || '').slice(-4);
    const fullText = `${post.address || ''} ${title} ${rawContent}`;

    const mGu = fullText.match(/((?:수성|달서|중|동|서|남|북)구|(?:달성|칠곡)군|경산시)/);
    const mDong = fullText.match(/([가-힣]{2,6}(?:동[0-9]*가?|읍|면))/);
    const gu = mGu ? mGu[1] : '수성구';
    const dong = mDong ? mDong[1] : '';

    const getField = (regex) => {
        const m = rawContent.match(regex);
        return m ? m[1].trim() : '';
    };

    const locField = getField(/(?:소재지|위치|주소)\s*:\s*([^\n]+)/i);
    const cleanAddr = (locField || post.address || `대구광역시 ${gu} ${dong}`).replace(/\s+/g, ' ').trim();
    const shortLoc = cleanAddr.replace('대구광역시', '대구').trim();

    const deposit = getField(/보증금\s*:\s*([^\n]+)/i);
    const rent = getField(/(?:월세|임대료)\s*:\s*([^\n]+)/i);
    const salePrice = getField(/매매가\s*:\s*([^\n]+)/i);
    const maintFee = getField(/공용\s*관리비\s*:\s*([^\n]+)/i) || getField(/관리비\s*:\s*([^\n]+)/i);
    let keyMoney = getField(/권리금(?:\([^)]*\))?\s*:\s*([^\n]+)/i);
    const isNoKeyMoney = /무권리|권리금\s*없음|권리금\s*0/.test(fullText);
    if (!keyMoney) keyMoney = isNoKeyMoney ? '무권리 (권리금 없음)' : '현장 협의';

    const trade = (/매매/.test(title) || salePrice) ? '매매' : '임대';
    let mainType = '상가';
    if (/사무실/.test(title)) mainType = '사무실';
    else if (/병의원|병원|의원/.test(title)) mainType = '병의원';
    else if (/학원|교습소/.test(title)) mainType = '학원·교육시설';
    else if (/빌딩|건물/.test(title) && trade === '매매') mainType = '수익형 빌딩·상가건물';
    else if (/공장|창고/.test(title)) mainType = '공장·창고';
    else if (/상가/.test(title)) mainType = '상가';
    else if (/사무실/.test(rawContent)) mainType = '사무실';

    // Extract ONLY property info lines from 🏢매물정보🏢 block FIRST (starting AFTER 매물정보 heading so top 📢 promo banners NEVER truncate it!)
    let propInfoSection = rawContent;
    const infoHeaderMatch = rawContent.match(/🏢?\s*매물\s*정보\s*🏢?/);
    if (infoHeaderMatch) {
        propInfoSection = rawContent.slice(infoHeaderMatch.index + infoHeaderMatch[0].length);
        propInfoSection = propInfoSection.split(/⭐\s*매물\s*특징|📢|💼\s*본\s*건물|🏬/)[0];
    } else {
        const firstCheckIdx = rawContent.indexOf('✅');
        if (firstCheckIdx >= 0) {
            propInfoSection = rawContent.slice(firstCheckIdx).split(/⭐\s*매물\s*특징|📢|💼\s*본\s*건물|🏬/)[0];
        } else {
            propInfoSection = rawContent.split(/⭐\s*매물\s*특징|💼\s*본\s*건물|🏬/)[0];
        }
    }

    const statutoryLines = [];
    const infoLines = propInfoSection.split('\n');
    for (let i = 0; i < infoLines.length; i++) {
        const line = infoLines[i].trim();
        if (line.startsWith('✅')) {
            let cleanLine = line.replace(/^✅\s*/, '').replace(/：/g, ':').trim();
            // If next line is a parenthetical continuation like "(중개의뢰인이 알려준 면적으로...)", merge it
            if (i + 1 < infoLines.length) {
                const nextLine = infoLines[i + 1].trim();
                if (nextLine.startsWith('(') && !nextLine.startsWith('✅')) {
                    cleanLine += ' ' + nextLine;
                    i++;
                }
            }
            if (cleanLine.includes(':') && !/중개$/.test(cleanLine)) {
                statutoryLines.push(cleanLine);
            }
        }
    }

    // Parse supply/contract area & exclusive area separately so BOTH are preserved accurately!
    const getInfoField = (regex) => {
        const mInfo = propInfoSection.match(regex);
        if (mInfo) return mInfo[1].trim();
        return getField(regex);
    };
    const parseAreaSpec = (rawVal) => {
        const clean = String(rawVal || '').trim();
        if (!clean) return { raw: '', pyeong: 0, m2: 0 };
        const pm = clean.match(/([0-9]+(?:\.[0-9]+)?)\s*평/);
        const mm = clean.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²)/i);
        let pyeong = pm ? Math.round(parseFloat(pm[1]) * 100) / 100 : 0;
        let m2 = mm ? Math.round(parseFloat(mm[1]) * 100) / 100 : (pyeong > 0 ? Math.round(pyeong * 3.3058 * 100) / 100 : 0);
        if (!pyeong && m2 > 0) pyeong = Math.round((m2 / 3.3058) * 100) / 100;
        return { raw: clean, pyeong, m2 };
    };

    const supplyAreaRaw = getInfoField(/공급\s*면적\s*:\s*([^\n]+)/i);
    const contractAreaRaw = getInfoField(/계약\s*면적\s*:\s*([^\n]+)/i);
    const exclusiveAreaRaw = getInfoField(/전용\s*면적\s*:\s*([^\n]+)/i);
    const genericAreaRaw = getInfoField(/(?:^|\n)\s*(?:✅\s*)?(?:면적|평수)\s*:\s*([^\n]+)/i);

    const supplyAreaSpec = parseAreaSpec(supplyAreaRaw || contractAreaRaw);
    const exclusiveAreaSpec = parseAreaSpec(exclusiveAreaRaw);
    const genericAreaSpec = parseAreaSpec(genericAreaRaw);

    const primaryAreaSpec = exclusiveAreaSpec.raw
        ? exclusiveAreaSpec
        : (genericAreaSpec.raw ? genericAreaSpec : supplyAreaSpec);
    const rawArea = primaryAreaSpec.raw || getField(/(?:전용면적|공급면적|계약면적|면적|평수)\s*:\s*([^\n]+)/i);
    let pyeongNum = primaryAreaSpec.pyeong;
    let m2Num = primaryAreaSpec.m2;
    if (!pyeongNum && !m2Num) {
        const pMatch = (rawArea + ' ' + title + ' ' + rawContent).match(/([0-9]+(?:\.[0-9]+)?)\s*평/);
        if (pMatch) pyeongNum = Math.round(parseFloat(pMatch[1]) * 100) / 100;
        const m2Match = (rawArea + ' ' + rawContent).match(/([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²)/i);
        m2Num = m2Match ? Math.round(parseFloat(m2Match[1]) * 100) / 100 : (pyeongNum > 0 ? Math.round(pyeongNum * 3.3058 * 100) / 100 : 0);
        if (!pyeongNum && m2Num > 0) pyeongNum = Math.round((m2Num / 3.3058) * 100) / 100;
    }

    // Separate Total Floor (총 층수) and Current Floor (해당 층수)
    const totalFloor = getInfoField(/총\s*층\s*수?\s*:\s*([^\n]+)/i);
    const currentFloor = getInfoField(/해당\s*층\s*수?\s*:\s*([^\n]+)/i)
        || getInfoField(/(?<!총\s*)층\s*수?\s*:\s*([^\n]+)/i)
        || ((title.match(/([0-9]+층|지하[0-9]+층|1층)/) || [])[1] || '상세 문의');
    const floor = currentFloor;

    const parking = getInfoField(/주차\s*:\s*([^\n]+)/i) || (/주차/.test(title) ? '주차 편리 (전용 주차공간 확보)' : '건물 내 주차 가능');
    const usage = getInfoField(/(?:중개대상물\s*종류|건축물\s*용도|용도)\s*:\s*([^\n]+)/i) || (mainType === '사무실' ? '업무시설 / 근린생활시설' : '근린생활시설');
    const direction = getInfoField(/방향\s*:\s*([^\n]+)/i);
    const moveIn = getInfoField(/(?:입주\s*가능일|입주시기|입주)\s*:\s*([^\n]+)/i) || (/즉시/.test(fullText) ? '즉시 입주 가능 (상호 협의)' : '상호 협의 가능');
    const approvalDate = getInfoField(/(?:사용승인일|준공일)\s*:\s*([^\n]+)/i);
    const restroom = getInfoField(/(?:욕실\s*수|화장실)\s*:\s*([^\n]+)/i) || (/내부화장실/.test(fullText) ? '내부 화장실 완비' : '층별 남녀구분 화장실');
    const elevator = getInfoField(/엘리베이터\s*:\s*([^\n]+)/i) || (/엘리베이터|승강기|엘베/.test(fullText) ? '승강기(엘리베이터) 운행 중' : '');
    const customRecBiz = getField(/추천\s*업종\s*:\s*([^\n]+)/i);

    // Extract feature bullets (🔎 lines at the start of a line ONLY — never match hyphens in phone/registration numbers!)
    const featMatches = [...rawContent.matchAll(/(?:^|\n)\s*(?:🔎|▶|•|✔|✓|★)\s*([^\n]+)/g)]
        .map(m => m[1].trim())
        .filter(line => {
            if (line.length < 4) return false;
            if (/3548-4000|746-7114|2024-00085|12-25-21|등록번호|매수신청대리인|최가네부동산|수성동1가\s*72-3/.test(line)) return false;
            if (/^[0-9-\s]+$/.test(line)) return false;
            if (/^(위치|소재지|보증금|월세|매매가|관리비|공용관리비|개별관리비|권리금|전용면적|공급면적|면적|해당\s*층|총\s*층|층수|방\s*수|욕실\s*수|엘리베이터|중개대상물|거래형태|주차|용도|방향|입주|사용승인일|화장실|매물번호|추천\s*업종)\s*:/.test(line)) return false;
            return true;
        });

    // Determine exact location landmark using:
    // 1) Map coordinates (post.coordinates) -> nearest Daegu intersection (예: 봉산육거리 인근 대로변, 동성학교네거리 인근 대로변)
    // 2) Building name in title (예: 제일에스타워, 동양생명빌딩)
    // 3) Explicit intersection/station in title or ⭐매물특징⭐ (excluding专家인사이트 / 주요중개 이력!)
    const coordLandmark = findNearestDaeguLandmarkByCoords(post.coordinates);
    const bldgMatch = title.match(/([가-힣A-Za-z0-9]{2,12}(?:타워[A-Za-z0-9]*|빌딩|스퀘어))/);
    const bldgName = bldgMatch ? bldgMatch[1] : '';

    const titleAndFeaturesText = `${title} ${featMatches.join(' ')}`;
    const intersectionMatch = titleAndFeaturesText.match(/([가-힣]{2,6}(?:네거리|오거리|육거리|삼거리|교차로))/);
    const stationRegex = /(반월당역|범어역|대구은행역|수성구청역|만촌역|담티역|연호역|대공원역|고산역|신매역|사월역|정평역|임당역|영남대역|동대구역|대구역|중앙로역|명덕역|교대역|영대병원역|현충로역|안지랑역|대명역|서부정류장역|송현역|월촌역|상인역|월배역|진천역|대곡역|화원역|설화명곡역|신천역|칠성시장역|내당역|반고개역|청라언덕역|경대병원역|수성시장역|수성구민운동장역|황금역|어린이세상역|지산역|범물역|용지역|두류역|감삼역|죽전역|용산역|이곡역|성서산업단지역|계명대역|강창역|대실역|문양역|아양교역|동촌역|해안역|방촌역|용계역|율하역|신기역|반야월역|각산역|안심역|서대구역|칠곡경대병원역|팔거역|동천역|칠곡운암역|구암역|태전역|매천역|매천시장역|팔달역|공단역|만평역|팔달시장역|원대역|북구청역|달성공원역|서문시장역|남산역|건들바위역|대봉교역)/;
    const stationInTitleOrFeat = titleAndFeaturesText.match(stationRegex);

    let landmark = '';
    let shortLandmark = '';

    if (intersectionMatch) {
        shortLandmark = intersectionMatch[1];
        landmark = `${intersectionMatch[1]} 인근 대로변${bldgName ? ` (${bldgName})` : ''}`;
    } else if (stationInTitleOrFeat) {
        shortLandmark = stationInTitleOrFeat[1];
        landmark = `${stationInTitleOrFeat[1]} 인근${bldgName ? ` (${bldgName})` : ''}`;
    } else if (coordLandmark) {
        shortLandmark = coordLandmark.shortName;
        landmark = `${coordLandmark.name}${bldgName ? ` (${bldgName})` : ''}`;
    } else if (bldgName) {
        shortLandmark = bldgName;
        landmark = `${dong || gu} 대로변 (${bldgName})`;
    } else {
        shortLandmark = dong ? `${dong} 대로변` : `${gu} 중심상권`;
        landmark = shortLandmark;
    }

    const highlights = [];
    if (isNoKeyMoney) highlights.push('무권리');
    if (/인테리어|시설완비|시설 완비/.test(fullText)) highlights.push('인테리어 완비');
    if (/초역세권|역세권/.test(titleAndFeaturesText) || stationInTitleOrFeat) highlights.push('역세권');
    if (/고정주차|주차편리|주차 편리/.test(titleAndFeaturesText)) highlights.push('주차 편리');
    if (/렌트프리/.test(titleAndFeaturesText)) highlights.push('렌트프리 협의');
    if (/1층/.test(currentFloor) || /1층/.test(title)) highlights.push('1층 매장');
    if (highlights.length === 0) highlights.push('대로변 핵심입지');

    return {
        id: post.id,
        propNo,
        title,
        gu,
        dong,
        cleanAddr,
        shortLoc,
        trade,
        mainType,
        deposit,
        rent,
        salePrice,
        maintFee,
        keyMoney,
        isNoKeyMoney,
        pyeongNum,
        m2Num,
        rawArea,
        supplyAreaRaw,
        contractAreaRaw,
        exclusiveAreaRaw,
        supplyAreaSpec,
        exclusiveAreaSpec,
        floor,
        currentFloor,
        totalFloor,
        parking,
        usage,
        direction,
        moveIn,
        approvalDate,
        restroom,
        elevator,
        customRecBiz,
        statutoryLines,
        featMatches,
        landmark,
        shortLandmark,
        bldgName,
        highlights
    };
}

function buildNaverBlogContent(post, options = {}) {
    const sp = extractNaverBlogSpecs(post);
    if (!sp) return null;

    const safetyMode = options.safetyMode || _currentNaverBlogSafetyMode || 'dual_guide';
    const linkMode = options.linkMode || _currentNaverBlogLinkMode || 'text';
    const incTypingPrompts = options.incTypingPrompts !== false;
    const incPhotoGuide = options.incPhotoGuide !== false;
    const incM2 = options.incM2 !== false;
    const incLegalFooter = options.incLegalFooter !== false;

    const baseSeed = Number(String(sp.propNo || sp.id || '0').replace(/[^0-9]/g, '').slice(-4)) || 17;
    const seed = Math.abs(baseSeed + (_currentNaverBlogVariationSeed * 7));
    const pick = (arr, offset = 0) => arr[(seed + offset) % arr.length];

    const formatAreaPair = (spec) => {
        if (!spec || !spec.pyeong) return spec && spec.raw ? spec.raw : '';
        return (incM2 && spec.m2 > 0) ? `약 ${spec.pyeong}평 (${spec.m2}㎡)` : `약 ${spec.pyeong}평`;
    };
    const hasSupplyAndExclusive = Boolean(sp.supplyAreaSpec && sp.supplyAreaSpec.pyeong > 0 && sp.exclusiveAreaSpec && sp.exclusiveAreaSpec.pyeong > 0);
    const supplyLabel = (sp.contractAreaRaw && !sp.supplyAreaRaw) ? '계약' : '공급';
    const pyeongStr = hasSupplyAndExclusive
        ? `전용 ${formatAreaPair(sp.exclusiveAreaSpec)} / ${supplyLabel} ${formatAreaPair(sp.supplyAreaSpec)}`
        : (sp.exclusiveAreaSpec && sp.exclusiveAreaSpec.pyeong > 0
            ? `전용 ${formatAreaPair(sp.exclusiveAreaSpec)}`
            : (sp.pyeongNum > 0
                ? (incM2 && sp.m2Num > 0 ? `약 ${sp.pyeongNum}평 (${sp.m2Num}㎡)` : `약 ${sp.pyeongNum}평`)
                : (sp.rawArea || '상세 면적 문의')));
    const shortPyeong = sp.exclusiveAreaSpec && sp.exclusiveAreaSpec.pyeong > 0
        ? `전용 ${Math.round(sp.exclusiveAreaSpec.pyeong)}평`
        : (sp.pyeongNum > 0 ? `${Math.round(sp.pyeongNum)}평` : '');
    const hlStr = sp.highlights.slice(0, 2).join(' ');

    const locPrefix = sp.dong ? `대구 ${sp.gu} ${sp.dong}` : `대구 ${sp.gu}`;
    const hasSpecificLandmark = sp.landmark && !sp.landmark.includes(sp.dong || sp.gu);
    const lmTitlePart = hasSpecificLandmark ? `${sp.landmark} ` : '';
    const lmParenPart = hasSpecificLandmark ? ` (${sp.landmark})` : '';
    const floorSummaryStr = sp.totalFloor && sp.currentFloor && sp.totalFloor !== sp.currentFloor
        ? `${sp.currentFloor} (총 층수 ${sp.totalFloor})`
        : (sp.currentFloor || sp.floor || '상세 문의');

    // 3 Recommended Human-Style SEO Titles for Naver Blog
    const titleOptions = [
        `${locPrefix} ${sp.mainType} ${sp.trade}, ${lmTitlePart}${shortPyeong ? `${shortPyeong} ` : ''}${hlStr} 현장 다녀왔습니다 (매물번호 ${sp.propNo})`,
        `[${locPrefix} ${sp.mainType} ${sp.trade}] ${shortPyeong ? `${shortPyeong} ` : ''}${lmTitlePart}${hlStr} 실매물 정리 (#${sp.propNo})`,
        `대구 ${sp.dong || sp.gu} ${lmTitlePart}${shortPyeong ? `${shortPyeong}대 ` : ''}${sp.mainType} ${sp.trade} 주차·내부·조건 안내 (NO.${sp.propNo})`
    ];

    const selectedTitle = titleOptions[_currentNaverBlogSelectedTitleIdx] || titleOptions[0];

    // Recommend business types based on property traits (prioritizing broker's customRecBiz if present)
    let recBiz = '법인 지사, 일반 사무실, 세무·법무·설계 등 전문직 오피스, 고객 상담실';
    if (sp.mainType.includes('병의원') || /병원|의원|클리닉/.test(sp.title)) {
        recBiz = '병의원·클리닉 및 중대형 사무실';
    } else if (sp.mainType.includes('학원') || /학원|교습소/.test(sp.title)) {
        recBiz = '학원·교습소·교육원 및 연구실';
    } else if (sp.mainType === '상가' || /1층|식당|카페/.test(sp.title)) {
        recBiz = '음식점, 카페, 판매점, 쇼룸 등 근린생활 업종 전반';
    }
    if (sp.customRecBiz) {
        recBiz = sp.customRecBiz;
    }

    const detailFeatures = sp.featMatches.length > 0
        ? sp.featMatches
        : [
            `${locPrefix} (${sp.landmark}) 인근에 위치해 접근성이 우수합니다.`,
            `면적 ${pyeongStr} 규모로 공간 활용도가 좋습니다.`,
            `${sp.isNoKeyMoney ? '권리금이 없는 무권리 조건입니다.' : '내부 시설 상태가 깔끔하게 유지되어 있습니다.'}`,
            `주차 여건 : ${sp.parking}`
        ];

    // Helper: enrich statutory area lines with ㎡ (or 평) when incM2 (평·㎡ 병기) is checked
    const formatStatutoryLine = (line) => {
        if (!incM2) return line;
        if (/^(?:공급\s*면적|전용\s*면적|계약\s*면적|대지\s*면적|건축\s*면적|연면적|면적)\s*:/.test(line)) {
            const hasM2 = /(?:㎡|m2|m²)/i.test(line);
            const hasPyeong = /([0-9]+(?:\.[0-9]+)?)\s*평/.test(line);
            if (hasPyeong && !hasM2) {
                return line.replace(/([0-9]+(?:\.[0-9]+)?)\s*평/, (full, numStr) => {
                    const pVal = parseFloat(numStr);
                    if (isNaN(pVal) || pVal <= 0) return full;
                    const m2Val = Math.round(pVal * 3.3058 * 100) / 100;
                    return `${full} (${m2Val}㎡)`;
                });
            }
            if (hasM2 && !hasPyeong) {
                return line.replace(/([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²)/i, (full, numStr) => {
                    const mVal = parseFloat(numStr);
                    if (isNaN(mVal) || mVal <= 0) return full;
                    const pVal = Math.round((mVal / 3.3058) * 100) / 100;
                    return `${full} (약 ${pVal}평)`;
                });
            }
        }
        return line;
    };

    const fallbackAreaLines = [];
    if (sp.supplyAreaSpec && sp.supplyAreaSpec.raw) {
        const sLabel = (sp.contractAreaRaw && !sp.supplyAreaRaw) ? '계약면적' : '공급면적';
        fallbackAreaLines.push(formatStatutoryLine(`${sLabel} : ${sp.supplyAreaSpec.raw}`));
    }
    if (sp.exclusiveAreaSpec && sp.exclusiveAreaSpec.raw) {
        fallbackAreaLines.push(formatStatutoryLine(`전용면적 : ${sp.exclusiveAreaSpec.raw}`));
    }
    if (fallbackAreaLines.length === 0) {
        fallbackAreaLines.push(`면적 : ${pyeongStr}`);
    }

    // Verbatim statutory disclosure block (매물정보 lines only — preserves BOTH 공급면적 & 전용면적 + all 18+ statutory fields!)
    const statutoryDisclosureList = (Array.isArray(sp.statutoryLines) && sp.statutoryLines.length >= 4)
        ? sp.statutoryLines.map(formatStatutoryLine)
        : [
            `위치 : ${sp.cleanAddr}`,
            ...fallbackAreaLines,
            ...(sp.trade === '매매'
                ? [`매매가 : ${sp.salePrice || '별도 문의'}`]
                : [
                    `보증금 : ${sp.deposit || '문의'}`,
                    `월세 : ${sp.rent || '문의'}`,
                    ...(sp.maintFee ? [`공용관리비 : ${sp.maintFee}`] : []),
                    `권리금(시설비) : ${sp.keyMoney}`
                ]),
            `주차 : ${sp.parking}`,
            ...(sp.elevator ? [`엘리베이터 : ${sp.elevator}`] : []),
            ...(sp.totalFloor ? [`총 층수 : ${sp.totalFloor}`] : []),
            `해당 층수 : ${sp.currentFloor || sp.floor}`,
            ...(sp.direction ? [`방향 : ${sp.direction}`] : []),
            `중개대상물종류 : ${sp.usage}`,
            ...(sp.approvalDate ? [`사용승인일 : ${sp.approvalDate}`] : []),
            `거래형태 : ${sp.trade === '매매' ? '매매' : '임대차계약 (월세)'}`,
            `입주가능일 : ${sp.moveIn}`
        ];

    const detailUrl = `https://www.choi114.com/news-detail?id=${encodeURIComponent(String(sp.id))}`;

    // Generate 18 SEO Hashtags for Naver Blog
    const cleanDong = sp.dong.replace(/[0-9]+가$/, '동');
    const cleanShortLm = (sp.shortLandmark || '').replace(/[·\s()]/g, '');
    const rawTags = [
        `대구${sp.mainType.replace(/·.*$/, '')}${sp.trade}`,
        `대구상가${sp.trade}`,
        `대구사무실${sp.trade}`,
        `${sp.gu}상가${sp.trade}`,
        `${sp.gu}사무실${sp.trade}`,
        sp.dong ? `${sp.dong}상가${sp.trade}` : '',
        sp.dong ? `${sp.dong}사무실${sp.trade}` : '',
        cleanDong && cleanDong !== sp.dong ? `${cleanDong}사무실` : '',
        cleanShortLm ? `대구${cleanShortLm}` : '',
        sp.bldgName ? sp.bldgName.replace(/\s+/g, '') : '',
        sp.pyeongNum >= 10 ? `대구${Math.floor(sp.pyeongNum / 10) * 10}평대${sp.mainType.replace(/·.*$/, '')}` : '',
        sp.pyeongNum >= 10 && sp.gu ? `${sp.gu}${Math.floor(sp.pyeongNum / 10) * 10}평대사무실` : '',
        sp.isNoKeyMoney ? '대구무권리상가' : '',
        sp.isNoKeyMoney ? '대구무권리사무실' : '',
        '대구상가전문부동산',
        '대구사무실전문부동산',
        '수성구부동산',
        '최가네부동산',
        '공인중개사최이명'
    ].filter(Boolean);
    const uniqueTags = [...new Set(rawTags)].slice(0, 18);
    const hashtagStr = uniqueTags.map(t => `#${t}`).join(' ');
    const commaTagStr = uniqueTags.join(', ');

    // Anti-Similarity Varied Sentence Pools (8 x 8 x 8 x 8 = 4,096 combinations so no two posts share boilerplate!)
    const greetingPool = [
        `안녕하세요. 대구 상가·사무실 중개 전문 최가네부동산 최이명 소장입니다.`,
        `반갑습니다. 대구 상가·오피스 현장을 발로 뛰는 최가네부동산 대표 공인중개사 최이명입니다.`,
        `안녕하세요, 대구 전 지역 사업장·사무실 실매물을 직접 확인해 전해드리는 최가네부동산 최이명 소장입니다.`,
        `안녕하세요. 대구 상가와 사무실 임대·매매를 전문으로 다루는 최가네부동산 공인중개사 최이명입니다.`,
        `반갑습니다! 대구 상가·사무실 현장 브리핑을 전해드리는 최가네부동산 최이명 대표소장입니다.`,
        `안녕하세요. 대구에서 상가·오피스·수익형 부동산을 전문 중개하고 있는 최가네부동산 최이명입니다.`,
        `안녕하세요. 대표님들의 사업장 이전을 꼼꼼하게 돕는 대구 최가네부동산 최이명 공인중개사입니다.`,
        `반갑습니다. 대구 상가·사무실 알짜 실매물을 현장에서 직접 점검해 소개하는 최가네부동산 최이명 소장입니다.`
    ];

    const summaryLinePool = [
        `오늘 안내해 드릴 매물은 ${locPrefix}${lmParenPart}에 위치한 ${pyeongStr} 규모의 ${sp.mainType} ${sp.trade} 실매물(매물번호 ${sp.propNo}번)입니다.`,
        `이번에 현장을 다녀와 정리한 곳은 ${locPrefix}, ${sp.landmark}에 자리한 ${pyeongStr} ${sp.mainType} ${sp.trade} 매물(매물번호 ${sp.propNo}번)입니다.`,
        `오늘 소개해 드리는 매물번호 ${sp.propNo}번은 ${locPrefix}${lmParenPart}에서 바로 살펴보실 수 있는 ${pyeongStr} 규모의 ${sp.mainType} ${sp.trade} 공간입니다.`,
        `이번 포스팅에서는 ${locPrefix} (${sp.landmark}) 현장에서 직접 확인한 ${pyeongStr} ${sp.mainType} ${sp.trade} 매물(매물번호 ${sp.propNo}번) 소식을 전해드립니다.`,
        `오늘 함께 살펴볼 곳은 ${locPrefix}${lmParenPart}에 자리 잡고 있는 ${pyeongStr} 규모의 ${sp.mainType} ${sp.trade}(매물번호 ${sp.propNo}번)입니다.`,
        `현장에서 직접 사진을 찍고 조건을 체크해 온 ${locPrefix} ${sp.landmark} ${pyeongStr} ${sp.mainType} ${sp.trade} 매물(NO.${sp.propNo})을 정리해 드립니다.`,
        `오늘 정리해 드릴 매물번호 ${sp.propNo}번은 ${locPrefix}${lmParenPart}에서 깔끔한 컨디션을 찾으시는 분들께 알맞은 ${pyeongStr} ${sp.mainType} ${sp.trade}입니다.`,
        `이번에 소개할 공간은 ${locPrefix} (${sp.landmark})에 위치한 ${pyeongStr} 규모의 ${sp.mainType} ${sp.trade} 실매물(매물번호 ${sp.propNo}번)입니다.`
    ];

    const locationLinePool = [
        `소재지는 ${sp.cleanAddr}이며, ${sp.landmark}에 위치해 차량 및 대중교통 동선이 편리합니다.`,
        `${sp.cleanAddr} (${sp.landmark})에 자리하고 있어 내방객이 찾아오거나 위치를 안내하기에 수월한 입지입니다.`,
        `위치는 ${sp.cleanAddr}, ${sp.landmark} 인근으로 주변 도로 여건과 생활·업무 인프라가 잘 갖춰진 구역입니다.`,
        `${sp.cleanAddr} 일대 ${sp.landmark}에 접해 있어 출퇴근 접근성과 대외 가시성을 고루 갖춘 위치입니다.`,
        `해당 매물은 ${sp.cleanAddr} (${sp.landmark})에 위치하며, 인근 편의시설과 교통망 이용이 수월합니다.`,
        `${sp.cleanAddr}, ${sp.landmark} 쪽에 자리 잡아 직원 출퇴근과 외부 거래처 방문 모두 무리가 없는 위치입니다.`,
        `입지는 ${sp.cleanAddr} (${sp.landmark})이며, 대로변과 인접해 처음 오시는 분들도 쉽게 찾으실 수 있습니다.`,
        `${sp.cleanAddr} 내 ${sp.landmark}에 위치해 있어 실사용 만족도가 꾸준히 높은 구역입니다.`
    ];

    const conditionLinePool = [
        `전체 면적은 ${pyeongStr}, 해당 층수는 ${floorSummaryStr}이며 ${sp.isNoKeyMoney ? '권리금이 없는 무권리 조건이라 초기 부담을 줄이실 수 있습니다.' : '내부 관리 상태가 양호해 입주 준비가 수월합니다.'}`,
        `면적 규모는 ${pyeongStr}(해당층 ${floorSummaryStr})이고, ${sp.isNoKeyMoney ? '무권리 매물로 초기 시설비 부담 없이 입주하실 수 있습니다.' : '공간 구획이 잘 잡혀 있어 활용도가 높습니다.'}`,
        `${pyeongStr} 규모에 ${floorSummaryStr}에 해당하며, 주차는 [${sp.parking}] 여건을 갖추고 있습니다.`,
        `해당 층수는 ${floorSummaryStr}, 면적은 ${pyeongStr}이며 ${sp.isNoKeyMoney ? '별도 권리금 없이 진행 가능한 실속형 매물입니다.' : '채광과 내부 동선이 깔끔하게 정돈되어 있습니다.'}`,
        `면적 기준 ${pyeongStr}(${floorSummaryStr}) 규모로, 입주 시기는 [${sp.moveIn}] 조건입니다.`,
        `규모는 ${pyeongStr}, 층수는 ${floorSummaryStr}이며 ${sp.isNoKeyMoney ? '무권리 조건에 내부 컨디션이 잘 갖춰져 있습니다.' : '업종에 맞춰 바로 세팅하기 좋은 구조입니다.'}`,
        `${floorSummaryStr}에 위치한 ${pyeongStr} 공간으로, 주차(${sp.parking}) 및 기본 설비가 잘 뒷받침되어 있습니다.`,
        `면적 ${pyeongStr} / ${floorSummaryStr} 구성이며, ${sp.isNoKeyMoney ? '권리금 부담 없는 무권리 매물입니다.' : '실물 컨디션을 현장에서 직접 보시면 더욱 만족하실 공간입니다.'}`
    ];

    const closingLinePool = [
        `현장 답사나 조건 조율이 필요하시면 매물번호 [${sp.propNo}번]을 말씀해 주시면 빠르게 안내해 드리겠습니다.`,
        `보증금·월세 조정이나 입주 일정 등 세부 조건은 현장에서 직접 보시면서 편하게 상의해 보세요.`,
        `${locPrefix} 인근에서 ${pyeongStr} 규모의 ${sp.mainType}을 찾고 계신다면 매물번호 ${sp.propNo}번 현장을 직접 확인해 보시길 권해드립니다.`,
        `궁금하신 사항이나 현장 방문 예약은 아래 연락처로 매물번호 ${sp.propNo}번을 알려주시면 상세히 설명해 드리겠습니다.`,
        `실제 공간감과 주차 동선은 현장에서 직접 보시는 것이 가장 정확합니다. 언제든 편하게 문의 주세요.`,
        `대표님의 업종과 예산에 맞춘 조건 협의까지 최가네부동산이 꼼꼼하게 도와드리겠습니다.`,
        `오늘 보신 ${sp.propNo}번 매물 외에도 인근 비교 매물을 함께 안내해 드릴 수 있으니 편하게 연락 주시기 바랍니다.`,
        `입주 시기나 렌트프리 등 구체적인 협의 사항은 현장 미팅 시 최선을 다해 조율해 드리겠습니다.`
    ];

    const specHeadingText = '중개대상물 정보\n(포스팅 현시점, 건축물대장상 정보)';
    const sectionTitleSets = [
        { feat: `[ 현장 핵심 특징 (매물번호 ${sp.propNo}번) ]`, spec: specHeadingText, rec: `[ 추천 업종 및 상담 안내 ]` },
        { feat: `■ 현장 체크 포인트 (NO.${sp.propNo})`, spec: specHeadingText, rec: `■ 추천 업종 및 현장 문의` },
        { feat: `✔ 매물번호 ${sp.propNo}번 주요 특징`, spec: specHeadingText, rec: `✔ 추천 업종 및 브리핑 마무리` },
        { feat: `◈ 입지 및 내부 핵심 포인트`, spec: specHeadingText, rec: `◈ 추천 업종 및 관람 안내` }
    ];
    const secTitles = pick(sectionTitleSets, 2);

    const greetingLine = pick(greetingPool, 0);
    const summaryLine = pick(summaryLinePool, 1);
    const locationLine = pick(locationLinePool, 3);
    const conditionLine = pick(conditionLinePool, 5);
    const closingLine = pick(closingLinePool, 7);

    // Extra narrative lines for each photo block in Dual-Monitor Typing Guide mode
    const photo1SubPool = [
        `외관과 진입로부터 살펴보겠습니다. 큰 대로변에서 바로 진입할 수 있는 위치라 처음 방문하시는 고객분들이나 거래처에서도 헤매지 않고 찾아오실 수 있습니다.`,
        `건물 외관과 주출입구 모습입니다. 도로변 가시성이 좋고 건물 관리가 깔끔하게 되어 있어 입주 후 방문객들에게 신뢰감을 주기 좋은 환경입니다.`,
        `대로변에서 바라본 건물 외관입니다. 주변으로 버스정류장과 주요 도로망이 잘 연결되어 있어 직원분들 출퇴근은 물론 차량 이동이 무척 수월합니다.`,
        `현장 입구와 주변 도로 여건입니다. 인근에 은행과 편의시설, 상권 인프라가 잘 형성되어 있어 실제로 근무해 보시면 생활 편의성이 뛰어난 곳입니다.`
    ];
    const photo2SubPool = [
        `내부로 들어와 메인 홀과 전체적인 공간 구성을 찍어보았습니다. 기둥 간섭 없이 반듯하게 빠져 있어 책상 배치나 동선 구획이 참 수월합니다.`,
        `실내 메인 공간과 채광, 천장 컨디션입니다. 전체적으로 깔끔하게 관리되어 있어서 입주 시 초기 인테리어 비용과 공사 기간을 크게 아끼실 수 있습니다.`,
        `현장에서 직접 문을 열고 촬영한 내부 모습입니다. 사진으로 보는 것보다 실제 층고와 개방감이 훨씬 좋아서 현장에서 보시면 더욱 마음에 드실 공간입니다.`,
        `내부 바닥과 벽면, 천장 냉난방 설비 등 기본 시설 상태입니다. 별도의 큰 손질 없이 업종에 맞춘 집기류만 세팅해 바로 업무를 시작하시기 좋습니다.`
    ];
    const photo3SubPool = [
        `안쪽 공간과 부대시설, 화장실 및 주차장 여건도 꼼꼼히 확인했습니다. 주차는 [${sp.parking}] 조건이라 대표님과 직원, 방문 차량 모두 편리하게 이용하실 수 있습니다.`,
        `복도와 화장실, 엘리베이터 및 주차 공간 모습입니다. 공용부 관리가 깨끗하게 이루어지고 있으며 주차 동선도 여유롭게 확보되어 있습니다.`,
        `세부 공간 및 주차장 사진입니다. 상가나 사무실을 구할 때 가장 신경 쓰이는 부분이 주차와 공용 시설인데, 이 매물은 그 부분에서 만족도가 높습니다.`,
        `나머지 내부 구석구석과 공용 시설, 주차장까지 살펴보았습니다. 즉시 입주 및 일정 조율이 가능해 원하시는 시기에 맞춰 수월하게 이전하실 수 있습니다.`
    ];

    const photo1Narrative = pick(photo1SubPool, 1);
    const photo2Narrative = pick(photo2SubPool, 2);
    const photo3Narrative = pick(photo3SubPool, 3);

    // Build Plain Text Content (Dual-Monitor Typing Script & Photo Placement Guide)
    const lines = [];
    lines.push(`추천 제목: ${selectedTitle}`);
    lines.push('');

    if (safetyMode === 'dual_guide') {
        // 🖥️ 보조 모니터용 서술형 타이핑 대본 & 📸 사진 넣을 위치 가이드 (기본값)
        lines.push(`━━━ [1단계 : 첫 인사말 & 매물 소개 (보면서 내 말투로 타이핑)] ━━━`);
        lines.push(greetingLine);
        lines.push('');
        lines.push(summaryLine);
        lines.push('');
        if (incPhotoGuide) {
            lines.push(`📸 [사진 넣을 위치 ① : 여기에 건물 외관 · 대로변 · 입구 사진 1~2장을 넣으세요]`);
            lines.push(`📍 [네이버 지도 넣을 위치 : 에디터 상단 '장소(지도)' 버튼 눌러 '${sp.shortLandmark || sp.dong || sp.gu}' 지도 1개 첨부]`);
            lines.push('');
        }
        lines.push(`━━━ [2단계 : 사진 ① 아래에 보면서 타이핑할 입지·교통 설명] ━━━`);
        lines.push(locationLine);
        lines.push('');
        lines.push(photo1Narrative);
        lines.push('');
        if (incPhotoGuide) {
            lines.push(`📸 [사진 넣을 위치 ② : 여기에 내부 메인 홀 · 채광 · 천장 냉난방기 · 인테리어 사진 3~4장을 넣으세요]`);
            lines.push('');
        }
        lines.push(`━━━ [3단계 : 사진 ② 아래에 보면서 타이핑할 내부 컨디션 & 현장 특징] ━━━`);
        lines.push(photo2Narrative);
        lines.push('');
        lines.push(secTitles.feat);
        detailFeatures.forEach((ft) => {
            lines.push(`• ${ft}`);
        });
        lines.push('');
        lines.push(conditionLine);
        lines.push('');
        if (incPhotoGuide) {
            lines.push(`📸 [사진 넣을 위치 ③ : 여기에 룸 공간 · 탕비실 · 복도/화장실 · 주차장 사진 2~3장을 넣으세요]`);
            lines.push('');
        }
        lines.push(`━━━ [4단계 : 사진 ③ 아래에 보면서 타이핑할 부대시설·추천업종·마무리] ━━━`);
        lines.push(photo3Narrative);
        lines.push('');
        lines.push(`• 추천 업종 : ${recBiz}`);
        lines.push('');
        lines.push(closingLine);
        lines.push('');
        lines.push(`==================================================`);
        lines.push(`👇 [여기부터 아래는 직접 타이핑하지 마세요!]`);
        lines.push(`👇 [하단 초록색 버튼 '📌 매물정보 표(18항목) + 중개사 명함 한 번에 복사' 눌러서 Ctrl+V 붙여넣기!]`);
        lines.push(`==================================================`);
        lines.push('');
        lines.push(secTitles.spec);
        lines.push(`• 매물번호 : ${sp.propNo}번`);
        statutoryDisclosureList.forEach(item => {
            lines.push(`• ${item}`);
        });
        lines.push('');
    } else {
        // 🛡️ 핵심 뼈대만 보기 모드
        lines.push(greetingLine);
        lines.push('');
        if (incTypingPrompts) {
            lines.push(`✍️ [직접 타이핑 ① : 오늘 날씨나 현장 다녀온 짧은 인사말 1~2줄을 직접 타이핑해 주세요]`);
            lines.push('');
        }
        lines.push(summaryLine);
        lines.push('');
        if (incPhotoGuide) {
            lines.push('📸 [사진 넣을 위치 ① : 건물 외관이나 대로변·입구 사진 1~2장]');
            lines.push('');
        }
        lines.push(secTitles.feat);
        lines.push('');
        detailFeatures.forEach((ft) => {
            lines.push(`• ${ft}`);
        });
        lines.push('');
        if (incTypingPrompts) {
            lines.push(`✍️ [직접 타이핑 ② : 사진 보시면서 현장에서 느낀 장점(주차, 채광, 내부 구조 등) 2~3줄을 직접 적어주세요]`);
            lines.push('');
        }
        if (incPhotoGuide) {
            lines.push('📸 [사진 넣을 위치 ② : 내부 홀·인테리어·룸·화장실·주차장 사진 4~6장]');
            lines.push('');
        }
        lines.push(secTitles.spec);
        lines.push('');
        lines.push(`• 매물번호 : ${sp.propNo}번`);
        statutoryDisclosureList.forEach(item => {
            lines.push(`• ${item}`);
        });
        lines.push('');
        lines.push(secTitles.rec);
        lines.push('');
        lines.push(`• 추천 업종 : ${recBiz}`);
        lines.push('');
        lines.push(closingLine);
        lines.push('');
    }

    // Homepage guidance according to Link Safety Mode
    const homepageTextLines = [];
    if (linkMode === 'text') {
        homepageTextLines.push('----------------------------------------');
        homepageTextLines.push(`• 본 매물(매물번호 ${sp.propNo}번)의 고화질 전체 사진과 상세 위치 지도는 네이버에서 [ 최가네부동산 ]을 검색하시거나, 인터넷 주소창에 [ choi114.com ] 입력 후 매물번호 [${sp.propNo}]번을 검색하시면 바로 보실 수 있습니다.`);
    } else if (linkMode === 'single') {
        homepageTextLines.push('----------------------------------------');
        homepageTextLines.push(`• 매물번호 ${sp.propNo}번 전체 사진 & 위치 지도 바로보기 :`);
        homepageTextLines.push(`${detailUrl}`);
    }
    homepageTextLines.forEach(l => lines.push(l));

    const legalFooterTextLines = [
        '🏢 최가네부동산공인중개사사무소',
        '• 대표소장 공인중개사 : 최이명',
        '• 대표 상담전화 : 010-3548-4000 / 053-746-7114',
        '• 중개사무소 소재지 : 대구광역시 수성구 수성동1가 72-3번지 (2호선 대구은행역 2번 출구)',
        '• 등록번호 : 제27260-2024-00085호 • 매수신청대리인 등록번호 : 12-25-21'
    ];

    if (incLegalFooter) {
        lines.push('----------------------------------------');
        legalFooterTextLines.forEach(l => lines.push(l));
    }

    lines.push('');
    lines.push(`${hashtagStr}`);

    const plainText = lines.join('\n');

    // Build Clean Table-Only HTML (for [📊 매물정보 표(18항목)만 복사])
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const statutoryTableRowsHtml = [
        `<tr>
          <td style="width:30%;padding:9px 12px;background-color:#f7f7f7;border:1px solid #dedede;color:#333333;font-weight:bold;">매물번호</td>
          <td style="padding:9px 12px;background-color:#ffffff;border:1px solid #dedede;color:#222222;font-weight:bold;">${esc(sp.propNo)}번</td>
        </tr>`,
        ...statutoryDisclosureList.map(item => {
            const colonIdx = item.indexOf(':');
            const k = colonIdx > 0 ? item.slice(0, colonIdx).trim() : '항목';
            const v = colonIdx > 0 ? item.slice(colonIdx + 1).trim() : item;
            return `<tr>
              <td style="width:30%;padding:9px 12px;background-color:#f7f7f7;border:1px solid #dedede;color:#333333;font-weight:bold;">${esc(k)}</td>
              <td style="padding:9px 12px;background-color:#ffffff;border:1px solid #dedede;color:#222222;">${esc(v)}</td>
            </tr>`;
        })
    ].join('\n');

    const tableOnlyHtml = `<table style="width:100%;border-collapse:collapse;margin:10px 0 20px 0;font-size:15px;border:1px solid #dedede;"><tbody>${statutoryTableRowsHtml}</tbody></table>`;
    const tableOnlyText = [`• 매물번호 : ${sp.propNo}번`, ...statutoryDisclosureList.map(item => `• ${item}`)].join('\n');

    // Build Legal Footer Only HTML & Text
    const footerOnlyText = legalFooterTextLines.join('\n');
    const footerOnlyHtml = [
        `<p><b>🏢 최가네부동산공인중개사사무소</b></p>`,
        `<p>• 대표소장 공인중개사 : 최이명</p>`,
        `<p>• 대표 상담전화 : <b>010-3548-4000</b> / 053-746-7114</p>`,
        `<p>• 중개사무소 소재지 : 대구광역시 수성구 수성동1가 72-3번지 (2호선 대구은행역 2번 출구)</p>`,
        `<p>• 등록번호 : 제27260-2024-00085호 • 매수신청대리인 등록번호 : 12-25-21</p>`
    ].join('\n');

    // Build [📌 복붙 100% 안전: 매물정보 표(18항목) + 홈페이지 안내 + 중개사 명함] Combined HTML & Text!
    const specAndFooterHtmlParts = [];
    specAndFooterHtmlParts.push(`<p><b>중개대상물 정보</b><br>(포스팅 현시점, 건축물대장상 정보)</p>`);
    specAndFooterHtmlParts.push(tableOnlyHtml);
    specAndFooterHtmlParts.push(`<p><br></p>`);
    if (linkMode === 'text') {
        specAndFooterHtmlParts.push(`<p>----------------------------------------</p>`);
        specAndFooterHtmlParts.push(`<p>• 본 매물(매물번호 ${esc(sp.propNo)}번)의 고화질 전체 사진과 상세 위치 지도는 네이버에서 [ 최가네부동산 ]을 검색하시거나, 인터넷 주소창에 [ choi114.com ] 입력 후 매물번호 [${esc(sp.propNo)}]번을 검색하시면 바로 보실 수 있습니다.</p><p><br></p>`);
    } else if (linkMode === 'single') {
        specAndFooterHtmlParts.push(`<p>----------------------------------------</p>`);
        specAndFooterHtmlParts.push(`<p>• 매물번호 ${esc(sp.propNo)}번 전체 사진 &amp; 위치 지도 바로보기 :<br><a href="${esc(detailUrl)}" target="_blank">${esc(detailUrl)}</a></p><p><br></p>`);
    }
    if (incLegalFooter) {
        specAndFooterHtmlParts.push(`<p>----------------------------------------</p>`);
        specAndFooterHtmlParts.push(footerOnlyHtml);
    }
    const specAndFooterHtml = specAndFooterHtmlParts.join('\n');

    const specAndFooterTextParts = [
        secTitles.spec,
        '',
        tableOnlyText,
        '',
        ...homepageTextLines,
        ...(incLegalFooter ? ['----------------------------------------', ...legalFooterTextLines] : [])
    ];
    const specAndFooterText = specAndFooterTextParts.join('\n');

    return {
        specs: sp,
        titleOptions,
        selectedTitle,
        plainText,
        tableOnlyHtml,
        tableOnlyText,
        footerOnlyHtml,
        footerOnlyText,
        specAndFooterHtml,
        specAndFooterText,
        hashtagStr,
        commaTagStr
    };
}
window.buildNaverBlogContent = buildNaverBlogContent;

function ensureNaverBlogModalInDom() {
    if (document.getElementById('naver-blog-seo-modal')) return;
    const modalWrap = document.createElement('div');
    modalWrap.id = 'naver-blog-seo-modal';
    modalWrap.className = 'fixed inset-0 bg-black/65 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-[9999] hidden';
    modalWrap.innerHTML = `
        <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-4xl w-full p-4 sm:p-6 shadow-2xl border border-slate-200 dark:border-slate-800 max-h-[93vh] overflow-y-auto space-y-3.5">
            <div class="flex items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                <div>
                    <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#03c75a] text-white text-[11px] font-black mb-1">
                        <span>🖥️ 보조모니터 타이핑 대본(사진위치 포함) + 📌 법정 스펙 표·명함 원클릭 복사</span>
                    </div>
                    <h3 class="text-base sm:text-xl font-black text-slate-900 dark:text-white" id="nb-modal-heading">
                        네이버 블로그 지수 100% 보호 (서술형 타이핑 가이드 &amp; 스펙·명함 붙여넣기)
                    </h3>
                    <p class="text-xs text-slate-500 mt-0.5">
                        서술형 문장과 사진 위치는 옆 모니터로 보면서 조금씩 바꿔 타이핑하시고, <b>매물정보 18항목 표 + 중개사 명함 + 태그</b>는 하단 버튼으로 1초 만에 붙여넣으세요!
                    </p>
                </div>
                <button type="button" onclick="closeNaverBlogGeneratorModal()" class="text-slate-400 hover:text-slate-700 p-1 cursor-pointer">
                    <span class="material-symbols-outlined text-2xl">close</span>
                </button>
            </div>

            <!-- 🛡️ 듀얼 모니터 황금 작업 순서 안내 배너 -->
            <div class="bg-amber-50/90 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-xl p-3 text-xs text-amber-950 dark:text-amber-200 space-y-1">
                <div class="font-black text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
                    <span>🖥️ 대표님 전용 듀얼 모니터 블로그 작성 황금 순서 (저품질·유사문서 위험 0%)</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] font-bold leading-snug pt-0.5">
                    <div>1️⃣ <b>서술형 본문 + 사진 배치</b>: 아래 3번 창을 옆 모니터에 띄워놓고 <b>📸 사진 넣을 위치 ①·②·③</b>에 맞춰 사진을 넣으며 내 말투로 조금씩 수정해 타이핑하세요.</div>
                    <div>2️⃣ <b>네이버 지도 1개 첨부</b>: 사진 ① 밑에서 블로그 에디터 상단 <b>[장소(지도)]</b> 버튼으로 매물 동네 지도를 1개 넣으세요.</div>
                    <div>3️⃣ <b>스펙 표(18항목) + 명함 붙여넣기</b>: 본문 타이핑이 끝나면 맨 아래 <b>[📌 매물정보 표(18항목) + 중개사 명함 한 번에 복사]</b> 버튼을 눌러 Ctrl+V 하세요.</div>
                    <div>4️⃣ <b>해시태그 붙여넣기</b>: 4번의 <b>[쉼표(,) 태그 복사]</b> 또는 <b>[#해시태그 복사]</b>를 눌러 태그 입력창에 Ctrl+V 하시면 끝납니다!</div>
                </div>
            </div>

            <!-- 1. Recommended SEO Titles (3 choices) -->
            <div class="bg-emerald-50/70 dark:bg-slate-800/80 border border-emerald-200 dark:border-slate-700 rounded-xl p-3 space-y-1.5">
                <div class="flex items-center justify-between">
                    <span class="text-xs font-extrabold text-emerald-950 dark:text-emerald-300">1. 네이버 블로그 상위노출 추천 제목 3종 (보면서 타이핑하거나 복사 후 단어 1~2개 수정)</span>
                </div>
                <div id="nb-title-options-box" class="space-y-1.5"></div>
            </div>

            <!-- 2. Safety Mode, Link Safety & Options -->
            <div class="bg-slate-50 dark:bg-slate-800/60 p-3 rounded-xl border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-xs font-extrabold text-slate-700 dark:text-slate-200 mr-1">2. 대본 보기 방식:</span>
                        <button type="button" onclick="setNaverBlogSafetyMode('dual_guide')" data-nbsafety="dual_guide" class="px-2.5 py-1.5 rounded-lg bg-[#03c75a] text-white text-xs font-extrabold cursor-pointer">🖥️ 보조모니터 타이핑 대본 + 📸 사진 넣을 위치 안내 (기본)</button>
                        <button type="button" onclick="setNaverBlogSafetyMode('skeleton')" data-nbsafety="skeleton" class="px-2.5 py-1.5 rounded-lg bg-white text-slate-700 border border-slate-300 text-xs font-bold cursor-pointer">🛡️ 짧은 요약 뼈대만 보기</button>
                        <button type="button" onclick="shuffleNaverBlogVariation()" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-extrabold cursor-pointer flex items-center gap-1" title="클릭할 때마다 서술형 대본의 인사말·입지·내부 설명 문장이 새로운 표현으로 바뀝니다">
                            <span>🎲 서술형 문장 표현 새로고침</span>
                        </button>
                    </div>
                </div>
                <div class="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-200 dark:border-slate-700">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-xs font-extrabold text-slate-700 dark:text-slate-200 mr-1">스펙 하단 홈페이지 안내:</span>
                        <button type="button" onclick="setNaverBlogLinkMode('text')" data-nblink="text" class="px-2.5 py-1 rounded-lg bg-[#03c75a] text-white text-[11.5px] font-extrabold cursor-pointer">🛡️ 안전 텍스트 안내 (클릭링크 0개 · 저품질 방지)</button>
                        <button type="button" onclick="setNaverBlogLinkMode('single')" data-nblink="single" class="px-2.5 py-1 rounded-lg bg-white text-slate-700 border border-slate-300 text-[11.5px] font-bold cursor-pointer">🔗 상세 링크 1개만</button>
                        <button type="button" onclick="setNaverBlogLinkMode('none')" data-nblink="none" class="px-2.5 py-1 rounded-lg bg-white text-slate-700 border border-slate-300 text-[11.5px] font-bold cursor-pointer">🚫 홈페이지 언급 안 함</button>
                    </div>
                    <div class="flex flex-wrap items-center gap-3 text-xs font-bold text-slate-700 dark:text-slate-200">
                        <label class="flex items-center gap-1 cursor-pointer">
                            <input type="checkbox" id="nb-opt-photo" checked onchange="refreshNaverBlogModalContent()" class="rounded text-[#03c75a]" />
                            <span>📸 사진·지도 위치 표시</span>
                        </label>
                        <label class="flex items-center gap-1 cursor-pointer">
                            <input type="checkbox" id="nb-opt-m2" checked onchange="refreshNaverBlogModalContent()" class="rounded text-[#03c75a]" />
                            <span>📐 평·㎡ 병기</span>
                        </label>
                        <label class="flex items-center gap-1 cursor-pointer">
                            <input type="checkbox" id="nb-opt-legal" checked onchange="refreshNaverBlogModalContent()" class="rounded text-[#03c75a]" />
                            <span>⚖️ 중개사 명함 포함</span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- 3. Dual-Monitor Narrative Typing Script & Photo Guide -->
            <div class="space-y-1.5">
                <div class="flex items-center justify-between">
                    <label class="text-xs font-extrabold text-slate-800 dark:text-slate-200">3. 🖥️ 보조 모니터용 서술형 타이핑 대본 &amp; 📸 사진 배치 가이드 (이 창을 보면서 조금씩 수정해 타이핑하세요)</label>
                    <span id="nb-char-count-badge" class="text-[11px] font-extrabold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">듀얼모니터 타이핑 가이드</span>
                </div>
                <textarea id="nb-plain-textarea" rows="13" class="w-full rounded-xl border-slate-300 bg-white dark:bg-slate-950 text-xs sm:text-[13px] leading-relaxed font-medium text-slate-800 dark:text-slate-100 p-3.5 focus:ring-[#03c75a] focus:border-[#03c75a]"></textarea>
            </div>

            <!-- 4. Hashtags Box (Ctrl+V Safe) -->
            <div class="bg-slate-50 dark:bg-slate-800/70 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div class="min-w-0 flex-1">
                    <div class="text-[11px] font-extrabold text-slate-500 mb-0.5">4. [붙여넣기 안전 100%] 네이버 블로그 태그 입력창용 추천 해시태그 (18개)</div>
                    <div id="nb-tags-preview" class="text-xs font-bold text-[#03c75a] truncate"></div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button type="button" onclick="copyNaverBlogTags('hash')" class="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 text-xs font-extrabold cursor-pointer">#해시태그 복사</button>
                    <button type="button" onclick="copyNaverBlogTags('comma')" class="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 text-xs font-extrabold cursor-pointer">쉼표(,) 태그 복사</button>
                </div>
            </div>

            <!-- 5. 100% Safe Spec & Legal Footer Paste Buttons -->
            <div class="bg-emerald-50/80 dark:bg-emerald-950/30 p-3 rounded-xl border-2 border-[#03c75a] space-y-2">
                <div class="flex items-center justify-between">
                    <span class="text-xs font-black text-emerald-950 dark:text-emerald-200">5. 📌 [붙여넣기 100% 안전] 숫자·법정 스펙 데이터 (매물정보 18항목 표 + 중개사 명함) 원클릭 복사</span>
                    <span class="text-[11px] font-bold text-emerald-700 dark:text-emerald-300">일일이 치지 말고 Ctrl+V로 붙여넣으세요!</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-12 gap-2">
                    <button type="button" onclick="copyNaverBlogSpecAndFooterHtml()" class="sm:col-span-6 py-3.5 px-3 rounded-xl bg-[#03c75a] hover:bg-[#02b350] text-white font-black text-xs sm:text-[13px] flex items-center justify-center gap-1.5 shadow-md cursor-pointer transition">
                        <span class="material-symbols-outlined text-[19px]">fact_check</span>
                        <span>📌 매물정보 표(18항목) + 중개사 명함 한 번에 복사 (추천)</span>
                    </button>
                    <button type="button" onclick="copyNaverBlogTableOnly()" class="sm:col-span-3 py-3.5 px-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs flex items-center justify-center gap-1 shadow-sm cursor-pointer transition">
                        <span class="material-symbols-outlined text-[17px]">table_chart</span>
                        <span>📊 표(18항목)만 복사</span>
                    </button>
                    <button type="button" onclick="copyNaverBlogFooterOnly()" class="sm:col-span-3 py-3.5 px-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 font-extrabold text-xs flex items-center justify-center gap-1 cursor-pointer transition">
                        <span class="material-symbols-outlined text-[17px]">badge</span>
                        <span>🏢 중개사 명함만 복사</span>
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modalWrap);
}

async function openNaverBlogGeneratorModal(postOrId) {
    ensureNaverBlogModalInDom();
    let targetPost = null;
    if (postOrId && typeof postOrId === 'object') {
        targetPost = postOrId;
    } else if (postOrId) {
        const all = await getPosts();
        targetPost = (all || []).find(p => String(p.id) === String(postOrId));
    } else if (window.__INITIAL_POST__) {
        targetPost = window.__INITIAL_POST__;
    }

    if (!targetPost) {
        alert('매물 정보를 불러올 수 없습니다.');
        return;
    }

    _currentNaverBlogPost = targetPost;
    _currentNaverBlogSelectedTitleIdx = 0;
    _currentNaverBlogVariationSeed = 0;
    const modal = document.getElementById('naver-blog-seo-modal');
    if (modal) modal.classList.remove('hidden');
    refreshNaverBlogModalContent();
}
window.openNaverBlogGeneratorModal = openNaverBlogGeneratorModal;

function closeNaverBlogGeneratorModal() {
    const modal = document.getElementById('naver-blog-seo-modal');
    if (modal) modal.classList.add('hidden');
}
window.closeNaverBlogGeneratorModal = closeNaverBlogGeneratorModal;

function setNaverBlogSafetyMode(mode) {
    _currentNaverBlogSafetyMode = mode;
    document.querySelectorAll('#naver-blog-seo-modal button[data-nbsafety]').forEach(btn => {
        if (btn.getAttribute('data-nbsafety') === mode) {
            btn.className = 'px-2.5 py-1.5 rounded-lg bg-[#03c75a] text-white text-xs font-extrabold cursor-pointer';
        } else {
            btn.className = 'px-2.5 py-1.5 rounded-lg bg-white text-slate-700 border border-slate-300 text-xs font-bold cursor-pointer';
        }
    });
    refreshNaverBlogModalContent();
}
window.setNaverBlogSafetyMode = setNaverBlogSafetyMode;

function setNaverBlogLinkMode(mode) {
    _currentNaverBlogLinkMode = mode;
    document.querySelectorAll('#naver-blog-seo-modal button[data-nblink]').forEach(btn => {
        if (btn.getAttribute('data-nblink') === mode) {
            btn.className = 'px-2.5 py-1 rounded-lg bg-[#03c75a] text-white text-[11.5px] font-extrabold cursor-pointer';
        } else {
            btn.className = 'px-2.5 py-1 rounded-lg bg-white text-slate-700 border border-slate-300 text-[11.5px] font-bold cursor-pointer';
        }
    });
    refreshNaverBlogModalContent();
}
window.setNaverBlogLinkMode = setNaverBlogLinkMode;

function shuffleNaverBlogVariation() {
    _currentNaverBlogVariationSeed = (_currentNaverBlogVariationSeed + 1) % 64;
    refreshNaverBlogModalContent();
    if (typeof showToast === 'function') {
        showToast('🎲 서술형 타이핑 대본의 인사말·입지·내부 설명 문장이 새로운 표현으로 바뀌었습니다!');
    }
}
window.shuffleNaverBlogVariation = shuffleNaverBlogVariation;

function selectNaverBlogTitleIdx(idx) {
    _currentNaverBlogSelectedTitleIdx = idx;
    refreshNaverBlogModalContent();
}
window.selectNaverBlogTitleIdx = selectNaverBlogTitleIdx;

function copySingleNaverBlogTitle(idx, ev) {
    if (ev) ev.stopPropagation();
    if (!_lastGeneratedBlogData || !_lastGeneratedBlogData.titleOptions) return;
    const t = _lastGeneratedBlogData.titleOptions[idx] || _lastGeneratedBlogData.titleOptions[0];
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t);
    }
    if (typeof showToast === 'function') {
        showToast('📌 선택한 네이버 블로그 제목이 복사되었습니다!');
    } else {
        alert('블로그 제목이 복사되었습니다:\n' + t);
    }
}
window.copySingleNaverBlogTitle = copySingleNaverBlogTitle;

function refreshNaverBlogModalContent() {
    if (!_currentNaverBlogPost) return;
    const incTypingPrompts = document.getElementById('nb-opt-typing')?.checked !== false;
    const incPhotoGuide = document.getElementById('nb-opt-photo')?.checked !== false;
    const incM2 = document.getElementById('nb-opt-m2')?.checked !== false;
    const incLegalFooter = document.getElementById('nb-opt-legal')?.checked !== false;

    const gen = buildNaverBlogContent(_currentNaverBlogPost, {
        safetyMode: _currentNaverBlogSafetyMode,
        linkMode: _currentNaverBlogLinkMode,
        incTypingPrompts,
        incPhotoGuide,
        incM2,
        incLegalFooter
    });
    if (!gen) return;
    _lastGeneratedBlogData = gen;

    const titleBox = document.getElementById('nb-title-options-box');
    if (titleBox) {
        const labels = ['A형(지역·평수 정석)', 'B형(핵심스펙 요약)', 'C형(손님 검색형)'];
        titleBox.innerHTML = gen.titleOptions.map((t, idx) => {
            const isSel = idx === _currentNaverBlogSelectedTitleIdx;
            const safeT = String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `
                <div onclick="selectNaverBlogTitleIdx(${idx})" class="flex items-center justify-between gap-2 p-2 rounded-lg border cursor-pointer transition ${isSel ? 'bg-white border-[#03c75a] shadow-2xs' : 'bg-white/60 border-slate-200 hover:border-slate-300'}">
                    <div class="flex items-center gap-2 min-w-0">
                        <input type="radio" name="nb_title_pick" ${isSel ? 'checked' : ''} class="text-[#03c75a]" />
                        <span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 text-[10px] font-black shrink-0">${labels[idx] || '추천'}</span>
                        <span class="text-xs font-extrabold text-slate-900 truncate">${safeT}</span>
                    </div>
                    <button type="button" onclick="copySingleNaverBlogTitle(${idx}, event)" class="px-2.5 py-1 rounded bg-[#03c75a] hover:bg-[#02b350] text-white text-[11px] font-extrabold shrink-0 cursor-pointer">제목 복사</button>
                </div>
            `;
        }).join('');
    }

    const ta = document.getElementById('nb-plain-textarea');
    if (ta) ta.value = gen.plainText;

    const charBadge = document.getElementById('nb-char-count-badge');
    if (charBadge) {
        const len = gen.plainText.length;
        const modeLabel = _currentNaverBlogSafetyMode === 'dual_guide' ? '🖥️ 보조모니터 서술 대본 + 사진가이드' : '🛡️ 요약 뼈대모드';
        charBadge.textContent = `${modeLabel} · ${len.toLocaleString()}자`;
    }

    const tagsEl = document.getElementById('nb-tags-preview');
    if (tagsEl) tagsEl.textContent = gen.hashtagStr;
}
window.refreshNaverBlogModalContent = refreshNaverBlogModalContent;

async function copyNaverBlogSpecAndFooterHtml() {
    if (!_lastGeneratedBlogData) return;
    try {
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
            const htmlBlob = new Blob([_lastGeneratedBlogData.specAndFooterHtml], { type: 'text/html' });
            const textBlob = new Blob([_lastGeneratedBlogData.specAndFooterText], { type: 'text/plain' });
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': htmlBlob,
                    'text/plain': textBlob
                })
            ]);
            if (typeof showToast === 'function') {
                showToast('📌 [매물정보 18항목 표 + 중개사 법정 명함]이 한 번에 복사되었습니다! 서술형 타이핑 아래에 Ctrl+V로 붙여넣으세요.');
            } else {
                alert('📌 [매물정보 18항목 표 + 중개사 법정 명함]이 한 번에 복사되었습니다!\n블로그 에디터 하단에 Ctrl+V로 붙여넣으세요.');
            }
            return;
        }
    } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(_lastGeneratedBlogData.specAndFooterText);
    }
}
window.copyNaverBlogSpecAndFooterHtml = copyNaverBlogSpecAndFooterHtml;

async function copyNaverBlogTableOnly() {
    if (!_lastGeneratedBlogData) return;
    try {
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
            const htmlBlob = new Blob([_lastGeneratedBlogData.tableOnlyHtml], { type: 'text/html' });
            const textBlob = new Blob([_lastGeneratedBlogData.tableOnlyText], { type: 'text/plain' });
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': htmlBlob,
                    'text/plain': textBlob
                })
            ]);
            if (typeof showToast === 'function') {
                showToast('📊 매물정보 표(18개 항목)만 깔끔하게 복사되었습니다! 블로그 본문 원하는 위치에 Ctrl+V로 붙여넣으세요.');
            } else {
                alert('📊 매물정보 표(18개 항목)만 복사되었습니다!\n블로그 에디터 원하는 위치에 Ctrl+V로 붙여넣으세요.');
            }
            return;
        }
    } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(_lastGeneratedBlogData.tableOnlyText);
    }
}
window.copyNaverBlogTableOnly = copyNaverBlogTableOnly;

async function copyNaverBlogFooterOnly() {
    if (!_lastGeneratedBlogData) return;
    try {
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
            const htmlBlob = new Blob([_lastGeneratedBlogData.footerOnlyHtml], { type: 'text/html' });
            const textBlob = new Blob([_lastGeneratedBlogData.footerOnlyText], { type: 'text/plain' });
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': htmlBlob,
                    'text/plain': textBlob
                })
            ]);
            if (typeof showToast === 'function') {
                showToast('🏢 최가네부동산 법정 의무 명시사항(명함 5줄)이 복사되었습니다! 글 맨 끝에 Ctrl+V로 붙여넣으세요.');
            } else {
                alert('🏢 최가네부동산 법정 의무 명시사항(명함 5줄)이 복사되었습니다!');
            }
            return;
        }
    } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(_lastGeneratedBlogData.footerOnlyText);
    }
}
window.copyNaverBlogFooterOnly = copyNaverBlogFooterOnly;

function copyNaverBlogTags(mode = 'hash') {
    if (!_lastGeneratedBlogData) return;
    const str = mode === 'comma' ? _lastGeneratedBlogData.commaTagStr : _lastGeneratedBlogData.hashtagStr;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str);
    }
    if (typeof showToast === 'function') {
        showToast('🏷️ 네이버 블로그 추천 태그 18개가 복사되었습니다!');
    } else {
        alert('추천 태그가 복사되었습니다:\n' + str);
    }
}
window.copyNaverBlogTags = copyNaverBlogTags;



