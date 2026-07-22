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

module.exports = {
  isConfigured,
  buscarPostsPorTermo,
  normalizarPost,
  montarQueryBrasilGospel,
  extrairHashtags,
};
