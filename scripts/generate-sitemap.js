const fs = require('fs');
const path = require('path');

const domain = 'https://choi114.com';
const currentDate = new Date().toISOString().split('T')[0];

const staticPages = [
    { loc: '/', changefreq: 'daily', priority: '1.0' },
    { loc: '/about', changefreq: 'monthly', priority: '0.8' },
    { loc: '/map', changefreq: 'daily', priority: '0.9' },
    { loc: '/news', changefreq: 'daily', priority: '0.8' }
];

try {
    const postsPath = path.join(__dirname, '../data/posts.json');
    let posts = [];
    if (fs.existsSync(postsPath)) {
        posts = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Static pages
    staticPages.forEach(page => {
        xml += `  <url>\n`;
        xml += `    <loc>${domain}${page.loc}</loc>\n`;
        xml += `    <lastmod>${currentDate}</lastmod>\n`;
        xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
        xml += `    <priority>${page.priority}</priority>\n`;
        xml += `  </url>\n`;
    });

    // Dynamic posts
    posts.forEach(post => {
        // Date parsing
        let postDate = currentDate;
        if (post.date) {
            // "2026. 07. 08" -> "2026-07-08"
            const parts = post.date.split('.').map(p => p.trim());
            if (parts.length === 3) {
                postDate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
            }
        }

        xml += `  <url>\n`;
        xml += `    <loc>${domain}/news-detail?id=${post.id}</loc>\n`;
        xml += `    <lastmod>${postDate}</lastmod>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.7</priority>\n`;
        xml += `  </url>\n`;
    });

    xml += '</urlset>\n';

    const sitemapPath = path.join(__dirname, '../sitemap.xml');
    fs.writeFileSync(sitemapPath, xml, 'utf8');
    console.log('Sitemap generated successfully at sitemap.xml');
} catch (e) {
    console.error('Failed to generate sitemap:', e);
}
