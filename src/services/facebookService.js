const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { env } = require('../config/env');

const GRAPH = 'https://graph.facebook.com/v21.0';
const GRAPH_VIDEO = 'https://graph-video.facebook.com/v21.0';

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
  graphErrorMessage,
  assertConfigured,
};
