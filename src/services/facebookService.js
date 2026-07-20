const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { env } = require('../config/env');

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VERSION}`;
const RUPLOAD = `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}`;

// Limite oficial da Reels API: 30 publicações via API por página a cada 24h.
const REELS_DAILY_LIMIT = 30;

function assertConfigured() {
  if (!env.facebook.appId || !env.facebook.appSecret) {
    const err = new Error(
      'Facebook não configurado: preencha FACEBOOK_APP_ID e FACEBOOK_APP_SECRET no .env'
    );
    err.status = 500;
    throw err;
  }
}

function loginUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.facebook.appId,
    redirect_uri: env.facebook.redirectUri,
    state,
    scope: 'pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content',
    response_type: 'code',
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
}

async function exchangeCodeForToken(code) {
  assertConfigured();
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      client_id: env.facebook.appId,
      client_secret: env.facebook.appSecret,
      redirect_uri: env.facebook.redirectUri,
      code,
    },
  });
  return data; // { access_token, token_type, expires_in }
}

async function getLongLivedToken(shortToken) {
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: env.facebook.appId,
      client_secret: env.facebook.appSecret,
      fb_exchange_token: shortToken,
    },
  });
  return data; // { access_token, expires_in }
}

async function getMe(accessToken) {
  const { data } = await axios.get(`${GRAPH}/me`, {
    params: { access_token: accessToken, fields: 'id,name' },
  });
  return data;
}

async function getPages(accessToken) {
  const { data } = await axios.get(`${GRAPH}/me/accounts`, {
    params: { access_token: accessToken, fields: 'id,name,access_token', limit: 100 },
  });
  return data.data || [];
}

function isRetryable(err) {
  const code = err.response?.data?.error?.code;
  const status = err.response?.status;
  // 1/2 = erro transitório da API, 4/17/32/613 = rate limit, 5xx = servidor
  return [1, 2, 4, 17, 32, 613].includes(code) || (status >= 500 && status < 600);
}

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === tries) throw err;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

/**
 * Publica um vídeo em uma página.
 * @returns {Promise<{ id: string }>}
 */
async function publishVideo({ pageId, pageAccessToken, filePath, description }) {
  return withRetry(async () => {
    const form = new FormData();
    form.append('access_token', pageAccessToken);
    form.append('description', description || '');
    form.append('source', fs.createReadStream(filePath));

    const { data } = await axios.post(`${GRAPH_VIDEO}/${pageId}/videos`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 10 * 60 * 1000,
    });
    return data;
  });
}

/**
 * Cria um post no feed da Página com a foto já enviada (unpublished).
 * Usa JSON body — formato que o Graph Explorer aceita para attached_media.
 */
async function createFeedPostWithPhoto({ pageId, pageAccessToken, message, photoId }) {
  const payload = {
    message: message || '',
    published: true,
    attached_media: [{ media_fbid: String(photoId) }],
  };

  try {
    const { data } = await axios.post(`${GRAPH}/${pageId}/feed`, payload, {
      params: { access_token: pageAccessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: 2 * 60 * 1000,
    });

    if (!data?.id) {
      const err = new Error('Facebook não retornou o ID do post no feed');
      err.status = 502;
      throw err;
    }

    console.log('[facebook] feed post criado', { pageId, photoId, postId: data.id });
    return {
      id: data.id,
      post_id: data.id,
      photo_id: String(photoId),
    };
  } catch (err) {
    // Fallback: formato form-urlencoded indexed (docs curl)
    const fbMsg = graphErrorMessage(err);
    console.warn('[facebook] feed JSON falhou, tentando form indexed:', fbMsg);

    const body = new URLSearchParams();
    body.set('access_token', pageAccessToken);
    body.set('message', message || '');
    body.set('published', 'true');
    body.set('attached_media[0]', JSON.stringify({ media_fbid: String(photoId) }));

    const { data } = await axios.post(`${GRAPH}/${pageId}/feed`, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 2 * 60 * 1000,
    });

    if (!data?.id) {
      const err2 = new Error(`Falha ao criar post no feed: ${fbMsg}`);
      err2.status = 502;
      throw err2;
    }

    console.log('[facebook] feed post criado (form)', { pageId, photoId, postId: data.id });
    return {
      id: data.id,
      post_id: data.id,
      photo_id: String(photoId),
    };
  }
}

/**
 * Envia a foto SEM publicar (não cria story no álbum/Fotos).
 * `published=false` vai na query string — FormData sozinho é ignorado em alguns casos.
 */
async function uploadUnpublishedPhoto({ pageId, pageAccessToken, filePath }) {
  const form = new FormData();
  form.append('source', fs.createReadStream(filePath));

  const { data: photo } = await axios.post(`${GRAPH}/${pageId}/photos`, form, {
    params: {
      access_token: pageAccessToken,
      published: 'false',
    },
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 5 * 60 * 1000,
  });

  if (!photo?.id) {
    const err = new Error('Facebook não retornou o ID da foto');
    err.status = 502;
    throw err;
  }

  // Se a API devolveu post_id, ela publicou sozinha no álbum (não deveria).
  if (photo.post_id) {
    console.warn('[facebook] upload retornou post_id — foto publicada direto no álbum', {
      photoId: photo.id,
      postId: photo.post_id,
    });
  } else {
    console.log('[facebook] foto upload unpublished', { pageId, photoId: photo.id });
  }

  return photo;
}

async function uploadUnpublishedPhotoFromUrl({ pageId, pageAccessToken, imageUrl }) {
  const { data: photo } = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
    params: {
      access_token: pageAccessToken,
      url: imageUrl,
      published: 'false',
    },
    timeout: 2 * 60 * 1000,
  });

  if (!photo?.id) {
    const err = new Error('Facebook não retornou o ID da foto');
    err.status = 502;
    throw err;
  }

  if (photo.post_id) {
    console.warn('[facebook] upload url retornou post_id — foto publicada direto no álbum', {
      photoId: photo.id,
      postId: photo.post_id,
    });
  } else {
    console.log('[facebook] foto url unpublished', {
      pageId,
      photoId: photo.id,
      imageUrl: String(imageUrl).slice(0, 80),
    });
  }

  return photo;
}

/**
 * Publica uma foto como post no feed da página (não só no álbum Fotos).
 * Upload 1x; retry só no passo do feed (evita triplicar fotos no álbum).
 */
async function publishPhoto({ pageId, pageAccessToken, filePath, caption }) {
  const photo = await withRetry(() =>
    uploadUnpublishedPhoto({ pageId, pageAccessToken, filePath })
  );

  return withRetry(() =>
    createFeedPostWithPhoto({
      pageId,
      pageAccessToken,
      message: caption || '',
      photoId: photo.id,
    })
  );
}

/**
 * Publica foto a partir de URL pública como post no feed da página.
 */
async function publishPhotoFromUrl({ pageId, pageAccessToken, imageUrl, caption }) {
  const photo = await withRetry(() =>
    uploadUnpublishedPhotoFromUrl({ pageId, pageAccessToken, imageUrl })
  );

  return withRetry(() =>
    createFeedPostWithPhoto({
      pageId,
      pageAccessToken,
      message: caption || '',
      photoId: photo.id,
    })
  );
}

/**
 * Publica um post de texto (ou link) no feed de uma página.
 * @returns {Promise<{ id: string }>}
 */
async function publishText({ pageId, pageAccessToken, message, link }) {
  return withRetry(async () => {
    const payload = { message: message || '' };
    if (link) payload.link = link;
    const { data } = await axios.post(`${GRAPH}/${pageId}/feed`, payload, {
      params: { access_token: pageAccessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: 2 * 60 * 1000,
    });
    return data;
  });
}

async function getVideoStatus(videoId, pageAccessToken) {
  const { data } = await axios.get(`${GRAPH}/${videoId}`, {
    params: { access_token: pageAccessToken, fields: 'status' },
  });
  return data.status || {};
}

/**
 * Aguarda o processamento do vídeo do Reel terminar.
 * Lança erro se alguma fase reportar problema.
 */
async function waitReelReady(videoId, pageAccessToken, { timeoutMs = 5 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const status = await getVideoStatus(videoId, pageAccessToken);
    const videoStatus = status.video_status;

    const phaseError =
      status.processing_phase?.error?.message ||
      status.publishing_phase?.error?.message ||
      (Array.isArray(status.uploading_phase?.errors) && status.uploading_phase.errors[0]?.message);
    if (videoStatus === 'error' || videoStatus === 'upload_failed' || phaseError) {
      throw new Error(`Processamento do Reel falhou: ${phaseError || videoStatus}`);
    }
    if (videoStatus === 'ready' || status.publishing_phase?.publish_status === 'published') {
      return status;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Tempo esgotado aguardando o processamento do Reel');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/**
 * Publica um Reel em uma página (Reels Publishing API, 3 etapas):
 * 1. start no /video_reels  2. upload binário no rupload  3. finish + PUBLISHED
 * @returns {Promise<{ id: string, video_id: string }>}
 */
async function publishReel({ pageId, pageAccessToken, filePath, description, title }) {
  // Etapa 1: inicializa a sessão de upload
  const start = await withRetry(async () => {
    const { data } = await axios.post(`${GRAPH}/${pageId}/video_reels`, {
      upload_phase: 'start',
      access_token: pageAccessToken,
    });
    return data;
  });
  const videoId = start.video_id;

  // Etapa 2: envia o binário para rupload.facebook.com
  const fileSize = fs.statSync(filePath).size;
  await withRetry(async () => {
    const { data } = await axios.post(`${RUPLOAD}/${videoId}`, fs.createReadStream(filePath), {
      headers: {
        Authorization: `OAuth ${pageAccessToken}`,
        offset: '0',
        file_size: String(fileSize),
        'Content-Type': 'application/octet-stream',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 10 * 60 * 1000,
    });
    if (!data.success) throw new Error('Upload do Reel não confirmado pela API');
    return data;
  });

  // Etapa 3: finaliza e publica
  await withRetry(async () => {
    const params = {
      access_token: pageAccessToken,
      video_id: videoId,
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description: description || '',
    };
    if (title) params.title = title;
    const { data } = await axios.post(`${GRAPH}/${pageId}/video_reels`, null, { params });
    return data;
  });

  await waitReelReady(videoId, pageAccessToken);
  return { id: videoId, video_id: videoId };
}

function graphErrorMessage(err) {
  return (
    err.response?.data?.error?.message ||
    err.message ||
    'Erro desconhecido na Graph API'
  );
}

/**
 * Extrai ID nativo do post Facebook a partir de URL ou string.
 * Aceita: "123_456", "https://www.facebook.com/.../posts/456", pfbid, etc.
 */
function parseFacebookPostId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+_\d+$/.test(s)) return s;
  if (/^\d{8,}$/.test(s)) return s;
  const m =
    s.match(/facebook\.com\/[^/]+\/posts\/(\d+)/i) ||
    s.match(/facebook\.com\/permalink\.php\?[^#]*story_fbid=(\d+)/i) ||
    s.match(/facebook\.com\/photo\/?\?[^#]*fbid=(\d+)/i) ||
    s.match(/facebook\.com\/reel\/(\d+)/i) ||
    s.match(/facebook\.com\/watch\/?\?[^#]*v=(\d+)/i) ||
    s.match(/story_fbid=(\d+)/i) ||
    s.match(/\/posts\/(\d+)/i);
  if (m?.[1]) return m[1];
  return null;
}

/**
 * Busca impressões/visualizações do post via Insights.
 * Requer pages_read_engagement (e às vezes read_insights) no token da Página.
 * @returns {{ views: number|null, metrics: object, postId: string }}
 */
async function fetchPostViews(pageAccessToken, postIdOrUrl) {
  const postId = parseFacebookPostId(postIdOrUrl) || String(postIdOrUrl || '').trim();
  if (!postId || !pageAccessToken) {
    return { views: null, metrics: {}, postId: null };
  }

  const metrics = [
    'post_impressions',
    'post_impressions_unique',
    'post_video_views',
    'post_video_views_organic',
    'post_media_view',
  ];

  try {
    const { data } = await axios.get(`${GRAPH}/${encodeURIComponent(postId)}/insights`, {
      params: {
        metric: metrics.join(','),
        access_token: pageAccessToken,
      },
      timeout: 20000,
      validateStatus: (s) => s < 500,
    });

    if (data?.error) {
      const err = new Error(data.error.message || 'Insights indisponíveis');
      err.status = data.error.code === 100 ? 404 : 400;
      err.graph = data.error;
      throw err;
    }

    const byName = {};
    for (const row of data?.data || []) {
      const name = row.name;
      const val = Number(row.values?.[0]?.value);
      if (name && Number.isFinite(val)) byName[name] = val;
    }

    const views =
      byName.post_video_views ??
      byName.post_video_views_organic ??
      byName.post_media_view ??
      byName.post_impressions ??
      byName.post_impressions_unique ??
      null;

    return { views: views != null ? Math.round(views) : null, metrics: byName, postId };
  } catch (err) {
    if (err.graph) throw err;
    const msg = graphErrorMessage(err);
    const e = new Error(msg);
    e.status = err.response?.status || 502;
    throw e;
  }
}

module.exports = {
  loginUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getMe,
  getPages,
  publishVideo,
  publishPhoto,
  publishPhotoFromUrl,
  publishReel,
  publishText,
  graphErrorMessage,
  parseFacebookPostId,
  fetchPostViews,
  assertConfigured,
  REELS_DAILY_LIMIT,
};
