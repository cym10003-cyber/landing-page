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
      const res = await fetch(url, {
        headers: {
          'Authorization': `token ${config.github_token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Cache-Control': 'no-cache'
        }
      });
      if (res.ok) {
        const data = await res.json();
        const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
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
    let sha = null;
    
    try {
      const getRes = await fetch(url, {
        headers: {
          'Authorization': `token ${config.github_token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Cache-Control': 'no-cache'
        }
      });
      if (getRes.ok) {
        const getData = await getRes.json();
        sha = getData.sha;
      }
    } catch (e) {
      console.warn("Could not retrieve SHA:", e);
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
      throw new Error(`GitHub Save Failed: ${putRes.status} ${errorMsg}`);
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
    let sha = null;
    
    try {
      const getRes = await fetch(url, {
        headers: {
          'Authorization': `token ${config.github_token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Cache-Control': 'no-cache'
        }
      });
      if (getRes.ok) {
        const getData = await getRes.json();
        sha = getData.sha;
      }
    } catch (e) {}

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
  let html = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

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

  return processedBlocks.join('\n');

  function renderInline(text) {
    let parts = text.split('`');
    for (let i = 1; i < parts.length; i += 2) {
      parts[i] = `<code class="bg-surface-container px-xs py-[2px] rounded font-mono text-sm text-error">${parts[i]}</code>`;
    }
    text = parts.join('');

    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.*?)__/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    text = text.replace(/_(.*?)_/g, '<em>$1</em>');
    text = text.replace(/~~(.*?)~~/g, '<del>$1</del>');
    text = text.replace(/\[(.*?)\]\((.*?)\)/g, (match, linkText, url) => safeLink(url, linkText));
    text = text.replace(/\n/g, '<br>');

    return text;
  }
}

function markdownToText(src) {
  if (!src) return '';
  let text = src;
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

window.loadConfig = loadConfig;
window.isAdmin = isAdmin;
window.requireAdmin = requireAdmin;
window.getPosts = getPosts;
window.savePost = savePost;
window.deletePost = deletePost;
window.renderMarkdown = renderMarkdown;
window.markdownToText = markdownToText;
