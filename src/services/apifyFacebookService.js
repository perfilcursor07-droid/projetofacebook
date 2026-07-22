/**
 * Apify — busca posts públicos do Facebook por keyword/hashtag (curtidas/comentários).
 */
const { ApifyClient } = require('apify-client');
const { env } = require('../config/env');

function isConfigured() {
  return Boolean(env.apifyToken);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function textoLimpo(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nomeDeCampo(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return textoLimpo(value);
  }
  if (typeof value === 'object') {
    return textoLimpo(
      value.name ||
        value.full_name ||
        value.fullName ||
        value.username ||
        value.userName ||
        value.title ||
        value.text ||
        ''
    );
  }
  return '';
}

function extrairHashtags(texto) {
  const found = String(texto || '').match(/#[\wÀ-ÿ]+/gi) || [];
  const uniq = [];
  const seen = new Set();
  for (const h of found) {
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(h);
    if (uniq.length >= 12) break;
  }
  return uniq;
}

function parseDataPost(raw) {
  const ts =
    raw.timestamp ||
    raw.time ||
    raw.publishedAt ||
    raw.date ||
    raw.createdTime ||
    raw.created_time ||
    raw.postDate ||
    raw.publish_time;
  if (!ts) return null;
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Normaliza itens de actors diferentes (scrapeforge, easyapi, etc.).
 */
function slugifyFb(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizarPost(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const url =
    raw.url ||
    raw.postUrl ||
    raw.post_url ||
    raw.link ||
    raw.facebookUrl ||
    raw.permalink ||
    null;
  const texto =
    textoLimpo(raw.text || raw.message || raw.postText || raw.content || raw.description || '');
  if (!url && !texto) return null;

  const likes = num(
    raw.likes ??
      raw.likesCount ??
      raw.reactionsCount ??
      raw.reactions_count ??
      raw.reactionCount ??
      raw.reactions?.like ??
      raw.reactions?.total ??
      raw.engagement?.likes
  );
  const comments = num(
    raw.comments ??
      raw.commentsCount ??
      raw.commentCount ??
      raw.comments_count ??
      raw.engagement?.comments
  );
  const shares = num(
    raw.shares ??
      raw.sharesCount ??
      raw.shareCount ??
      raw.shares_count ??
      raw.reshare_count ??
      raw.reshareCount ??
      raw.engagement?.shares
  );

  const publicadoEm = parseDataPost(raw);
  const hashtags = extrairHashtags(texto);

  const autor =
    nomeDeCampo(raw.author) ||
    nomeDeCampo(raw.user) ||
    nomeDeCampo(raw.owner) ||
    nomeDeCampo(raw.page) ||
    nomeDeCampo(raw.userName) ||
    nomeDeCampo(raw.pageName) ||
    nomeDeCampo(raw.page_name) ||
    null;

  const authorUrl =
    (typeof raw.author === 'object' && raw.author
      ? raw.author.url || raw.author.profileUrl || raw.author.profile_url
      : null) ||
    raw.authorUrl ||
    raw.author_url ||
    raw.pageUrl ||
    raw.page_url ||
    raw.userUrl ||
    raw.profileUrl ||
    null;

  return {
    url: url ? String(url) : null,
    texto: texto || null,
    autor,
    authorUrl: authorUrl ? String(authorUrl) : null,
    likes,
    comments,
    shares,
    publicadoEm,
    hashtags,
  };
}

/**
 * Monta query com viés Brasil + gospel; preserva #hashtags do usuário.
 */
function montarQueryBrasilGospel(termo) {
  let q = String(termo || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 100);
  if (!q) q = '#gospel';

  const lower = q
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const soHashtag = /^#[\w]+$/i.test(q.replace(/\s/g, ''));
  const temBrasil = /\bbrasil\b|\bbrazil\b/.test(lower);
  const temGospel =
    /\bgospel\b|\bpastor\b|\bigreja\b|\bfe\b|\bbiblia\b|\bculto\b|\bjesus\b|\bdeus\b|\bevangel|#gospel|#igreja|#pastor|#louvor|#fe\b|#biblia/.test(
      lower
    );

  // Hashtag pura: busca a tag + Brasil (sem diluir demais)
  if (soHashtag) {
    if (!temBrasil) q = `${q} Brasil`;
    return q.trim();
  }

  if (!temGospel) q = `${q} gospel`;
  if (!temBrasil) q = `${q} Brasil`;
  return q.trim();
}

function dataIsoDiasAtras(dias) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

function buildActorInput(termo, limit, opts = {}) {
  const actor = String(env.apifyFbSearchActor || '');
  const query = opts.rawQuery
    ? String(termo || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 120)
    : montarQueryBrasilGospel(termo);
  const locationUid = String(env.apifyFbLocationUid || '').trim();
  const maxAgeDays = Math.min(30, Math.max(1, Number(opts.maxAgeDays) || 7));
  const startDate = dataIsoDiasAtras(maxAgeDays);

  // scrapeforge/facebook-search-posts — recent_posts + start_date cortam matérias antigas
  if (actor.includes('scrapeforge')) {
    const input = {
      query,
      search_type: 'posts',
      max_results: limit,
      recent_posts: true,
      start_date: startDate,
    };
    if (locationUid) input.location_uid = locationUid;
    return input;
  }
  if (actor.includes('api-empire') || actor.includes('scrapier')) {
    return {
      searchQueries: [query],
      maxPosts: limit,
      resultsLimit: limit,
      recentPosts: true,
      startDate,
    };
  }
  if (actor.includes('easyapi')) {
    return {
      searchQuery: query,
      maxResults: limit,
      recentPosts: true,
    };
  }
  return {
    query,
    searchQuery: query,
    searchQueries: [query],
    max_results: limit,
    maxResults: limit,
    maxPosts: limit,
    recent_posts: true,
    recentPosts: true,
    start_date: startDate,
    startDate,
    ...(locationUid ? { location_uid: locationUid, locationUid } : {}),
  };
}

/**
 * @param {string} termo
 * @param {{ limit?: number, maxAgeDays?: number, rawQuery?: boolean }} [opts]
 * @returns {Promise<Array<{ url, texto, autor, likes, comments, shares, publicadoEm, hashtags }>>}
 */
async function buscarPostsPorTermo(termo, opts = {}) {
  if (!isConfigured()) {
    const err = new Error('APIFY_TOKEN não configurada no .env');
    err.status = 503;
    throw err;
  }

  const keyword = String(termo || '').trim();
  if (keyword.length < 2) return [];

  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 8));
  const maxAgeDays = Number(opts.maxAgeDays) || 7;
  const client = new ApifyClient({ token: env.apifyToken });
  const actorId = env.apifyFbSearchActor;

  try {
    const run = await client.actor(actorId).call(
      buildActorInput(keyword, limit, { maxAgeDays, rawQuery: Boolean(opts.rawQuery) }),
      {
        waitSecs: 120,
        memory: 1024,
      }
    );

    const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: Math.min(50, limit * 2) });
    return (items || [])
      .map(normalizarPost)
      .filter(Boolean)
      .slice(0, limit);
  } catch (err) {
    const message =
      err?.message ||
      err?.response?.body?.error?.message ||
      'Falha ao consultar Apify';
    const out = new Error(`Apify: ${message}`);
    out.status =
      /credit|quota|limit|payment|402|1 run per 24h|free tier/i.test(message) ? 402 : err.status || 502;
    throw out;
  }
}

function buildPageActorInput(pageUrl, limit, opts = {}) {
  const actor = String(env.apifyFbPageActor || '');
  const maxAgeDays = Math.min(30, Math.max(1, Number(opts.maxAgeDays) || 14));
  const startDate = dataIsoDiasAtras(maxAgeDays);
  const url = String(pageUrl || '').trim();

  // scrapeforge/facebook-posts-scraper
  if (actor.includes('scrapeforge') && actor.includes('posts-scraper')) {
    return {
      urls: [url],
      max_posts: limit,
      start_date: startDate,
    };
  }
  // apify/facebook-posts-scraper
  if (actor.includes('apify/facebook-posts') || actor.endsWith('facebook-posts-scraper')) {
    return {
      startUrls: [{ url }],
      resultsLimit: limit,
      onlyPostsNewerThan: `${maxAgeDays} days`,
    };
  }
  // scraper_one / genérico
  if (actor.includes('scraper_one') || actor.includes('pageUrls')) {
    return {
      pageUrls: [url],
      resultsLimit: limit,
    };
  }
  return {
    urls: [url],
    startUrls: [{ url }],
    pageUrls: [url],
    max_posts: limit,
    maxPosts: limit,
    resultsLimit: limit,
    start_date: startDate,
    startDate,
  };
}

function handleDaPaginaUrl(pageUrl) {
  try {
    const u = new URL(String(pageUrl || '').trim());
    const id = u.searchParams.get('id');
    if (id) return String(id);
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    if (/^pages$/i.test(parts[0]) && parts.length >= 2) {
      return decodeURIComponent(parts[parts.length - 1]);
    }
    return decodeURIComponent(parts[0]);
  } catch {
    return '';
  }
}

function urlContemHandle(url, handle) {
  const h = String(handle || '')
    .toLowerCase()
    .replace(/^@/, '')
    .trim();
  if (!h || !url) return false;
  const u = String(url).toLowerCase();
  return (
    u.includes(`facebook.com/${h}`) ||
    u.includes(`fb.com/${h}`) ||
    u.includes(`/${h}/`) ||
    u.includes(`/${h}?`) ||
    u.includes(`/${h}&`)
  );
}

function postPareceDaPagina(post, handle, aliases = []) {
  const h = String(handle || '')
    .toLowerCase()
    .replace(/^@/, '')
    .trim();
  if (!h) return false;
  const postUrl = String(post?.url || '');
  const authorUrl = String(post?.authorUrl || '');
  if (urlContemHandle(postUrl, h) || urlContemHandle(authorUrl, h)) return true;

  const autorSlug = slugifyFb(post?.autor);
  const handleSlug = slugifyFb(h);
  if (autorSlug && handleSlug && (autorSlug.includes(handleSlug) || handleSlug.includes(autorSlug))) {
    return true;
  }

  for (const alias of aliases || []) {
    const a = slugifyFb(alias);
    if (!a || a.length < 4) continue;
    if (autorSlug && (autorSlug.includes(a) || a.includes(autorSlug))) return true;
    if (urlContemHandle(postUrl, a) || urlContemHandle(authorUrl, a)) return true;
  }
  return false;
}

/**
 * Posts indexados no Google/Brave com site:facebook.com/{handle}
 * (fallback quando a página é “privada” para o Apify).
 */
async function buscarPostsPaginaViaWeb(pageUrl, opts = {}) {
  const axios = require('axios');
  const handle = handleDaPaginaUrl(pageUrl).replace(/^@/, '').trim();
  if (!handle) return [];
  const limit = Math.min(15, Math.max(1, Number(opts.limit) || 10));
  const q = `site:facebook.com/${handle}`;
  const out = [];
  const seen = new Set();

  function pushResult(r) {
    const link = String(r.link || r.url || '').trim();
    if (!link || !/facebook\.com/i.test(link)) return;
    const key = link.toLowerCase().split(/[?#]/)[0];
    if (seen.has(key)) return;
    // Só links de post/foto/reel dessa página
    if (!postPareceDaPagina({ url: link, autor: handle }, handle)) return;
    if (!/\/(posts|permalink|photos?|videos?|reel|watch|share|photo)/i.test(link) && !/story_fbid|fbid|pfbid/i.test(link)) {
      // homepage da página não conta
      try {
        const path = new URL(link).pathname.replace(/\/+$/, '');
        if (!path || path === `/${handle}`) return;
      } catch {
        /* keep */
      }
    }
    seen.add(key);
    out.push({
      url: link,
      texto: textoLimpo(r.snippet || r.description || r.title || ''),
      autor: handle,
      likes: 0,
      comments: 0,
      shares: 0,
      publicadoEm: r.date ? new Date(r.date) : null,
      hashtags: extrairHashtags(r.snippet || r.title || ''),
      viaWeb: true,
    });
  }

  if (env.braveSearchApiKey && out.length < limit) {
    const tryBrave = async (params) => {
      const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params,
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': env.braveSearchApiKey,
        },
        timeout: 15000,
      });
      return data?.web?.results || [];
    };
    try {
      let results = [];
      try {
        results = await tryBrave({
          q,
          count: Math.min(20, limit + 5),
          country: 'BR',
          search_lang: 'pt',
        });
      } catch (err422) {
        if (err422.response?.status !== 422) throw err422;
        // Plano free / params rejeitados → tenta query mínima
        console.warn(
          '[apify-fb] brave page 422, retry mínimo:',
          err422.response?.data?.error?.detail || err422.message
        );
        results = await tryBrave({ q, count: Math.min(10, limit) });
      }
      for (const r of results) {
        pushResult({
          link: r.url,
          title: r.title,
          snippet: r.description,
          date: r.age || r.page_age,
        });
        if (out.length >= limit) break;
      }
      // Sem site: às vezes o free plan engasga; tenta menção ao handle
      if (!out.length) {
        const alt = await tryBrave({
          q: `"facebook.com/${handle}" OR ${handle} site:facebook.com`,
          count: Math.min(10, limit),
        }).catch(() => []);
        for (const r of alt) {
          pushResult({
            link: r.url,
            title: r.title,
            snippet: r.description,
            date: r.age || r.page_age,
          });
          if (out.length >= limit) break;
        }
      }
    } catch (err) {
      const detail =
        err.response?.data?.error?.detail ||
        err.response?.data?.message ||
        err.message;
      console.warn('[apify-fb] brave page:', detail);
    }
  }

  if (env.serperApiKey && out.length < limit) {
    try {
      const { data } = await axios.post(
        'https://google.serper.dev/search',
        { q, num: Math.min(10, limit), gl: 'br', hl: 'pt-br' },
        {
          headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      for (const r of data?.organic || []) {
        pushResult(r);
        if (out.length >= limit) break;
      }
    } catch (err) {
      console.warn('[apify-fb] serper page:', err.response?.data?.message || err.message);
    }
  }

  // Fallback sem API: DuckDuckGo HTML (quando Brave 422 / Serper sem crédito)
  if (!out.length) {
    try {
      const { data: html } = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
        timeout: 18000,
        responseType: 'text',
      });
      const re =
        /uddg=([^&"]+)|href="(https?:\/\/(?:www\.)?(?:facebook|fb)\.com\/[^"]+)"/gi;
      let m;
      while ((m = re.exec(String(html || ''))) && out.length < limit) {
        let link = '';
        if (m[1]) {
          try {
            link = decodeURIComponent(m[1]);
          } catch {
            link = m[1];
          }
        } else {
          link = m[2] || '';
        }
        if (!link || !/facebook\.com|fb\.com/i.test(link)) continue;
        pushResult({ link, title: '', snippet: '' });
      }
      if (out.length) {
        console.info(`[apify-fb] duckduckgo page: ${out.length} link(s) para @${handle}`);
      }
    } catch (err) {
      console.warn('[apify-fb] duckduckgo page:', err.message);
    }
  }

  return out.slice(0, limit);
}

/**
 * Posts públicos DE UMA página/perfil (não busca keyword no Feed).
 * @returns {Promise<{ posts: Array, handle: string, privateSkipped: boolean, fonte: string }>}
 */
async function buscarPostsDaPagina(pageUrl, opts = {}) {
  const url = String(pageUrl || '').trim();
  if (!/^https?:\/\/[^/]*facebook\.com/i.test(url) && !/^https?:\/\/fb\.com/i.test(url)) {
    const err = new Error('Informe a URL de uma página do Facebook');
    err.status = 400;
    throw err;
  }

  const limit = Math.min(30, Math.max(1, Number(opts.limit) || 15));
  const maxAgeDays = Number(opts.maxAgeDays) || 14;
  const handle = handleDaPaginaUrl(url).toLowerCase();
  const aliases = Array.isArray(opts.aliases)
    ? opts.aliases.map((a) => String(a || '').trim()).filter(Boolean)
    : [];
  // handle "investibr" → alias "investi br"
  if (handle && !/^\d+$/.test(handle)) {
    const spaced = handle.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[.\-_]+/g, ' ');
    if (spaced && spaced !== handle) aliases.push(spaced);
    // investibr → "investi br" heurística comum (marca + br)
    if (/br$/i.test(handle) && handle.length > 4) {
      aliases.push(`${handle.slice(0, -2)} br`, handle.slice(0, -2));
    }
  }
  let posts = [];
  let privateSkipped = false;
  let fonte = 'none';
  let apifyLimited = false;
  let searchRaw = 0;
  // Preferir índice web antes do Apify: páginas “privadas” para o scraper
  // ainda aparecem no Google/Brave e isso não gasta o 1 run/24h do free tier.
  const preferApify = Boolean(opts.preferApify);

  async function tentarWeb() {
    const web = await buscarPostsPaginaViaWeb(url, { limit });
    if (web.length) {
      posts = web;
      fonte = 'web-index';
      return true;
    }
    return false;
  }

  async function tentarApifyPage() {
    if (!isConfigured()) return false;
    const client = new ApifyClient({ token: env.apifyToken });
    const actorId = env.apifyFbPageActor || 'scrapeforge/facebook-posts-scraper';
    try {
      const run = await client.actor(actorId).call(buildPageActorInput(url, limit, { maxAgeDays }), {
        waitSecs: 150,
        memory: 1024,
      });

      const statusMsg = String(run?.statusMessage || run?.status || '');
      if (/free tier|1 run per 24h/i.test(statusMsg) || /ABORT|FAIL/i.test(String(run?.status || ''))) {
        if (/free tier|1 run per 24h/i.test(statusMsg)) {
          apifyLimited = true;
          console.warn('[apify-fb] page scraper limit:', statusMsg);
          return false;
        }
      }

      const { items } = await client
        .dataset(run.defaultDatasetId)
        .listItems({ limit: Math.min(80, limit * 3) });

      let list = (items || []).map(normalizarPost).filter(Boolean);
      if (handle) {
        const filtrados = list.filter((p) => postPareceDaPagina(p, handle, aliases));
        if (filtrados.length) list = filtrados;
      }
      if (list.length) {
        posts = list;
        fonte = 'apify-page';
        return true;
      }
      privateSkipped = true;
      return false;
    } catch (err) {
      const message =
        err?.message ||
        err?.response?.body?.error?.message ||
        'Falha ao consultar Apify (página)';
      if (/credit|quota|limit|payment|402|1 run per 24h|free tier/i.test(message)) {
        apifyLimited = true;
        console.warn('[apify-fb] page scraper limit:', message);
        return false;
      }
      if (/private|not available|no posts/i.test(message)) {
        privateSkipped = true;
        return false;
      }
      console.warn('[apify-fb] page scraper:', message);
      return false;
    }
  }

  async function tentarApifySearchHandle() {
    // Search é outro actor — não bloqueia só porque o page-scraper bateu free tier.
    if (!isConfigured() || !handle) return false;
    const queries = [];
    const pushQ = (q) => {
      const t = String(q || '').trim();
      if (!t || queries.some((x) => x.toLowerCase() === t.toLowerCase())) return;
      queries.push(t);
    };
    pushQ(handle);
    for (const a of aliases) pushQ(a);
    // Nome da página sem espaços colados
    if (handle.length >= 6) pushQ(handle.replace(/br$/i, ' brasil'));

    try {
      let encontrados = [];
      for (const q of queries.slice(0, 2)) {
        const batch = await buscarPostsPorTermo(q, {
          limit: Math.max(limit, 15),
          maxAgeDays,
          rawQuery: true,
        });
        encontrados = encontrados.concat(batch);
        const daPagina = encontrados.filter((p) => postPareceDaPagina(p, handle, aliases));
        if (daPagina.length) {
          posts = daPagina;
          fonte = 'apify-search-handle';
          searchRaw = encontrados.length;
          return true;
        }
        // 1 query já gastou o free tier do search — não dispara segunda se veio vazio de match
        if (batch.length) {
          searchRaw = batch.length;
          break;
        }
      }
      if (searchRaw) {
        console.warn(
          `[apify-fb] search "${handle}": ${searchRaw} post(s) brutos, 0 da página (author.url/url sem match)`
        );
      }
    } catch (err) {
      if (/credit|quota|limit|payment|402|1 run per 24h|free tier/i.test(err.message || '')) {
        apifyLimited = true;
      }
      console.warn('[apify-fb] search handle fallback:', err.message);
    }
    return false;
  }

  if (preferApify) {
    if (!(await tentarApifyPage()) && !(await tentarWeb())) {
      await tentarApifySearchHandle();
    }
  } else {
    if (!(await tentarWeb()) && !(await tentarApifyPage())) {
      await tentarApifySearchHandle();
    }
  }

  return {
    posts: posts.slice(0, limit),
    handle,
    privateSkipped,
    apifyLimited,
    searchRaw,
    fonte,
  };
}

module.exports = {
  isConfigured,
  buscarPostsPorTermo,
  buscarPostsDaPagina,
  buscarPostsPaginaViaWeb,
  postPareceDaPagina,
  slugifyFb,
  normalizarPost,
  montarQueryBrasilGospel,
  extrairHashtags,
  handleDaPaginaUrl,
};
