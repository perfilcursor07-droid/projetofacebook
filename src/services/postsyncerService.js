const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { env } = require('../config/env');

const API = 'https://postsyncer.com/api/v1';

function isConfigured() {
  return Boolean(env.postsyncer.apiKey);
}

function assertConfigured() {
  if (!isConfigured()) {
    const err = new Error(
      'PostSyncer não configurado: preencha POSTSYNCER_API_KEY no .env'
    );
    err.status = 500;
    throw err;
  }
}

function authHeaders(extra = {}) {
  assertConfigured();
  return {
    Authorization: `Bearer ${env.postsyncer.apiKey}`,
    ...extra,
  };
}

function apiErrorMessage(err) {
  const body = err.response?.data;
  if (!body) return err.message || 'Erro desconhecido na API PostSyncer';

  if (typeof body === 'string') return body;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.error === 'string') return body.error;
  if (body.errors) {
    try {
      return JSON.stringify(body.errors).slice(0, 400);
    } catch {
      /* ignore */
    }
  }
  try {
    return JSON.stringify(body).slice(0, 400);
  } catch {
    return err.message || 'Erro desconhecido na API PostSyncer';
  }
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (data && typeof data === 'object' && data.id != null) return [data];
  return [];
}

async function listWorkspaces() {
  const { data } = await axios.get(`${API}/workspaces`, {
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    timeout: 30_000,
  });
  return unwrapList(data);
}

async function resolveWorkspaceId() {
  if (env.postsyncer.workspaceId) return Number(env.postsyncer.workspaceId);
  const list = await listWorkspaces();
  const first = list[0];
  if (!first?.id) {
    const err = new Error('Nenhum workspace encontrado no PostSyncer');
    err.status = 400;
    throw err;
  }
  return Number(first.id);
}

async function listAccounts(workspaceId = null) {
  const params = {};
  if (workspaceId) params.workspace_id = workspaceId;
  const { data } = await axios.get(`${API}/accounts`, {
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    params,
    timeout: 30_000,
  });
  return unwrapList(data);
}

function isFacebookAccount(account) {
  const p = String(account?.platform || '').toLowerCase();
  return p === 'facebook' || p === 'fb' || p === 'facebook_page';
}

/**
 * Upload local file → media library id.
 * POST /media/upload/file
 */
async function uploadMediaFile({ workspaceId, filePath }) {
  if (!filePath || !fs.existsSync(filePath)) {
    const err = new Error('Arquivo de mídia não encontrado para upload no PostSyncer');
    err.status = 422;
    throw err;
  }

  const form = new FormData();
  form.append('workspace_id', String(workspaceId));
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
  });

  const { data } = await axios.post(`${API}/media/upload/file`, form, {
    headers: {
      ...authHeaders(),
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
  });

  const media = data?.data || data?.media || data;
  const id = media?.id ?? data?.id;
  if (id == null) {
    const err = new Error('PostSyncer não retornou id da mídia após upload');
    err.status = 502;
    err.response = { data };
    throw err;
  }
  return Number(id);
}

/**
 * Importa URL pública para a library (opcional).
 */
async function uploadMediaUrl({ workspaceId, url }) {
  const { data } = await axios.post(
    `${API}/media/upload/url`,
    { workspace_id: workspaceId, url },
    {
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      timeout: 120_000,
    }
  );
  const list = unwrapList(data?.media || data?.data || data);
  const first = list[0] || data?.media || data;
  const id = first?.id ?? data?.id;
  return id != null ? Number(id) : null;
}

/**
 * Publica na conta Facebook do PostSyncer.
 * tipo: foto | texto | reel | video
 */
async function publishToFacebook({
  workspaceId,
  accountId,
  content,
  filePath = null,
  imageUrl = null,
  publicationType = 'POST',
  scheduleType = 'publish_now',
  scheduleFor = null,
  title = null,
  link = null,
}) {
  assertConfigured();
  const wid = workspaceId || (await resolveWorkspaceId());
  const aid = Number(accountId);
  if (!Number.isFinite(aid)) {
    const err = new Error('Conta PostSyncer inválida');
    err.status = 400;
    throw err;
  }

  const media = [];
  if (filePath) {
    console.log('[postsyncer] uploading media', path.basename(filePath));
    const mediaId = await uploadMediaFile({ workspaceId: wid, filePath });
    media.push(mediaId);
  } else if (imageUrl && /^https?:\/\//i.test(String(imageUrl))) {
    media.push(String(imageUrl));
  }

  if (
    (publicationType === 'REELS' || publicationType === 'reel') &&
    media.length === 0
  ) {
    const err = new Error('Reel exige vídeo: upload de mídia falhou ou arquivo ausente.');
    err.status = 422;
    throw err;
  }

  const fbType =
    publicationType === 'REELS' || publicationType === 'reel'
      ? 'REELS'
      : publicationType === 'STORIES'
        ? 'STORIES'
        : 'POST';

  // PostSyncer Facebook: campo correto é post_type (não "type")
  const settings = { post_type: fbType };
  // title sobrescreve a legenda no FB — só em POST de feed, nunca em REELS
  if (title && fbType !== 'REELS') settings.title = String(title).slice(0, 200);
  if (link) settings.link = String(link);

  const body = {
    workspace_id: wid,
    content: [
      {
        text: content || '',
        media,
      },
    ],
    schedule_type: scheduleType || 'publish_now',
    accounts: [{ id: aid, settings }],
  };

  if (scheduleType === 'schedule' && scheduleFor) {
    body.schedule_for = scheduleFor;
  }

  console.log('[postsyncer] POST /posts', {
    workspaceId: wid,
    accountId: aid,
    type: fbType,
    post_type: settings.post_type,
    mediaCount: media.length,
    mediaIds: media,
    contentLen: String(content || '').length,
    hasTitleOverride: Boolean(settings.title),
  });

  try {
    const { data } = await axios.post(`${API}/posts`, body, {
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      timeout: 120_000,
    });

    const post = data?.data || data;
    const postId = post?.id != null ? `postsyncer:${post.id}` : null;
    return {
      id: postId,
      post_id: postId,
      provider: 'postsyncer',
      raw: post,
      status: post?.status || null,
    };
  } catch (err) {
    const msg = apiErrorMessage(err);
    console.error('[postsyncer] publish failed:', msg, err.response?.data);
    err.message = msg;
    throw err;
  }
}

module.exports = {
  isConfigured,
  assertConfigured,
  apiErrorMessage,
  listWorkspaces,
  listAccounts,
  resolveWorkspaceId,
  isFacebookAccount,
  uploadMediaFile,
  uploadMediaUrl,
  publishToFacebook,
};
