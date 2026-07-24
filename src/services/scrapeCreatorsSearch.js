/**
 * Busca de Reels no Instagram via ScrapeCreators (keyword search).
 * Docs: GET /v2/instagram/reels/search
 */
const axios = require('axios');
const crypto = require('crypto');
const { env } = require('../config/env');

const REELS_SEARCH_URL = 'https://api.scrapecreators.com/v2/instagram/reels/search';

function isConfigured() {
  return Boolean(env.scrapeCreatorsApiKey);
}

function slugId(titulo, link) {
  const base = `${titulo || ''}|${link || ''}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

function tituloDoCaption(caption, fallback) {
  const primeira = String(caption || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return String(primeira || fallback || 'Reel Instagram').slice(0, 120);
}

/**
 * Normaliza um reel da API para o formato de tópico do Viralizar.
 */
function reelParaTopico(reel, query) {
  if (!reel || typeof reel !== 'object') return null;

  const shortcode = String(reel.shortcode || reel.code || '').trim();
  const url =
    String(reel.url || '').trim() ||
    (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : '');
  if (!url) return null;

  const caption =
    typeof reel.caption === 'string'
      ? reel.caption.trim()
      : String(reel.caption?.text || '').trim();
  const owner = reel.owner && typeof reel.owner === 'object' ? reel.owner : {};
  const handle = String(owner.username || '').replace(/^@/, '');
  const likes = Number(reel.like_count) || 0;
  const comments = Number(reel.comment_count) || 0;
  const views = Number(reel.video_play_count || reel.video_view_count) || 0;
  const takenAt = reel.taken_at ? Date.parse(reel.taken_at) : 0;

  const titulo = tituloDoCaption(caption, handle ? `Reel @${handle}` : 'Reel Instagram');

  return {
    id: slugId(titulo, url),
    titulo,
    resumo: caption ? caption.slice(0, 400) : null,
    link: url,
    fonte: 'ScrapeCreators · Instagram',
    veiculo: handle ? `@${handle}` : 'Instagram',
    tipoFonte: 'rede_social',
    redeSocial: true,
    plataforma: 'instagram',
    origemSocial: 'instagram',
    nicho: query || null,
    likes,
    comments,
    shares: 0,
    views,
    data: reel.taken_at || null,
    dataTimestamp: Number.isFinite(takenAt) && takenAt > 0 ? takenAt : 0,
    recente: true,
    emAlta: likes >= 500 || views >= 10000,
    imagemUrl: reel.thumbnail_src || reel.display_url || null,
  };
}

/**
 * Busca reels por palavra-chave.
 * @param {string} query
 * @param {{ datePosted?: string, page?: number, limit?: number }} [opts]
 */
async function buscarReelsInstagram(query, opts = {}) {
  if (!isConfigured()) {
    throw new Error('SCRAPECREATORS_API_KEY não configurada');
  }

  const q = String(query || '').trim();
  if (q.length < 2) {
    const err = new Error('Query de busca Instagram inválida');
    err.status = 400;
    throw err;
  }

  const datePosted = opts.datePosted || 'last-week';
  const page = Math.max(1, Number(opts.page) || 1);
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 10));

  const response = await axios.get(REELS_SEARCH_URL, {
    params: {
      query: q,
      date_posted: datePosted,
      page: String(page),
    },
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
    const err = new Error(`ScrapeCreators IG search: ${message}`);
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }

  if (response.data?.success === false) {
    const message = response.data?.message || response.data?.error || 'falha desconhecida';
    const err = new Error(`ScrapeCreators IG search: ${message}`);
    err.status = 502;
    throw err;
  }

  const reels = Array.isArray(response.data?.reels) ? response.data.reels : [];
  return reels
    .map((r) => reelParaTopico(r, q))
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * Várias queries (máx. créditos controlados pelo caller).
 */
async function buscarReelsPorQueries(queries, opts = {}) {
  const lista = (Array.isArray(queries) ? queries : [])
    .map((q) => String(q || '').trim())
    .filter((q) => q.length >= 2);
  const out = [];
  const seen = new Set();
  const avisos = [];

  for (const q of lista) {
    try {
      const itens = await buscarReelsInstagram(q, opts);
      for (const item of itens) {
        const key = String(item.link || item.id || '')
          .split(/[?#]/)[0]
          .toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    } catch (err) {
      avisos.push(`IG “${q.slice(0, 40)}”: ${err.message}`);
    }
  }

  return { topicos: out, avisos };
}

module.exports = {
  isConfigured,
  buscarReelsInstagram,
  buscarReelsPorQueries,
  reelParaTopico,
};
