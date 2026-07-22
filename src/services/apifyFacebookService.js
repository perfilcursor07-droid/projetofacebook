/**
 * Apify — busca posts públicos do Facebook por keyword (curtidas/comentários).
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

  let publicadoEm = null;
  const ts = raw.timestamp || raw.time || raw.publishedAt || raw.date || raw.createdTime;
  if (ts) {
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    if (!Number.isNaN(d.getTime())) publicadoEm = d;
  }

  const autor =
    textoLimpo(
      raw.author ||
        raw.userName ||
        raw.pageName ||
        raw.page_name ||
        raw.user?.name ||
        raw.owner?.name ||
        ''
    ) || null;

  return {
    url: url ? String(url) : null,
    texto: texto || null,
    autor,
    likes,
    comments,
    shares,
    publicadoEm,
  };
}

function buildActorInput(termo, limit) {
  const actor = String(env.apifyFbSearchActor || '');
  // scrapeforge/facebook-search-posts
  if (actor.includes('scrapeforge')) {
    return {
      query: termo,
      search_type: 'posts',
      max_results: limit,
    };
  }
  // api-empire / scrapier style
  if (actor.includes('api-empire') || actor.includes('scrapier')) {
    return {
      searchQueries: [termo],
      maxPosts: limit,
      resultsLimit: limit,
    };
  }
  // easyapi
  if (actor.includes('easyapi')) {
    return {
      searchQuery: termo,
      maxResults: limit,
    };
  }
  // genérico
  return {
    query: termo,
    searchQuery: termo,
    searchQueries: [termo],
    max_results: limit,
    maxResults: limit,
    maxPosts: limit,
  };
}

/**
 * @param {string} termo
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ url, texto, autor, likes, comments, shares, publicadoEm }>>}
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
  const client = new ApifyClient({ token: env.apifyToken });
  const actorId = env.apifyFbSearchActor;

  try {
    const run = await client.actor(actorId).call(buildActorInput(keyword, limit), {
      waitSecs: 120,
      memory: 1024,
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit });
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
      /credit|quota|limit|payment|402/i.test(message) ? 402 : err.status || 502;
    throw out;
  }
}

module.exports = {
  isConfigured,
  buscarPostsPorTermo,
  normalizarPost,
};
