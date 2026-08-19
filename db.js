console.log("Antigravity db.js version: 20260715_v139");
// Force clear localStorage posts cache if version changes to prevent corrupted emoji cache persistence
const APP_VERSION = "20260715_v139";
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

async function getPosts() {
  const config = await loadConfig();
  const hasGit = config.github_token && config.github_owner && config.github_repo;

  let cachedPosts = [];
  try {
    const cached = localStorage.getItem('posts_cache');
    if (cached) cachedPosts = JSON.parse(cached);
  } catch(e) {}

  if (hasGit) {
    try {
      const url = `https://api.github.com/repos/${config.github_owner}/${config.github_repo}/contents/${config.data_file_path}`;
      const getUrl = `${url}?t=${Date.now()}`;
      
      const headers = {
        'Accept': 'application/vnd.github.v3+json'
      };
      if (config.github_token) {
        headers['Authorization'] = `token ${config.github_token}`;
      }
      let res = await fetch(getUrl, { headers });
      
      if (res.ok) {
        const data = await res.json();
        const binaryString = atob(data.content.replace(/\n/g, ''));
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const content = new TextDecoder('utf-8').decode(bytes);
        const remotePosts = JSON.parse(content);

        // Merge any locally saved post created in the last 10 minutes that GitHub API hasn't propagated yet
        if (Array.isArray(cachedPosts) && cachedPosts.length > 0) {
          const remoteIds = new Set(remotePosts.map(p => String(p.id)));
          const now = Date.now();
          for (let cp of cachedPosts) {
            if (cp && cp.id && !remoteIds.has(String(cp.id))) {
              const postAge = now - Number(cp.id);
              if (!isNaN(postAge) && postAge < 600000) {
                remotePosts.unshift(cp);
              }
            }
          }
        }

        localStorage.setItem('posts_cache', JSON.stringify(remotePosts));
        _cachedPosts = remotePosts;
        return remotePosts;
      }
    } catch (e) {
      console.error("Failed to fetch posts from GitHub:", e);
    }
  }

  try {
    const res = await fetch(config.data_file_path + '?t=' + Date.now());
    if (res.ok) {
      const localFilePosts = await res.json();
      if (Array.isArray(cachedPosts) && cachedPosts.length > 0) {
        const localIds = new Set(localFilePosts.map(p => String(p.id)));
        const now = Date.now();
        for (let cp of cachedPosts) {
          if (cp && cp.id && !localIds.has(String(cp.id))) {
            const postAge = now - Number(cp.id);
            if (!isNaN(postAge) && postAge < 600000) {
              localFilePosts.unshift(cp);
            }
          }
        }
      }
      localStorage.setItem('posts_cache', JSON.stringify(localFilePosts));
      _cachedPosts = localFilePosts;
      return localFilePosts;
    }
  } catch (e) {
    console.error("Failed to fetch local posts.json:", e);
  }

  if (cachedPosts.length > 0) {
    _cachedPosts = cachedPosts;
    return _cachedPosts;
  }

  _cachedPosts = [];
  return [];
}

async function savePost(postData) {
  const config = await loadConfig();
  const posts = await getPosts();
  let updatedPost = null;

  if (postData.id) {
    const idx = posts.findIndex(p => String(p.id) === String(postData.id));
    if (idx !== -1) {
      posts[idx].title = postData.title;
      posts[idx].category = postData.category;
      posts[idx].content = postData.content;
      posts[idx].address = postData.address;
      posts[idx].coordinates = postData.coordinates;
      if (postData.isPrivate !== undefined) posts[idx].isPrivate = postData.isPrivate === true;
      posts[idx].date = postData.date || posts[idx].date || new Date().toLocaleDateString('ko-KR').replace(/\.$/, "");
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
        const base64Content = btoa(unescape(encodeURIComponent(postsStr)));
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
      const base64Content = btoa(unescape(encodeURIComponent(postsStr)));
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

  posts[idx].isPrivate = !posts[idx].isPrivate;
  const isNowPrivate = posts[idx].isPrivate;

  const postsStr = JSON.stringify(posts, null, 2);
  localStorage.setItem('posts_cache', postsStr);
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

    return `<div class="html-post-container overflow-x-auto text-ink leading-relaxed space-y-2">${styleBlocks}\n${cleanHtml}</div>`;
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
        return `<img src="${cleanUrl}" alt="${altText}" class="max-w-full h-auto rounded-xl shadow-card-soft border border-hairline my-md mx-auto block" />`;
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
        if (host.includes('choi114.com')) return '내부 이동';
        return host.replace('www.', '');
    } catch(e) {
        return '직접 접속 / 카카오톡 링크';
    }
}

function recordPageView() {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        
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
    } catch(e){}
}

function getAnalyticsSummary() {
    try {
        const searchLogs = JSON.parse(localStorage.getItem('analytics_search_logs') || '[]');
        const postViews = JSON.parse(localStorage.getItem('analytics_post_views') || '{}');
        const pageData = JSON.parse(localStorage.getItem('analytics_page_views') || '{"total":0,"today":0}');
        const dailyHistory = JSON.parse(localStorage.getItem('analytics_daily_history') || '{}');

        const todayStr = new Date().toISOString().split('T')[0];
        const datesList = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const ds = d.toISOString().split('T')[0];
            const entry = dailyHistory[ds] || { date: ds, count: 0, referrers: {}, postViews: {} };
            if (ds === todayStr) {
                entry.count = Math.max(entry.count, pageData.today || 0);
            }
            datesList.push({
                date: ds.slice(5),
                fullDate: ds,
                count: entry.count,
                referrers: entry.referrers || {},
                postViews: entry.postViews || {}
            });
        }

        // Helper: Format referrer list for a given referrers map
        const calcReferrers = (refMap, targetTotal = 0) => {
            const mapCopy = { ...refMap };
            let currentSum = 0;
            Object.values(mapCopy).forEach(c => currentSum += (c || 0));

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
            postViewsMap: postViews
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

        localPageData.total = Math.max(localPageData.total || 0, remoteData.totalPageviews || 0);

        if (remoteData.dailyHistory) {
            Object.entries(remoteData.dailyHistory).forEach(([date, dayObj]) => {
                if (!localDaily[date]) {
                    localDaily[date] = dayObj;
                } else {
                    localDaily[date].count = Math.max(localDaily[date].count || 0, dayObj.count || 0);
                    if (dayObj.referrers) {
                        if (!localDaily[date].referrers) localDaily[date].referrers = {};
                        Object.entries(dayObj.referrers).forEach(([src, cnt]) => {
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
        window.location.href = `property-news.html?search=${encodeURIComponent(keyword)}&v=20260715_v139`;
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

