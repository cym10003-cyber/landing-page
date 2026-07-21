console.log("Antigravity db.js version: 20260715_v30");
// Force clear localStorage posts cache if version changes to prevent corrupted emoji cache persistence
const APP_VERSION = "20260715_v30";
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

// Force Vercel redeployment v13
