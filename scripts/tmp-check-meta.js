const axios = require('axios');

(async () => {
  const url = process.argv[2] || 'https://www.bbc.com/news/articles/cn8nvg7zllxo';
  const res = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    timeout: 20000,
  });
  const html = String(res.data || '');
  for (const re of [
    /<meta[^>]+og:site_name[^>]*>/gi,
    /<meta[^>]+application-name[^>]*>/gi,
    /"publisher"\s*:\s*\{[^}]{0,200}/gi,
  ]) {
    console.log('\n>>>', re);
    console.log((html.match(re) || []).slice(0, 3));
  }
})().catch((e) => console.error(e.message));
