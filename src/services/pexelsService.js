const axios = require('axios');
const { env } = require('../config/env');

const PEXELS_VIDEO_BASE = 'https://api.pexels.com/videos';
const PEXELS_PHOTO_BASE = 'https://api.pexels.com/v1';

function getClient(baseURL = PEXELS_VIDEO_BASE) {
  if (!env.pexelsApiKey) {
    const err = new Error('PEXELS_API_KEY não configurada no .env');
    err.status = 500;
    throw err;
  }

  return axios.create({
    baseURL,
    headers: {
      Authorization: env.pexelsApiKey,
    },
    timeout: 20000,
  });
}

/**
 * Escolhe o melhor arquivo HD disponível (preferência ~1080p / maior width).
 */
function pickBestVideoFile(videoFiles = []) {
  if (!videoFiles.length) return null;

  const hdPreferred = videoFiles
    .filter((f) => f.file_type === 'video/mp4' || (f.link && f.link.includes('.mp4')))
    .sort((a, b) => (b.width || 0) - (a.width || 0));

  const preferred =
    hdPreferred.find((f) => (f.quality === 'hd' || f.quality === 'sd') && (f.width || 0) >= 1280) ||
    hdPreferred.find((f) => f.quality === 'hd') ||
    hdPreferred[0] ||
    videoFiles[0];

  return preferred || null;
}

function normalizeVideo(video) {
  const best = pickBestVideoFile(video.video_files || []);
  const picture =
    video.image ||
    (video.video_pictures && video.video_pictures[0] && video.video_pictures[0].picture) ||
    null;

  return {
    pexelsId: String(video.id),
    url: video.url,
    thumbnail: picture,
    duracao: video.duration || null,
    width: video.width || null,
    height: video.height || null,
    autor: video.user?.name || null,
    autorUrl: video.user?.url || null,
    urlOriginal: best?.link || null,
    qualidade: best?.quality || null,
    arquivoWidth: best?.width || null,
    arquivoHeight: best?.height || null,
  };
}

/**
 * Busca vídeos na Pexels Video API.
 * @param {string} termo
 * @param {{ page?: number, perPage?: number, orientation?: string }} options
 */
async function searchVideos(termo, options = {}) {
  const query = String(termo || '').trim();
  if (!query) {
    const err = new Error('Informe um termo de busca');
    err.status = 400;
    throw err;
  }

  const page = Number(options.page || 1);
  const perPage = Math.min(Number(options.perPage || 15), 80);

  const client = getClient();
  const { data } = await client.get('/search', {
    params: {
      query,
      page,
      per_page: perPage,
      orientation: options.orientation || undefined,
    },
  });

  const videos = (data.videos || []).map(normalizeVideo).filter((v) => v.urlOriginal);

  return {
    termo: query,
    page: data.page || page,
    perPage: data.per_page || perPage,
    totalResults: data.total_results || videos.length,
    videos,
  };
}

/**
 * Detalhe de um vídeo pelo ID Pexels.
 */
async function getVideoById(pexelsId) {
  const client = getClient();
  const { data } = await client.get(`/videos/${pexelsId}`);
  return normalizeVideo(data);
}

function normalizePhoto(photo) {
  return {
    pexelsId: String(photo.id),
    url: photo.url,
    thumbnail: photo.src?.large || photo.src?.medium || photo.src?.original || null,
    urlOriginal: photo.src?.large2x || photo.src?.original || null,
    largura: photo.width || null,
    altura: photo.height || null,
    autor: photo.photographer || null,
    autorUrl: photo.photographer_url || null,
    alt: photo.alt || null,
    corMedia: photo.avg_color || null,
  };
}

/**
 * Busca fotos na Pexels Photo API.
 * @param {string} termo
 * @param {{ page?: number, perPage?: number, orientation?: string }} options
 */
async function searchPhotos(termo, options = {}) {
  const query = String(termo || '').trim();
  if (!query) {
    const err = new Error('Informe um termo de busca');
    err.status = 400;
    throw err;
  }

  const page = Number(options.page || 1);
  const perPage = Math.min(Number(options.perPage || 15), 80);

  const client = getClient(PEXELS_PHOTO_BASE);
  const { data } = await client.get('/search', {
    params: {
      query,
      page,
      per_page: perPage,
      orientation: options.orientation || undefined,
    },
  });

  const photos = (data.photos || []).map(normalizePhoto).filter((p) => p.urlOriginal);

  return {
    termo: query,
    page: data.page || page,
    perPage: data.per_page || perPage,
    totalResults: data.total_results || photos.length,
    photos,
  };
}

/**
 * Detalhe de uma foto pelo ID Pexels.
 */
async function getPhotoById(pexelsId) {
  const client = getClient(PEXELS_PHOTO_BASE);
  const { data } = await client.get(`/photos/${pexelsId}`);
  return normalizePhoto(data);
}

module.exports = {
  searchVideos,
  getVideoById,
  searchPhotos,
  getPhotoById,
  pickBestVideoFile,
  normalizeVideo,
  normalizePhoto,
};
