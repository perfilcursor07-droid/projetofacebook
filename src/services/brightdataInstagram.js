/**
 * Bright Data Instagram Scraper API — coleta assíncrona de posts/reels.
 * O /trigger responde com snapshot_id; o resultado é consultado depois pelo tick.
 */
const axios = require('axios');
const { env } = require('../config/env');

const TRIGGER_URL = 'https://api.brightdata.com/datasets/v3/trigger';
const SNAPSHOT_URL = 'https://api.brightdata.com/datasets/v3/snapshot';
const POSTS_DATASET = 'gd_lk5ns7kz21pck8jpis';

function isConfigured() {
  return Boolean(env.brightdataApiToken);
}

function headers() {
  return {
    Authorization: `Bearer ${env.brightdataApiToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Dispara a coleta sem aguardar o scraping.
 * @returns {Promise<{snapshotId: string}|{posts: Array}>}
 */
async function dispararColeta(username, limit = 10) {
  if (!isConfigured()) throw new Error('BRIGHTDATA_API_TOKEN não configurado');

  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) throw new Error('Perfil do Instagram inválido');

  const profileUrl = `https://www.instagram.com/${handle}`;
  const maxPosts = Math.min(50, Math.max(1, Number(limit) || 10));
  const response = await axios.post(
    TRIGGER_URL,
    [{ url: profileUrl, num_of_posts: maxPosts }],
    {
      params: {
        dataset_id: POSTS_DATASET,
        type: 'discover_new',
        discover_by: 'url',
        include_errors: true,
      },
      headers: headers(),
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    const message = response.data?.message || response.data?.error || `HTTP ${response.status}`;
    throw new Error(`Bright Data não iniciou a coleta: ${message}`);
  }

  if (response.data?.snapshot_id) {
    return { snapshotId: String(response.data.snapshot_id) };
  }

  // Mantém compatibilidade caso a API devolva cache imediatamente.
  if (Array.isArray(response.data)) {
    return { posts: normalizarPosts(response.data, handle) };
  }

  throw new Error('Bright Data respondeu sem snapshot_id');
}

/**
 * Consulta um snapshot sem fazer espera ativa.
 * @returns {Promise<{status: 'ready', posts: Array}|{status: 'pending', error?: string}|{status: 'failed', error: string}>}
 */
async function obterResultado(snapshotId, handle = '') {
  if (!snapshotId || !isConfigured()) {
    return { status: 'failed', error: 'Snapshot ou token Bright Data ausente' };
  }

  try {
    const response = await axios.get(`${SNAPSHOT_URL}/${encodeURIComponent(snapshotId)}`, {
      params: { format: 'json' },
      headers: headers(),
      timeout: 30000,
      validateStatus: () => true,
    });

    if (response.status === 200 && Array.isArray(response.data)) {
      return { status: 'ready', posts: normalizarPosts(response.data, handle) };
    }

    if (response.status === 202) return { status: 'pending' };

    const message = response.data?.message || response.data?.error || `HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) {
      return { status: 'pending', error: message };
    }

    return { status: 'failed', error: message };
  } catch (err) {
    // Falha de rede não invalida um snapshot que ainda pode terminar no provedor.
    return { status: 'pending', error: err.message };
  }
}

function normalizarPosts(posts, handle) {
  return posts
    .filter((p) => p && !p.__error && (p.url || p.post_id || p.shortcode))
    .map((p) => {
      const shortcode = p.shortcode || p.post_id || extrairShortcode(p.url);
      if (!shortcode) return null;

      const isVideo =
        p.content_type === 'video' ||
        p.product_type === 'clips' ||
        p.product_type === 'igtv' ||
        (Array.isArray(p.videos) && p.videos.length > 0) ||
        /\/(reel|reels|tv)\//i.test(String(p.url || ''));

      const caption = p.description || p.caption || p.title || null;
      const url = p.url || `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${shortcode}/`;

      return {
        externalId: String(shortcode),
        mediaType: isVideo ? 'video' : 'image',
        titulo: String(caption || `Post @${handle}`).slice(0, 120),
        url,
        resumo: caption ? String(caption).slice(0, 400) : null,
        thumbnail: p.thumbnail || p.display_url || p.image_url || null,
        publicadoEm: p.date_posted
          ? new Date(p.date_posted)
          : p.timestamp
            ? new Date(p.timestamp)
            : null,
      };
    })
    .filter(Boolean);
}

function extrairShortcode(url) {
  if (!url) return null;
  const match = String(url).match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[2] : null;
}

module.exports = {
  isConfigured,
  dispararColeta,
  obterResultado,
};
