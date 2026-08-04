/* eslint-disable no-console */
require('dotenv').config();
const axios = require('axios');

const URL_TESTE = process.argv[2] || 'https://www.bbc.com/news/articles/cn8nvg7zllxo';

(async () => {
  const res = await axios.get(URL_TESTE, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    },
    timeout: 20000,
  });
  const html = String(res.data || '');
  console.log('html len', html.length);

  // conta <p>
  const ps = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
  console.log('tags <p>:', ps.length);
  const limpos = ps
    .map((p) => p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 40);
  console.log('paragrafos >=40:', limpos.length, 'total chars:', limpos.join(' ').length);
  console.log(limpos.slice(0, 30).map((t, i) => `${i + 1}. ${t.slice(0, 120)}`).join('\n'));

  // JSON-LD articleBody?
  const blocos = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  console.log('\nld+json blocos:', blocos.length);
  for (const b of blocos) {
    const json = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const obj = JSON.parse(json);
      console.log('tipo:', obj['@type'], 'articleBody len:', String(obj.articleBody || '').length, 'publisher:', obj.publisher?.name);
    } catch (e) {
      console.log('ld json invalido', e.message);
    }
  }

  // __NEXT_DATA__ / preload state?
  console.log('\ntem __NEXT_DATA__:', /__NEXT_DATA__/.test(html));
  console.log('tem window.__INITIAL_DATA__:', /__INITIAL_DATA__/.test(html));
  const m = html.match(/window\.__INITIAL_DATA__\s*=\s*"/);
  console.log('initial data match:', Boolean(m));
})();
