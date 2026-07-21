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

async function listarPostsPerfil(pageUrl, limit = 10) {
  if (!isConfigured()) {
    throw new Error('SCRAPECREATORS_API_KEY não configurada');
  }

  const url = String(pageUrl || '').trim();
  if (!url) throw new Error('URL da página do Facebook inválida');

  const response = await axios.get(POSTS_URL, {
    params: { url },
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
    const err = new Error(`ScrapeCreators não listou a página Facebook: ${message}`);
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }

  if (response.data?.success === false) {
    const message = response.data?.message || response.data?.error || 'falha desconhecida';
    const err = new Error(`ScrapeCreators não listou a página Facebook: ${message}`);
    err.status = 502;
    throw err;
  }

  const max = Math.min(30, Math.max(1, Number(limit) || 10));
  const posts = Array.isArray(response.data?.posts) ? response.data.posts : [];
  return posts.map(normalizarItem).filter(Boolean).slice(0, max);
}

module.exports = {
  isConfigured,
  listarPostsPerfil,
};
