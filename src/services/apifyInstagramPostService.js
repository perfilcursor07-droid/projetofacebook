const { ApifyClient } = require('apify-client');
const { env } = require('../config/env');

function isConfigured() {
  return Boolean(env.apifyToken);
}

function shortcodeDaUrl(url) {
  return String(url || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i)?.[1] || null;
}

function primeiraUrl(values) {
  for (const value of values) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
    if (value && typeof value === 'object') {
      const nested = value.url || value.src || value.displayUrl || value.videoUrl;
      if (typeof nested === 'string' && /^https?:\/\//i.test(nested)) return nested;
    }
  }
  return null;
}

async function extrairPost(url) {
  if (!isConfigured()) return null;

  const postUrl = String(url || '').trim();
  const shortcode = shortcodeDaUrl(postUrl);
  if (!shortcode) return null;

  const client = new ApifyClient({ token: env.apifyToken });
  const run = await client.actor(env.apifyIgPostActor).call(
    {
      directUrls: [postUrl],
      resultsType: 'posts',
      resultsLimit: 1,
      addParentData: false,
    },
    { waitSecs: 120, memory: 1024 }
  );
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 5 });
  const raw = (items || []).find((item) => {
    const recebido = item?.shortCode || item?.shortcode || item?.code || shortcodeDaUrl(item?.url);
    return recebido && String(recebido).toLowerCase() === shortcode.toLowerCase();
  });
  if (!raw || raw.error) return null;

  const texto = String(raw.caption || raw.description || raw.text || raw.title || '').trim();
  if (texto.length < 20) return null;

  const imagens = [
    raw.displayUrl,
    raw.imageUrl,
    raw.thumbnailUrl,
    ...(Array.isArray(raw.images) ? raw.images : []),
    ...(Array.isArray(raw.childPosts) ? raw.childPosts.map((item) => item?.displayUrl) : []),
  ];
  const videos = [raw.videoUrl, ...(Array.isArray(raw.videos) ? raw.videos : [])];
  const imagem = primeiraUrl(imagens);
  const videoUrl = primeiraUrl(videos);
  const veiculo = String(raw.ownerUsername || raw.username || raw.owner?.username || '').trim() || null;

  return {
    url: postUrl,
    titulo: texto.slice(0, 140),
    texto,
    imagem,
    veiculo,
    autorUrl: veiculo ? `https://www.instagram.com/${veiculo}/` : null,
    publicadoEm: raw.timestamp || raw.takenAt || null,
    isVideo: Boolean(videoUrl) || /video|reel/i.test(String(raw.type || raw.productType || '')),
    videoUrl,
    postId: shortcode,
    conteudoVisual: imagens
      .map((item) => primeiraUrl([item]))
      .filter(Boolean)
      .map((mediaUrl) => ({ tipo: 'imagem', url: mediaUrl })),
    metodo: 'apify-ig',
  };
}

module.exports = { isConfigured, extrairPost };
