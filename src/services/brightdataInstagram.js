/**
 * Bright Data Instagram Scraper API — coleta posts/reels de um perfil público.
 * https://docs.brightdata.com/datasets/scrapers/instagram/send-first-request
 *
 * Não requer cookies; funciona de qualquer IP.
 * A API é assíncrona — dispara uma requisição que retorna um snapshot_id,
 * e o resultado fica pronto em 30s-3min. O módulo gerencia o ciclo:
 * 1. dispararColeta(handle) → snapshot_id (persistido no banco)
 * 2. obterResultado(snapshotId) → posts ou null se ainda não estiver pronto
 */
const axios = require('axios');
const { env } = require('../config/env');

const BASE_URL = 'https://api.brightdata.com/datasets/v3/scrape';
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
 * Dispara a coleta de posts de um perfil. Retorna snapshot_id (não bloqueia).
 * @returns {Promise<string|null>} snapshot_id ou null se falhar
 */
async function dispararColeta(username, limit = 10) {
  if (!isConfigured()) return null;

  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) return null;

  const profileUrl = `https://www.instagram.com/${handle}`;
  const maxPosts = Math.min(50, Math.max(1, Number(limit) || 10));

  try {
    const response = await axios.post(
      BASE_URL,
      [{ url: profileUrl, num_of_posts: maxPosts }],
      {
        params: {
          dataset_id: POSTS_DATASET,
          type: 'discover_new',
          discover_by: 'url',
          format: 'json',
          include_errors: true,
        },
        headers: headers(),
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    if (response.status >= 400) {
      const msg = response.data?.message || response.data?.error || `HTTP ${response.status}`;
      console.warn('[brightdata-ig] disparo falhou:', msg);
      return null;
    }

    // Pode retornar o snapshot_id diretamente
    if (response.data?.snapshot_id) {
      return response.data.snapshot_id;
    }

    // Pode retornar dados síncronos (raro, para perfis em cache)
    if (Array.isArray(response.data) && response.data.length) {
      return { immediate: true, posts: normalizarPosts(response.data, handle) };
    }

    console.warn('[brightdata-ig] resposta inesperada no disparo');
    return null;
  } catch (err) {
    console.warn('[brightdata-ig] erro disparo:', err.message);
    return null;
  }
}

/**
 * Busca o resultado de um snapshot. Retorna posts normalizados ou null se ainda processando.
 * @returns {Promise<Array|null>}
 */
async function obterResultado(snapshotId, handle = '') {
  if (!snapshotId || !isConfigured()) return null;

  try {
    const response = await axios.get(
      `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}`,
      {
        params: { format: 'json' },
        headers: headers(),
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    if (response.status === 200 && Array.isArray(response.data)) {
      return normalizarPosts(response.data, handle);
    }

    // 202 = still processing
    if (response.status === 202) return null;

    if (response.status >= 400) {
      console.warn(`[brightdata-ig] snapshot ${snapshotId}: HTTP ${response.status}`);
      return null;
    }

    return null;
  } catch (err) {
    console.warn(`[brightdata-ig] snapshot ${snapshotId}:`, err.message);
    return null;
  }
}

/**
 * Coleta síncrona com espera ativa — para uso no scan manual (botão Escanear).
 * Dispara e aguarda até 3 minutos. Em ticks automáticos, use dispararColeta + obterResultado.
 */
async function listarPostsPerfil(username, limit = 10) {
  if (!isConfigured()) return [];

  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) return [];

  const result = await dispararColeta(handle, limit);
  if (!result) return [];

  // Resultado imediato (cache)
  if (result.immediate) return result.posts;

  // Aguarda o snapshot ficar pronto
  const snapshotId = result;
  console.log(`[brightdata-ig] aguardando snapshot ${snapshotId} para @${handle}…`);

  const maxWait = 180000; // 3 min
  const interval = 8000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, interval));
    const posts = await obterResultado(snapshotId, handle);
    if (posts) {
      console.log(`[brightdata-ig] @${handle}: ${posts.length} post(s) em ${Math.round((Date.now() - start) / 1000)}s`);
      return posts;
    }
  }

  console.warn(`[brightdata-ig] @${handle}: timeout após ${Math.round(maxWait / 1000)}s (snapshot=${snapshotId})`);
  return [];
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
      const url =
        p.url ||
        `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${shortcode}/`;

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
  listarPostsPerfil,
};
