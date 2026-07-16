const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { env } = require('../config/env');

const AUTH = 'https://auth.post-pulse.com';
const API = 'https://api.post-pulse.com';

const SCOPES = [
  'postpulse-api/accounts.read',
  'postpulse-api/posts.read',
  'postpulse-api/posts.write',
  'postpulse-api/media.write',
].join(' ');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function assertConfigured() {
  if (!env.postpulse.clientId || !env.postpulse.clientSecret) {
    const err = new Error(
      'PostPulse não configurado: preencha POSTPULSE_CLIENT_ID e POSTPULSE_CLIENT_SECRET no .env'
    );
    err.status = 500;
    throw err;
  }
}

function isConfigured() {
  return Boolean(env.postpulse.clientId && env.postpulse.clientSecret);
}

function loginUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.postpulse.clientId,
    response_type: 'code',
    redirect_uri: env.postpulse.redirectUri,
    scope: SCOPES,
    audience: 'https://api.post-pulse.com',
    state,
  });
  return `${AUTH}/authorize?${params}`;
}

async function exchangeCodeForToken(code) {
  assertConfigured();
  const { data } = await axios.post(
    `${AUTH}/oauth/token`,
    {
      grant_type: 'authorization_code',
      client_id: env.postpulse.clientId,
      client_secret: env.postpulse.clientSecret,
      code,
      redirect_uri: env.postpulse.redirectUri,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
  );
  return data;
}

function apiErrorMessage(err) {
  const body = err.response?.data;
  if (!body) return err.message || 'Erro desconhecido na API PostPulse';

  // PostPulse às vezes devolve { error: "texto" } (string)
  if (typeof body.error === 'string') return body.error;

  const details = body?.error?.details;
  let detailText = '';
  if (Array.isArray(details) && details.length) {
    detailText = details
      .map((d) => (d.field ? `${d.field}: ${d.message}` : d.message || JSON.stringify(d)))
      .join('; ');
  }

  const main =
    body?.error?.message ||
    body?.message ||
    (typeof body === 'string' ? body : null);

  if (main && detailText) return `${main} (${detailText})`;
  if (main) return main;
  if (detailText) return detailText;
  try {
    return JSON.stringify(body).slice(0, 400);
  } catch {
    return err.message || 'Erro desconhecido na API PostPulse';
  }
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function listAccounts(accessToken) {
  const { data } = await axios.get(`${API}/v1/accounts`, {
    headers: authHeaders(accessToken),
    timeout: 30_000,
  });
  return Array.isArray(data) ? data : data?.accounts || data?.data || [];
}

/**
 * Páginas/canais ligados à conta (Facebook e Telegram usam chatId no post).
 * GET /v1/accounts/{id}/chats?platform=FACEBOOK
 */
async function listChats(accessToken, accountId, platform = 'FACEBOOK') {
  const { data } = await axios.get(`${API}/v1/accounts/${accountId}/chats`, {
    headers: authHeaders(accessToken),
    params: { platform },
    timeout: 30_000,
  });
  return Array.isArray(data) ? data : data?.chats || data?.data || [];
}

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Upload direto (multipart). Retorna o path/key para attachmentPaths.
 */
async function uploadMedia(accessToken, filePath) {
  if (!fs.existsSync(filePath)) {
    const err = new Error('Arquivo de mídia não encontrado');
    err.status = 422;
    throw err;
  }

  const filename = path.basename(filePath);
  const contentType = contentTypeForFile(filePath);
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename, contentType });

  const { data } = await axios.post(`${API}/v1/media/upload`, form, {
    headers: { ...form.getHeaders(), ...authHeaders(accessToken) },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 10 * 60 * 1000,
  });

  const mediaPath = data?.path || data?.key || data?.s3Key;
  if (!mediaPath) {
    const err = new Error('PostPulse não retornou o path da mídia');
    err.status = 502;
    throw err;
  }
  return mediaPath;
}

/**
 * Publica (agenda) no Facebook via PostPulse.
 * Facebook Pages exigem chatId (igual Telegram).
 * publicationType: FEED | REELS | STORY
 */
async function publishToFacebook({
  accessToken,
  socialMediaAccountId,
  chatId,
  content,
  filePath,
  imageUrl,
  publicationType = 'FEED',
}) {
  if (chatId == null || String(chatId).trim() === '') {
    const err = new Error(
      'PostPulse: chatId da Página ausente. Sincronize em /paginas (Page ID do Facebook).'
    );
    err.status = 400;
    throw err;
  }

  const attachmentPaths = [];
  if (filePath) {
    attachmentPaths.push(await uploadMedia(accessToken, filePath));
  } else if (imageUrl) {
    attachmentPaths.push(String(imageUrl));
  }

  const scheduledTime = new Date(Date.now() + 60_000).toISOString();

  const payload = {
    scheduledTime,
    isDraft: false,
    publications: [
      {
        socialMediaAccountId: Number(socialMediaAccountId),
        platformSettings: {
          type: 'FACEBOOK',
          publicationType,
        },
        // Facebook Feed: exatamente 1 post por Page (chatId = ID da Página)
        posts: [
          {
            content: content || '',
            chatId: String(chatId),
            ...(attachmentPaths.length ? { attachmentPaths } : {}),
          },
        ],
      },
    ],
  };

  console.log('[postpulse] POST /v1/posts', {
    socialMediaAccountId: payload.publications[0].socialMediaAccountId,
    chatId: String(chatId),
    publicationType,
    hasMedia: Boolean(attachmentPaths.length),
    contentLen: (content || '').length,
    postsCount: 1,
  });

  try {
    const { data } = await axios.post(`${API}/v1/posts`, payload, {
      headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
      timeout: 2 * 60 * 1000,
    });

    const scheduleId = data?.id;
    return {
      id: scheduleId != null ? `postpulse:${scheduleId}` : null,
      post_id: scheduleId != null ? `postpulse:${scheduleId}` : null,
      schedule: data,
      provider: 'postpulse',
    };
  } catch (err) {
    const msg = apiErrorMessage(err);
    console.error('[postpulse] publish failed:', msg, err.response?.data);
    const e = new Error(msg);
    e.status = err.response?.status || 502;
    e.response = err.response;
    throw e;
  }
}

module.exports = {
  isConfigured,
  assertConfigured,
  loginUrl,
  exchangeCodeForToken,
  listAccounts,
  listChats,
  uploadMedia,
  publishToFacebook,
  apiErrorMessage,
};
