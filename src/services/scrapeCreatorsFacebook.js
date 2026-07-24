const axios = require('axios');
const { env } = require('../config/env');

const POSTS_URL = 'https://api.scrapecreators.com/v1/facebook/profile/posts';

function isConfigured() {
  return Boolean(env.scrapeCreatorsApiKey);
}

function normalizarData(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function tituloDoTexto(texto, fallback) {
  const primeiraLinha = String(texto || '')
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .find(Boolean);
  return String(primeiraLinha || fallback || 'Post do Facebook').slice(0, 120);
}

function normalizarItem(item) {
  if (!item || typeof item !== 'object') return null;
  const url = String(item.url || item.permalink || '').trim();
  const id = String(item.id || '').trim();
  if (!url && !id) return null;

  const texto = typeof item.text === 'string' ? item.text.trim() : '';
  const video = item.videoDetails || {};
  const isVideo = Boolean(video.sdUrl || video.hdUrl || /\/(reel|videos)\//i.test(url));
  const thumbnail =
    video.thumbnailUrl ||
    item.image ||
    item.thumbnail ||
    item.photo?.image?.uri ||
    null;

  return {
    externalId: id || url,
    mediaType: isVideo ? 'video' : 'image',
    titulo: tituloDoTexto(texto, 'Post do Facebook'),
    url: url || `https://www.facebook.com/${id}`,
    resumo: texto ? texto.slice(0, 400) : null,
    thumbnail: thumbnail || null,
    publicadoEm: normalizarData(item.publishTime),
  };
}

/** Formato do Radar Face (engajamento real). */
function normalizarPostRadar(item, pageUrl) {
  if (!item || typeof item !== 'object') return null;
  const url = String(item.url || item.permalink || '').trim();
  const id = String(item.id || '').trim();
  if (!url && !id) return null;

  const texto = typeof item.text === 'string' ? item.text.trim() : '';
  const author = item.author && typeof item.author === 'object' ? item.author : {};
  const handle = (() => {
    try {
      const parts = new URL(String(pageUrl || '')).pathname.split('/').filter(Boolean);
      return parts[0] || '';
    } catch {
      return '';
    }
  })();

  return {
    url: url || (id ? `https://www.facebook.com/${id}` : null),
    texto: texto || null,
    autor: String(author.short_name || author.name || handle || 'Facebook').trim(),
    authorUrl: author.url || (handle ? `https://www.facebook.com/${handle}` : null),
    likes: Number(item.reactionCount) || 0,
    comments: Number(item.commentCount) || 0,
    shares: Number(item.shareCount || item.reshareCount) || 0,
    publicadoEm: normalizarData(item.publishTime),
    hashtags: (texto.match(/#[\wÀ-ÿ]+/gi) || []).slice(0, 12),
    viaScrapeCreators: true,
  };
}

async function fetchPostsPage(params) {
  const response = await axios.get(POSTS_URL, {
    params,
    headers: {
      'x-api-key': env.scrapeCreatorsApiKey,
      Accept: 'application/json',
    },
    timeout: 45000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const message =
      response.data?.message ||
      response.data?.error ||
      response.data?.detail ||
      `HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }

  if (response.data?.success === false) {
    const message = response.data?.message || response.data?.error || 'falha desconhecida';
    const err = new Error(message);
    err.status = 502;
    throw err;
  }

  return response.data || {};
}

/**
 * Posts da página com curtidas/comentários (ScrapeCreators).
 * API devolve ~3 posts por request; usa cursor para paginar.
 */
async function listarPostsPerfilRadar(pageUrl, opts = {}) {
  if (!isConfigured()) {
    throw new Error('SCRAPECREATORS_API_KEY não configurada');
  }

  const url = String(pageUrl || '').trim();
  if (!url) throw new Error('URL da página do Facebook inválida');

  const limit = Math.min(30, Math.max(1, Number(opts.limit) || 15));
  const maxAgeDays = Math.min(30, Math.max(1, Number(opts.maxAgeDays) || 14));
  const maxRequests = Math.min(8, Math.ceil(limit / 3) + 1);
  const out = [];
  const seen = new Set();
  let cursor = null;

  for (let i = 0; i < maxRequests && out.length < limit; i++) {
    const params = { url };
    if (cursor) params.cursor = cursor;

    const data = await fetchPostsPage(params);
    const batch = Array.isArray(data.posts) ? data.posts : [];
    cursor = data.cursor || null;

    for (const raw of batch) {
      const post = normalizarPostRadar(raw, url);
      if (!post?.url) continue;
      const key = post.url.split(/[?#]/)[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      if (post.publicadoEm) {
        const ageDays = (Date.now() - post.publicadoEm.getTime()) / 86400000;
        if (ageDays > maxAgeDays) continue;
      }

      out.push(post);
      if (out.length >= limit) break;
    }

    if (!batch.length || !cursor) break;
  }

  return out;
}

async function listarPostsPerfil(pageUrl, limit = 10) {
  if (!isConfigured()) {
    throw new Error('SCRAPECREATORS_API_KEY não configurada');
  }

  const url = String(pageUrl || '').trim();
  if (!url) throw new Error('URL da página do Facebook inválida');

  const data = await fetchPostsPage({ url });
  const max = Math.min(30, Math.max(1, Number(limit) || 10));
  const posts = Array.isArray(data.posts) ? data.posts : [];
  return posts.map(normalizarItem).filter(Boolean).slice(0, max);
}

/**
 * Converte post do Radar Face para tópico do Viralizar.
 */
function postRadarParaTopico(post, pageMeta = {}) {
  if (!post || typeof post !== 'object') return null;
  const url = String(post.url || '').trim();
  if (!url) return null;

  const texto = String(post.texto || '').trim();
  const titulo = tituloDoTexto(texto, pageMeta.nome || 'Post do Facebook');
  const likes = Number(post.likes) || 0;
  const comments = Number(post.comments) || 0;
  const shares = Number(post.shares) || 0;
  const ts = post.publicadoEm instanceof Date ? post.publicadoEm.getTime() : 0;
  const veiculo = String(post.autor || pageMeta.nome || 'Facebook').trim();

  return {
    id: `fb-${Buffer.from(url).toString('base64url').slice(0, 20)}`,
    titulo,
    resumo: texto ? texto.slice(0, 400) : null,
    link: url,
    fonte: 'ScrapeCreators · Facebook',
    veiculo,
    tipoFonte: 'rede_social',
    redeSocial: true,
    plataforma: 'facebook',
    origemSocial: 'facebook',
    nicho: pageMeta.nome || null,
    likes,
    comments,
    shares,
    data: post.publicadoEm ? post.publicadoEm.toISOString() : null,
    dataTimestamp: Number.isFinite(ts) && ts > 0 ? ts : 0,
    recente: true,
    emAlta: likes + comments * 3 + shares * 5 >= 200,
  };
}

/**
 * Coleta posts recentes de várias páginas FB (1 request ~3 posts cada).
 * @param {Array<{url:string,nome?:string}>} paginas
 * @param {{ maxAgeDays?: number, postsPorPagina?: number }} [opts]
 */
async function coletarTopicosDePaginas(paginas, opts = {}) {
  if (!isConfigured()) {
    return { topicos: [], avisos: ['ScrapeCreators não configurada (FB).'] };
  }

  const lista = (Array.isArray(paginas) ? paginas : [])
    .map((p) => ({
      url: String(p?.url || p || '').trim(),
      nome: String(p?.nome || '').trim() || null,
    }))
    .filter((p) => /^https?:\/\//i.test(p.url));

  const topicos = [];
  const avisos = [];
  const seen = new Set();
  const postsPorPagina = Math.min(6, Math.max(1, Number(opts.postsPorPagina) || 3));
  const maxAgeDays = Math.min(14, Math.max(1, Number(opts.maxAgeDays) || 7));

  for (const page of lista) {
    try {
      const posts = await listarPostsPerfilRadar(page.url, {
        limit: postsPorPagina,
        maxAgeDays,
      });
      for (const post of posts) {
        const t = postRadarParaTopico(post, page);
        if (!t?.link) continue;
        const key = t.link.split(/[?#]/)[0].toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        topicos.push(t);
      }
    } catch (err) {
      avisos.push(`FB ${page.nome || page.url}: ${err.message}`);
    }
  }

  return { topicos, avisos };
}

module.exports = {
  isConfigured,
  listarPostsPerfil,
  listarPostsPerfilRadar,
  postRadarParaTopico,
  coletarTopicosDePaginas,
};
