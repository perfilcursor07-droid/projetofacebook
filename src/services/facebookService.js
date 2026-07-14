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
    scope: 'pages_show_list,pages_manage_posts,pages_read_engagement',
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
 * Publica uma foto em uma página.
 * @returns {Promise<{ id: string, post_id?: string }>}
 */
async function publishPhoto({ pageId, pageAccessToken, filePath, caption }) {
  return withRetry(async () => {
    const form = new FormData();
    form.append('access_token', pageAccessToken);
    form.append('caption', caption || '');
    form.append('source', fs.createReadStream(filePath));

    const { data } = await axios.post(`${GRAPH}/${pageId}/photos`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 5 * 60 * 1000,
    });
    return data;
  });
}

/**
 * Publica um post de texto (ou link) no feed de uma página.
 * @returns {Promise<{ id: string }>}
 */
async function publishText({ pageId, pageAccessToken, message, link }) {
  return withRetry(async () => {
    const params = { access_token: pageAccessToken, message };
    if (link) params.link = link;
    const { data } = await axios.post(`${GRAPH}/${pageId}/feed`, null, { params });
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

module.exports = {
  loginUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getMe,
  getPages,
  publishVideo,
  publishPhoto,
  publishReel,
  publishText,
  graphErrorMessage,
  assertConfigured,
  REELS_DAILY_LIMIT,
};
