const axios = require('axios');
const { env } = require('../config/env');

const ENDPOINTS = {
  instagram: 'https://api.scrapecreators.com/v1/instagram/post',
  facebook: 'https://api.scrapecreators.com/v1/facebook/post',
};

function isConfigured() {
  return Boolean(env.scrapeCreatorsApiKey);
}

function detectarPlataforma(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'fb.watch') {
      return 'facebook';
    }
  } catch {
    /* URL inválida tratada pelo chamador */
  }
  return null;
}

function normalizarData(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return null;
  const numeric = Number(timestamp);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function textoLimpo(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function tituloDoTexto(texto, fallback) {
  const primeiraLinha = String(texto || '')
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .find(Boolean);
  return String(primeiraLinha || fallback || '').slice(0, 140) || null;
}

function normalizarInstagram(payload, url) {
  const media = payload?.data?.xdt_shortcode_media || payload?.xdt_shortcode_media || null;
  if (!media || typeof media !== 'object') return null;

  const texto = textoLimpo(media.edge_media_to_caption?.edges?.[0]?.node?.text);
  const owner = media.owner || {};
  const username = textoLimpo(owner.username);
  const nome = textoLimpo(owner.full_name);
  const shortcode = textoLimpo(media.shortcode);
  const resources = Array.isArray(media.display_resources) ? media.display_resources : [];
  const sidecarImage = media.edge_sidecar_to_children?.edges?.[0]?.node?.display_url;
  const imagem =
    textoLimpo(media.display_url) ||
    textoLimpo(media.thumbnail_src) ||
    textoLimpo(resources[resources.length - 1]?.src) ||
    textoLimpo(sidecarImage) ||
    null;
  const videoUrl = textoLimpo(media.video_url) || null;
  const isVideo = Boolean(media.is_video || videoUrl || /clips|video/i.test(String(media.product_type || '')));
  const canonicalUrl = shortcode
    ? `https://www.instagram.com/${isVideo ? 'reel' : 'p'}/${shortcode}/`
    : url;
  const veiculo = nome && username ? `${nome} (@${username})` : username ? `@${username}` : nome || null;

  return {
    url: canonicalUrl,
    titulo: tituloDoTexto(texto, veiculo || 'Post do Instagram'),
    texto: texto || null,
    imagem,
    veiculo,
    metodo: 'scrapecreators',
    plataforma: 'instagram',
    isVideo,
    videoUrl,
    publicadoEm: normalizarData(media.taken_at_timestamp),
    autorUrl: username ? `https://www.instagram.com/${username}/` : null,
  };
}

function normalizarFacebook(payload, url) {
  const post =
    payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : payload;
  if (!post || typeof post !== 'object') return null;

  const texto = textoLimpo(post.description || post.message || post.text);
  const author = post.author && typeof post.author === 'object' ? post.author : {};
  const veiculo = textoLimpo(author.name || post.author_name) || null;
  const video = post.video && typeof post.video === 'object' ? post.video : {};
  const imagem =
    textoLimpo(post.image_url) ||
    textoLimpo(video.thumbnail) ||
    textoLimpo(post.thumbnail_url) ||
    null;
  const videoUrl = textoLimpo(video.hd_url) || textoLimpo(video.sd_url) || null;

  return {
    url: textoLimpo(post.url) || url,
    titulo: tituloDoTexto(texto, veiculo || 'Post do Facebook'),
    texto: texto || null,
    imagem,
    veiculo,
    metodo: 'scrapecreators',
    plataforma: 'facebook',
    isVideo: Boolean(videoUrl),
    videoUrl,
    publicadoEm: normalizarData(post.creation_time),
    autorUrl: textoLimpo(author.url) || null,
  };
}

function providerMessage(payload, fallback) {
  return [payload?.message, payload?.error, payload?.detail, payload?.errorStatus]
    .filter(Boolean)
    .map(String)
    .join(' ') || fallback;
}

async function extrairPost(url, plataformaInformada = null) {
  if (!isConfigured()) {
    const err = new Error('SCRAPECREATORS_API_KEY não configurada');
    err.status = 503;
    throw err;
  }

  const link = String(url || '').trim();
  const plataforma = plataformaInformada || detectarPlataforma(link);
  if (!ENDPOINTS[plataforma]) {
    const err = new Error('Link não é de Facebook ou Instagram');
    err.status = 400;
    throw err;
  }

  const response = await axios.get(ENDPOINTS[plataforma], {
    params: { url: link },
    headers: {
      'x-api-key': env.scrapeCreatorsApiKey,
      Accept: 'application/json',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const message = providerMessage(response.data, `HTTP ${response.status}`);
    const err = new Error(`ScrapeCreators não extraiu o post: ${message}`);
    err.status = response.status === 429 ? 429 : response.status === 404 ? 422 : 502;
    throw err;
  }

  const message = providerMessage(response.data, 'resposta sem dados');
  if (
    response.data?.success === false ||
    response.data?.isRestricted === true ||
    /restricted|private|not available|login required/i.test(message)
  ) {
    const err = new Error(`ScrapeCreators não acessou o post público: ${message}`);
    err.status = 422;
    throw err;
  }

  const normalizado =
    plataforma === 'instagram'
      ? normalizarInstagram(response.data, link)
      : normalizarFacebook(response.data, link);

  if (!normalizado || (!normalizado.texto && !normalizado.imagem && !normalizado.videoUrl)) {
    const err = new Error('ScrapeCreators retornou o post sem legenda ou mídia');
    err.status = 422;
    throw err;
  }

  return normalizado;
}

module.exports = {
  isConfigured,
  extrairPost,
};
