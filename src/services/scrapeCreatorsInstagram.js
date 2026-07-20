const axios = require('axios');
const { env } = require('../config/env');

const POSTS_URL = 'https://api.scrapecreators.com/v2/instagram/user/posts';

function isConfigured() {
  return Boolean(env.scrapeCreatorsApiKey);
}

function normalizarData(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function thumbnailDoItem(item) {
  return (
    item?.image_versions2?.candidates?.[0]?.url ||
    item?.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
    item?.display_uri ||
    item?.thumbnail_url ||
    null
  );
}

function normalizarItem(item, handle) {
  if (!item || typeof item !== 'object') return null;

  const shortcode = String(item.code || item.shortcode || '').trim();
  const externalId = shortcode || String(item.pk || item.id || '').trim();
  if (!externalId) return null;

  const isVideo =
    Number(item.media_type) === 2 ||
    item.product_type === 'clips' ||
    item.product_type === 'igtv' ||
    (Array.isArray(item.video_versions) && item.video_versions.length > 0);
  const caption =
    typeof item.caption === 'string'
      ? item.caption
      : item.caption?.text || item.description || item.title || '';
  const url =
    item.url ||
    (shortcode
      ? `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${shortcode}/`
      : null);
  if (!url) return null;

  return {
    externalId,
    mediaType: isVideo ? 'video' : 'image',
    titulo: String(caption || `Post @${handle}`).trim().slice(0, 120),
    url: String(url),
    resumo: caption ? String(caption).trim().slice(0, 400) : null,
    thumbnail: thumbnailDoItem(item),
    publicadoEm: normalizarData(item.taken_at || item.caption?.created_at_utc),
  };
}

async function listarPostsPerfil(username, limit = 10) {
  if (!isConfigured()) {
    throw new Error('SCRAPECREATORS_API_KEY não configurada');
  }

  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) throw new Error('Perfil do Instagram inválido');

  const response = await axios.get(POSTS_URL, {
    params: { handle },
    headers: {
      'x-api-key': env.scrapeCreatorsApiKey,
      Accept: 'application/json',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const message =
      response.data?.message ||
      response.data?.error ||
      response.data?.detail ||
      `HTTP ${response.status}`;
    const err = new Error(`ScrapeCreators não listou @${handle}: ${message}`);
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }

  const providerMessage = [
    response.data?.message,
    response.data?.error,
    response.data?.errorStatus,
  ]
    .filter(Boolean)
    .map(String)
    .join(' ');
  if (
    response.data?.success === false ||
    response.data?.isRestricted === true ||
    /profile is restricted|restricted profile/i.test(providerMessage)
  ) {
    const err = new Error(
      `ScrapeCreators: o Instagram restringiu o acesso público ao perfil @${handle}`
    );
    err.status = 422;
    throw err;
  }

  if (response.data?.status && response.data.status !== 'ok') {
    const message = response.data?.message || response.data?.error || response.data.status;
    const err = new Error(`ScrapeCreators não listou @${handle}: ${message}`);
    err.status = 502;
    throw err;
  }

  const max = Math.min(30, Math.max(1, Number(limit) || 10));
  const items = Array.isArray(response.data?.items) ? response.data.items : [];
  return items.map((item) => normalizarItem(item, handle)).filter(Boolean).slice(0, max);
}

module.exports = {
  isConfigured,
  listarPostsPerfil,
};
