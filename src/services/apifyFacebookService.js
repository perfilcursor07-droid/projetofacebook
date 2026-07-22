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

  return {
    url: url ? String(url) : null,
    texto: texto || null,
    autor,
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
  const query = montarQueryBrasilGospel(termo);
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
 * @param {{ limit?: number, maxAgeDays?: number }} [opts]
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
    const run = await client.actor(actorId).call(buildActorInput(keyword, limit, { maxAgeDays }), {
      waitSecs: 120,
      memory: 1024,
    });

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

/**
 * Posts públicos DE UMA página/perfil (não busca keyword no Feed).
 * @param {string} pageUrl
 * @param {{ limit?: number, maxAgeDays?: number }} [opts]
 */
async function buscarPostsDaPagina(pageUrl, opts = {}) {
  if (!isConfigured()) {
    const err = new Error('APIFY_TOKEN não configurada no .env');
    err.status = 503;
    throw err;
  }

  const url = String(pageUrl || '').trim();
  if (!/^https?:\/\/[^/]*facebook\.com/i.test(url) && !/^https?:\/\/fb\.com/i.test(url)) {
    const err = new Error('Informe a URL de uma página do Facebook');
    err.status = 400;
    throw err;
  }

  const limit = Math.min(30, Math.max(1, Number(opts.limit) || 15));
  const maxAgeDays = Number(opts.maxAgeDays) || 14;
  const client = new ApifyClient({ token: env.apifyToken });
  const actorId = env.apifyFbPageActor || 'scrapeforge/facebook-posts-scraper';
  const handle = handleDaPaginaUrl(url).toLowerCase();

  try {
    const run = await client.actor(actorId).call(buildPageActorInput(url, limit, { maxAgeDays }), {
      waitSecs: 150,
      memory: 1024,
    });

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems({ limit: Math.min(80, limit * 3) });

    let posts = (items || []).map(normalizarPost).filter(Boolean);

    // Garante que o post é da página (URL ou autor)
    if (handle) {
      const filtrados = posts.filter((p) => {
        const postUrl = String(p.url || '').toLowerCase();
        const autor = String(p.autor || '').toLowerCase();
        if (postUrl.includes(`facebook.com/${handle}`) || postUrl.includes(`/${handle}/`)) {
          return true;
        }
        // Alguns actors devolvem só permalink com id; mantém se autor bate com handle
        if (autor && (autor.includes(handle) || handle.includes(autor.replace(/\s+/g, '')))) {
          return true;
        }
        // Se a URL do post não tem path de outra página conhecida, mantém (dataset já veio da página)
        return !/facebook\.com\/[a-z0-9.\-_]+\/(posts|photos|videos|reel)/i.test(postUrl) ||
          postUrl.includes(handle);
      });
      // Se o filtro zerou tudo (formato estranho do actor), usa a lista original
      if (filtrados.length) posts = filtrados;
    }

    return posts.slice(0, limit);
  } catch (err) {
    const message =
      err?.message ||
      err?.response?.body?.error?.message ||
      'Falha ao consultar Apify (página)';
    const out = new Error(`Apify página: ${message}`);
    out.status =
      /credit|quota|limit|payment|402|1 run per 24h|free tier/i.test(message) ? 402 : err.status || 502;
    throw out;
  }
}

module.exports = {
  isConfigured,
  buscarPostsPorTermo,
  buscarPostsDaPagina,
  normalizarPost,
  montarQueryBrasilGospel,
  extrairHashtags,
  handleDaPaginaUrl,
};
