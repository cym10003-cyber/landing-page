console.log("Antigravity db.js version: 20260715_v7");
// Force clear localStorage posts cache if version changes to prevent corrupted emoji cache persistence
const APP_VERSION = "20260715_v7";
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
  return sessionStorage.getItem('isAdmin') === 'true';
}

function requireAdmin() {
  if (!isAdmin()) {
    window.location.href = 'admin.html';
  }
}

async function getPosts() {
  const config = await loadConfig();
  const hasGit = config.github_token && config.github_owner && config.github_repo;

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
        const posts = JSON.parse(content);
        localStorage.setItem('posts_cache', JSON.stringify(posts));
        _cachedPosts = posts;
        return posts;
      }
    } catch (e) {
      console.error("Failed to fetch posts from GitHub:", e);
    }
  }

  try {
    const res = await fetch(config.data_file_path + '?t=' + Date.now());
    if (res.ok) {
      const posts = await res.json();
      localStorage.setItem('posts_cache', JSON.stringify(posts));
      _cachedPosts = posts;
      return posts;
    }
  } catch (e) {
    console.error("Failed to fetch local posts.json:", e);
  }

  const cached = localStorage.getItem('posts_cache');
  if (cached) {
    try {
      _cachedPosts = JSON.parse(cached);
      return _cachedPosts;
    } catch(e) {}
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
    const getUrl = `${url}?t=${Date.now()}`;
    let sha = null;
    let getStatus = 0;
    let getResponseInfo = "";
    
    try {
      const headers = {
        'Accept': 'application/vnd.github.v3+json'
      };
      if (config.github_token) {
        headers['Authorization'] = `token ${config.github_token}`;
      }
      let getRes = await fetch(getUrl, { headers });
      
      getStatus = getRes.status;
      if (getRes.ok) {
        const getData = await getRes.json();
        if (Array.isArray(getData)) {
          getResponseInfo = "directory_list";
        } else {
          sha = getData.sha;
          getResponseInfo = `file_sha_${sha ? "present" : "absent"}_keys_${Object.keys(getData).join(",")}`;
        }
      } else {
        getResponseInfo = `status_${getRes.status}`;
        if (getRes.status !== 404) {
          throw new Error(`Failed to fetch file metadata (Status: ${getRes.status})`);
        }
      }
    } catch (e) {
      throw new Error(`GitHub Connection Error (SHA Fetch): ${e.message} (URL: ${getUrl})`);
    }

    const base64Content = btoa(unescape(encodeURIComponent(postsStr)));
    
    const body = {
      message: postData.id ? `feat: update post ${postData.id}` : `feat: add new post`,
      content: base64Content,
      branch: 'main'
    };
    if (sha) body.sha = sha;

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
      throw new Error(`GitHub Save Failed: ${putRes.status} ${errorMsg} (Diagnostics: GET_status=${getStatus}, GET_info=${getResponseInfo}, path=${config.data_file_path}, owner/repo=${config.github_owner}/${config.github_repo})`);
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

function renderMarkdown(src) {
  if (!src) return '';
  
  // Convert GitHub raw URLs to high-speed jsDelivr CDN URLs for ultra-fast asset loading
  let convertedSrc = src.replace(/raw\.githubusercontent\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/main\//g, 'cdn.jsdelivr.net/gh/$1/$2@main/');

  let html = convertedSrc
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // Restore safe <video> tags securely
  html = html.replace(/&lt;video\s+([\s\S]*?)&gt;&lt;\/video&gt;/gi, (match, attrsHtml) => {
    const srcMatch = attrsHtml.match(/src=&quot;([^&]+?)&quot;/i);
    const classMatch = attrsHtml.match(/class=&quot;([^&]+?)&quot;/i);
    const controls = attrsHtml.toLowerCase().includes('controls');
    const autoplay = attrsHtml.toLowerCase().includes('autoplay');
    const loop = attrsHtml.toLowerCase().includes('loop');
    const muted = attrsHtml.toLowerCase().includes('muted');
    const playsinline = attrsHtml.toLowerCase().includes('playsinline');
    
    if (srcMatch) {
      const src = srcMatch[1].trim();
      if (/^(https?:\/\/|\/)/i.test(src)) {
        const cls = classMatch ? classMatch[1] : 'w-full rounded-xl overflow-hidden shadow-card-soft border border-hairline my-lg';
        let videoTag = `<video src="${src}"`;
        if (controls) videoTag += ' controls';
        if (autoplay) videoTag += ' autoplay';
        if (loop) videoTag += ' loop';
        if (muted) videoTag += ' muted';
        if (playsinline) videoTag += ' playsinline';
        videoTag += ` class="${cls}"></video>`;
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

    const imgPlaceholders = [];
    const linkPlaceholders = [];

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
        try {
          const base64Content = dataUrl.split(',')[1];
          const rand = Math.random().toString(36).substring(2, 6);
          const filename = `post_img_${Date.now()}_${rand}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
          const url = `https://api.github.com/repos/${config.github_owner}/landing-page-assets/contents/images/${filename}`;
          
          const body = {
            message: `feat: upload image ${filename}`,
            content: base64Content,
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
            throw new Error(`GitHub Upload Failed: ${putRes.status} ${errorMsg}`);
          }
          
          const rawUrl = `https://cdn.jsdelivr.net/gh/${config.github_owner}/landing-page-assets@main/images/${filename}`;
          resolve(rawUrl);
        } catch (err) {
          reject(err);
        }
      } else {
        // Local Fallback: return base64 Data URL directly
        resolve(dataUrl);
      }
    };
    reader.onerror = (error) => reject(error);
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
        try {
          const base64Content = dataUrl.split(',')[1];
          const rand = Math.random().toString(36).substring(2, 6);
          const filename = `post_vid_${Date.now()}_${rand}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
          const url = `https://api.github.com/repos/${config.github_owner}/landing-page-assets/contents/videos/${filename}`;
          
          const body = {
            message: `feat: upload video ${filename}`,
            content: base64Content,
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
            throw new Error(`GitHub Upload Failed: ${putRes.status} ${errorMsg}`);
          }
          
          const rawUrl = `https://cdn.jsdelivr.net/gh/${config.github_owner}/landing-page-assets@main/videos/${filename}`;
          resolve(rawUrl);
        } catch (err) {
          reject(err);
        }
      } else {
        // Local Fallback: return base64 Data URL directly
        resolve(dataUrl);
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

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
