const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/** Extrai 1 frame JPG do vídeo para thumbnail obrigatória de Reels no Facebook. */
function extractVideoThumbnail(videoPath, outputPath, atSecond = 0.8) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(atSecond)
      .frames(1)
      .outputOptions(['-q:v', '3'])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
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
    timeout: 300_000,
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

async function getPost(postId) {
  const id = String(postId).replace(/^postsyncer:/i, '');
  const { data } = await axios.get(`${API}/posts/${id}`, {
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    timeout: 60_000,
  });
  return data?.data || data;
}

function platformStatusSummary(post) {
  const platforms = Array.isArray(post?.platforms) ? post.platforms : [];
  const fb =
    platforms.find((p) => /facebook/i.test(String(p.platform || ''))) || platforms[0] || null;
  return {
    status: String(post?.status || '').toUpperCase(),
    platformStatus: String(fb?.status || '').toUpperCase(),
    platformError:
      fb?.error ||
      fb?.error_message ||
      fb?.message ||
      (Array.isArray(fb?.errors) ? fb.errors[0] : null) ||
      null,
    postedOn: post?.posted_on || fb?.posted_on || null,
    platforms,
  };
}

const PROCESSING_STATUSES = new Set([
  'IN_PROGRESS',
  'PROCESSING',
  'PENDING',
  'QUEUED',
  'SCHEDULED',
  '',
]);

/**
 * Aguarda o PostSyncer terminar o envio ao Facebook (PUBLISHED / FAILED).
 * Reels do YouTube costumam ficar IN_PROGRESS por vários minutos no Facebook.
 */
async function waitForPostSettled(postId, { timeoutMs = 480_000, intervalMs = 8_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await getPost(postId);
    const summary = platformStatusSummary(last);
    console.log('[postsyncer] post status', {
      id: postId,
      status: summary.status,
      platformStatus: summary.platformStatus,
      postedOn: summary.postedOn,
      elapsedSec: Math.round((Date.now() - started) / 1000),
    });

    const done =
      ['PUBLISHED', 'FAILED', 'ERROR', 'DRAFT'].includes(summary.platformStatus) ||
      ['PUBLISHED', 'FAILED', 'ERROR'].includes(summary.status);

    if (done) return { post: last, ...summary };
    await sleep(intervalMs);
  }
  return { post: last, ...platformStatusSummary(last), timedOut: true };
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

  if ((publicationType === 'REELS' || publicationType === 'reel') && media.length === 0) {
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

  // Facebook / IG Reels: thumbnail obrigatória (cover_image.thumbnail)
  let coverImage = null;
  if (fbType === 'REELS' && filePath && fs.existsSync(filePath)) {
    const thumbPath = path.join(os.tmpdir(), `ps_reel_thumb_${Date.now()}.jpg`);
    try {
      await extractVideoThumbnail(filePath, thumbPath, 0.8);
      const thumbId = await uploadMediaFile({ workspaceId: wid, filePath: thumbPath });
      coverImage = { thumbnail: thumbId };
      console.log('[postsyncer] thumbnail uploaded', thumbId);
    } catch (thumbErr) {
      console.warn('[postsyncer] thumbnail falhou:', thumbErr.message);
      const err = new Error(
        `Falha ao gerar/enviar a capa (thumbnail) do Reel exigida pelo Facebook: ${thumbErr.message}`
      );
      err.status = 422;
      throw err;
    } finally {
      safeUnlink(thumbPath);
    }
  }

  // PostSyncer Facebook: campo correto é post_type (não "type")
  const settings = { post_type: fbType };
  // title sobrescreve a legenda no FB — só em POST de feed, nunca em REELS
  if (title && fbType !== 'REELS') settings.title = String(title).slice(0, 200);
  if (link) settings.link = String(link);

  const contentItem = {
    text: content || '',
    media,
  };
  if (coverImage) contentItem.cover_image = coverImage;

  const body = {
    workspace_id: wid,
    content: [contentItem],
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
    hasThumbnail: Boolean(coverImage?.thumbnail),
    contentLen: String(content || '').length,
    hasTitleOverride: Boolean(settings.title),
  });

  try {
    const { data } = await axios.post(`${API}/posts`, body, {
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      timeout: 300_000,
    });

    const post = data?.data || data;
    const numericId = post?.id;
    const postId = numericId != null ? `postsyncer:${numericId}` : null;

    console.log('[postsyncer] create ok', {
      id: numericId,
      status: post?.status,
      platforms: (post?.platforms || []).map((p) => ({
        platform: p.platform,
        status: p.status,
      })),
    });

    // Confirma se o Facebook realmente publicou (API pode aceitar e falhar depois).
    // Reels (sobretudo YouTube) demoram: Facebook processa o vídeo em background.
    let settled = { post, ...platformStatusSummary(post) };
    if (numericId != null && fbType === 'REELS') {
      settled = await waitForPostSettled(numericId, { timeoutMs: 480_000, intervalMs: 8_000 });
    }

    const finalStatus = String(settled.platformStatus || settled.status || '').toUpperCase();
    if (['FAILED', 'ERROR'].includes(finalStatus) || finalStatus === 'DRAFT') {
      const detail =
        typeof settled.platformError === 'string'
          ? settled.platformError
          : settled.platformError
            ? JSON.stringify(settled.platformError).slice(0, 300)
            : finalStatus;
      const err = new Error(`Facebook/PostSyncer recusou o Reel: ${detail}`);
      err.status = 502;
      err.postsyncer = settled;
      throw err;
    }

    // Timeout ainda IN_PROGRESS = PostSyncer aceitou; FB só está processando o vídeo.
    // Não marcar como erro — o post costuma sair nos minutos seguintes.
    const pendingConfirmation =
      settled.timedOut &&
      finalStatus !== 'PUBLISHED' &&
      PROCESSING_STATUSES.has(finalStatus);

    if (pendingConfirmation) {
      console.warn(
        `[postsyncer] Reel #${numericId} ainda IN_PROGRESS após espera — tratando como aceito (verifique em app.postsyncer.com)`
      );
    }

    return {
      id: postId,
      post_id: postId,
      provider: 'postsyncer',
      raw: settled.post || post,
      status: settled.status || post?.status || null,
      platformStatus: settled.platformStatus || null,
      postedOn: settled.postedOn || null,
      pendingConfirmation: Boolean(pendingConfirmation),
      message: pendingConfirmation
        ? `Reel enviado (#${numericId}). O Facebook ainda está processando — confira em alguns minutos na Página ou em app.postsyncer.com.`
        : null,
    };
  } catch (err) {
    if (err.postsyncer) throw err;
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
  getPost,
  waitForPostSettled,
  publishToFacebook,
};
