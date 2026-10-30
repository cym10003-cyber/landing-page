console.log("Antigravity db.js version: 20260715_v220");
// Force clear localStorage posts cache if version changes to prevent corrupted emoji cache persistence
const APP_VERSION = "20260715_v220";
if (localStorage.getItem('app_version') !== APP_VERSION) {
  localStorage.removeItem('posts_cache');
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

    // Merge any locally saved or edited post from the last 30 minutes that GitHub CDN hasn't propagated yet
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
        // If locally edited within last 30 min or matches latestSaved, merge local edits onto remote object
        if (latestSaved && String(latestSaved.id) === cpId) {
          remotePosts[idx] = { ...remotePosts[idx], ...latestSaved };
        } else if (cp.updatedAt && (now - cp.updatedAt < 1800000)) {
          remotePosts[idx] = { ...remotePosts[idx], ...cp };
        } else if (typeof cp.isPrivate !== 'undefined' && cp.isPrivate !== remotePosts[idx].isPrivate) {
          remotePosts[idx].isPrivate = cp.isPrivate;
        }
      } else {
        // Brand new post created locally in last 30 min
        const postAge = now - Number(cp.id);
        if (!isNaN(postAge) && postAge < 1800000) {
          remotePosts.unshift(cp);
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
              const rawUrl = `https://cdn.jsdelivr.net/gh/${config.github_owner}/landing-page-assets@main/images/${filename}`;
              try {
                fetch(`https://purge.jsdelivr.net/gh/${config.github_owner}/landing-page-assets@main/images/${filename}`).catch(() => {});
              } catch (e) {}
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

function recordPageView() {
    try {
        const todayStr = getKSTDateStr();
        
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
            dailyHistory[todayStr] = { date: todayStr, count: 0, referrers: {}, postViews: {} };
        }
        dailyHistory[todayStr].count += 1;

        const source = getReferrerSource();
        if (source !== '내부 이동') {
            if (!dailyHistory[todayStr].referrers) dailyHistory[todayStr].referrers = {};
            dailyHistory[todayStr].referrers[source] = (dailyHistory[todayStr].referrers[source] || 0) + 1;
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
            body: JSON.stringify({ type: 'pageview', referrer: source })
        }).catch(() => {});
    } catch(e){}
}

try {
    recordPageView();
} catch(e){}

function recordSearchQuery(query) {
    if (!query || typeof query !== 'string') return;
    const cleanQ = query.trim();
    if (cleanQ.length < 2) return;
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const logs = JSON.parse(localStorage.getItem('analytics_search_logs') || '[]');
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const logObj = {
            query: cleanQ,
            device: isMobile ? 'mobile' : 'desktop',
            timestamp: Date.now(),
            date: new Date().toLocaleString('ko-KR'),
            dateKey: todayStr
        };
        logs.unshift(logObj);
        if (logs.length > 500) logs.pop();
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
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        
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
            dailyHistory[todayStr] = { date: todayStr, count: 0, referrers: {}, postViews: {} };
        }
        if (!dailyHistory[todayStr].postViews) dailyHistory[todayStr].postViews = {};
        
        dailyHistory[todayStr].postViews[postId] = (dailyHistory[todayStr].postViews[postId] || 0) + 1;
        localStorage.setItem('analytics_daily_history', JSON.stringify(dailyHistory));

        // Sync postview to server for unified cross-device analytics
        fetch('/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'postview', postId, postTitle })
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
                referrers: entry.referrers || {},
                postViews: entry.postViews || {}
            });
        }

        // Helper: Format referrer list for a given referrers map
        const calcReferrers = (refMap, targetTotal = 0) => {
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

            if (targetTotal > currentSum) {
                const diff = targetTotal - currentSum;
                const directKey = '직접 접속 / 카카오톡 링크';
                mapCopy[directKey] = (mapCopy[directKey] || 0) + diff;
                currentSum = targetTotal;
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

        // Today Referrers
        const todayEntry = dailyHistory[todayStr] || { count: pageData.today || 0, referrers: {}, postViews: {} };
        const todayVisitCount = Math.max(pageData.today || 0, todayEntry.count || 0);
        const topReferrersToday = calcReferrers(todayEntry.referrers || {}, todayVisitCount);

        // Recent 7 Days Referrers
        const ref7Map = {};
        datesList.forEach(d => {
            if (d.referrers) {
                Object.entries(d.referrers).forEach(([src, count]) => {
                    ref7Map[src] = (ref7Map[src] || 0) + count;
                });
            }
        });
        const topReferrers7Days = calcReferrers(ref7Map, total7DaysVisits);

        // Today Top Views
        const todayPostViewsMap = todayEntry.postViews || {};
        const todayTopViews = Object.entries(todayPostViewsMap)
            .map(([id, count]) => ({
                id,
                title: postViews[id] ? postViews[id].title : '매물 상세',
                count
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const qCounts = {};
        let mobileCount = 0;
        let desktopCount = 0;

        searchLogs.forEach(log => {
            qCounts[log.query] = (qCounts[log.query] || 0) + 1;
            if (log.device === 'mobile') mobileCount++;
            else desktopCount++;
        });

        const topQueries = Object.entries(qCounts)
            .map(([query, count]) => ({ query, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const topViews = Object.values(postViews)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        return {
            searchLogs,
            topQueries,
            topViews,
            todayTopViews,
            recent7Days: datesList,
            topReferrers: topReferrersAll,
            topReferrersToday,
            topReferrers7Days,
            dailyHistory,
            totalSearches: searchLogs.length,
            mobileCount,
            desktopCount,
            totalPageviews: pageData.total || 0,
            todayPageviews: pageData.today || 0,
            postViewsMap: postViews,
            likes: (remoteData && remoteData.likes) ? remoteData.likes : {},
            totalLikes: (remoteData && remoteData.totalLikes) ? remoteData.totalLikes : 0,
            recentLikes: (remoteData && remoteData.recentLikes) ? remoteData.recentLikes : []
        };
    } catch(e) {
        return { searchLogs: [], topQueries: [], topViews: [], todayTopViews: [], recent7Days: [], topReferrers: [], topReferrersToday: [], topReferrers7Days: [], dailyHistory: {}, totalSearches: 0, mobileCount: 0, desktopCount: 0, totalPageviews: 0, todayPageviews: 0, postViewsMap: {} };
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

        if (isAdmin() && config.github_token && config.github_owner && config.github_repo) {
            pushAnalyticsToGithub(config, {
                totalPageviews: localPageData.total,
                todayPageviews: localPageData.today,
                dailyHistory: localDaily,
                searchLogs: localLogs.slice(0, 100),
                postViews: localViews
            });
        }
    } catch(e) {}
}

async function pushAnalyticsToGithub(config, analyticsObj) {
    try {
        const path = 'data/analytics.json';
        const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/${path}`;
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
            message: 'stat: sync multi-device analytics data',
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
                <button id="lead-tab-buyer" type="button" onclick="switchLeadTab('buyer')" class="flex-1 py-2 border-b-2 border-[#003891] text-[#003891] dark:text-blue-400 font-bold cursor-pointer text-xs sm:text-sm">🔍 매물 구해요 (손님)</button>
                <button id="lead-tab-seller" type="button" onclick="switchLeadTab('seller')" class="flex-1 py-2 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer text-xs sm:text-sm">🏢 매물 내놓습니다 (건물주/임차인)</button>
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
                <div class="grid grid-cols-2 gap-2 sm:gap-3">
                    <div>
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200" id="lead-pyeong-label">희망 평수</label>
                        <input type="text" id="lead-pyeong" placeholder="예: 50평대" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
                    </div>
                    <div>
                        <label class="block font-bold mb-0.5 text-xs sm:text-sm text-slate-800 dark:text-slate-200" id="lead-budget-label">예산 / 임대조건</label>
                        <input type="text" id="lead-budget" placeholder="예: 보증금 5천/월 300" class="w-full p-1.5 sm:p-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#142654]">
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
    } else {
        hiddenInput.value = 'buyer';
        tabBuyer.className = 'flex-1 py-2 sm:py-2.5 border-b-2 border-[#003891] text-[#003891] dark:text-blue-400 font-bold cursor-pointer';
        tabSeller.className = 'flex-1 py-2 sm:py-2.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer';
        if (catLabel) catLabel.textContent = '매물 종류';
        if (indContainer) indContainer.style.display = 'block';
        if (locLabel) locLabel.textContent = '희망 지역 / 희망 위치';
        if (floorLabel) floorLabel.textContent = '희망 층수 (중복 선택 가능)';
        if (pyeongLabel) pyeongLabel.textContent = '희망 평수';
        if (budgetLabel) budgetLabel.textContent = '예산 / 임대조건';
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
    if (window.location.pathname.includes('admin.html')) return;
    if (document.getElementById('mobile-bottom-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'mobile-bottom-bar';
    bar.className = 'lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#07102b]/95 backdrop-blur border-t border-[#1d3870] px-2 py-2 flex items-center justify-around text-white shadow-2xl pb-safe no-print';
    bar.innerHTML = `
        <a href="tel:010-3548-4000" class="flex flex-col items-center justify-center text-xs text-amber-400 hover:text-amber-300 font-bold px-2 py-1">
            <span class="material-symbols-outlined text-xl">call</span>
            <span>전화 상담</span>
        </a>
        <button onclick="showLeadForm('buyer')" class="flex flex-col items-center justify-center text-xs text-blue-300 hover:text-white font-medium px-2 py-1">
            <span class="material-symbols-outlined text-xl">edit_note</span>
            <span>매물 의뢰</span>
        </button>

        <a href="map.html" class="flex flex-col items-center justify-center text-xs text-slate-300 hover:text-white font-medium px-2 py-1">
            <span class="material-symbols-outlined text-xl">map</span>
            <span>매물 지도</span>
        </a>
    `;
    document.body.appendChild(bar);
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
        window.location.href = `property-news.html?search=${encodeURIComponent(keyword)}&v=20260715_v220`;
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
                        <li><b>직접 수집 항목</b>: 성명(상호명), 연락처(전화번호), 매물 종류, 희망 업종, 매물/희망 위치, 층수, 희망 평수, 예산/임대조건, 세부 요청사항</li>
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

    // 1. Floating Pill Widget Button
    const bar = document.createElement('div');
    bar.id = 'floating-quick-bar';
    bar.className = 'fixed bottom-20 right-3.5 md:bottom-8 md:right-8 z-40 flex items-center gap-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md px-3.5 py-2.5 rounded-full shadow-xl border border-slate-200 dark:border-slate-700 hover:scale-105 active:scale-95 transition-all cursor-pointer no-print select-none';
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
                <a href="property-news.html?v=20260715_v220" onclick="closeQuickBarModal()" class="mt-2 px-5 py-2.5 rounded-xl bg-[#003891] text-white font-bold text-xs shadow-md no-underline hover:bg-blue-800 transition-all">
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
                <a href="property-news.html?v=20260715_v220" onclick="closeQuickBarModal()" class="mt-2 px-5 py-2.5 rounded-xl bg-[#003891] text-white font-bold text-xs shadow-md no-underline hover:bg-blue-800 transition-all">
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
