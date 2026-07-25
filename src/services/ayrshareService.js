const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { env } = require('../config/env');
const { storageAbsolutePath } = require('./downloadService');

const API = 'https://api.ayrshare.com/api';

function isConfigured() {
  return Boolean(env.ayrshare?.apiKey);
}

function assertConfigured() {
  if (!isConfigured()) {
    const err = new Error(
      'Ayrshare não configurado: preencha AYRSHARE_API_KEY no .env'
    );
    err.status = 500;
    throw err;
  }
}

function authHeaders(extra = {}, profileKey = null) {
  assertConfigured();
  const headers = {
    Authorization: `Bearer ${env.ayrshare.apiKey}`,
    ...extra,
  };
  const key = profileKey != null ? String(profileKey).trim() : '';
  if (key) headers['Profile-Key'] = key;
  return headers;
}

function apiErrorMessage(err) {
  const body = err.response?.data;
  if (!body) return err.message || 'Erro desconhecido na API Ayrshare';

  const code = body.code ?? body.statusCode;
  const msg = String(body.message || body.error || '').trim();
  const lower = msg.toLowerCase();

  if (
    code === 156 ||
    lower.includes('not linked') ||
    lower.includes('not connected') ||
    lower.includes('no social') ||
    lower.includes('facebook') && lower.includes('link')
  ) {
    return (
      'Ayrshare: Página do Facebook não está conectada. ' +
      'No painel app.ayrshare.com → Social Accounts, vincule a Página e tente de novo.'
    );
  }

  if (
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many') ||
    code === 429
  ) {
    return (
      'Ayrshare: limite/quota atingido. Aguarde o reset do plano ou verifique o uso no dashboard.'
    );
  }

  if (
    lower.includes('media') &&
    (lower.includes('could not') ||
      lower.includes('unable') ||
      lower.includes('download') ||
      lower.includes('access') ||
      lower.includes('invalid'))
  ) {
    return (
      'Ayrshare não conseguiu baixar a mídia. Confirme APP_PUBLIC_URL (HTTPS público) ' +
      'e que a imagem/vídeo está acessível em /media/…'
    );
  }

  if (typeof body === 'string') return body;
  if (msg) return msg;
  if (Array.isArray(body.posts)) {
    const fails = body.posts
      .filter((p) => p.status === 'error' || p.status === 'failed')
      .map((p) => p.message || p.error || JSON.stringify(p))
      .filter(Boolean);
    if (fails.length) return fails.join(' | ').slice(0, 400);
  }
  try {
    return JSON.stringify(body).slice(0, 400);
  } catch {
    return err.message || 'Erro desconhecido na API Ayrshare';
  }
}

/**
 * Converte arquivo em storage (ou path /media) em URL HTTPS pública.
 */
function publicMediaUrlFromLocal(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const abs = path.resolve(filePath);
  const storageRoot = path.resolve(env.storagePath);
  const rel = path.relative(storageRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const mediaPath = `/media/${rel.replace(/\\/g, '/')}`;
  const base = env.appPublicUrl;
  if (!base) return null;
  return `${base}${mediaPath}`;
}

/**
 * Upload local → Ayrshare media gallery. Retorna URL hospedada.
 */
async function uploadMediaFile(filePath) {
  assertConfigured();
  if (!filePath || !fs.existsSync(filePath)) {
    const err = new Error('Arquivo de mídia não encontrado para upload Ayrshare.');
    err.status = 422;
    throw err;
  }

  const form = new FormData();
  const fileName = path.basename(filePath);
  form.append('file', fs.createReadStream(filePath));
  form.append('fileName', fileName);
  form.append('description', 'viralizeai');

  const { data } = await axios.post(`${API}/media/upload`, form, {
    headers: {
      ...authHeaders(),
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
  });

  const url = data?.url || data?.mediaUrl || data?.data?.url;
  if (!url) {
    const err = new Error(
      'Ayrshare não retornou URL após upload de mídia. ' +
        JSON.stringify(data || {}).slice(0, 300)
    );
    err.status = 502;
    throw err;
  }
  return String(url);
}

/**
 * Resolve URL pública para o post: remote URL, APP_PUBLIC_URL+/media, ou upload Ayrshare.
 */
async function resolveMediaUrl({ filePath, imageUrl }) {
  const remote = String(imageUrl || '').trim();
  if (remote && /^https?:\/\//i.test(remote) && !remote.includes('/media/')) {
    return remote;
  }

  if (remote && /^https?:\/\//i.test(remote) && remote.includes('/media/')) {
    try {
      const parsed = new URL(remote);
      if (parsed.protocol === 'https:' || env.appPublicUrl) {
        if (parsed.hostname && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
          return remote;
        }
      }
    } catch {
      /* fall through */
    }
  }

  let local = filePath || null;
  if (!local && remote) {
    if (remote.startsWith('/media/')) {
      const relative = remote.slice('/media/'.length).replace(/\//g, path.sep);
      const absolute = storageAbsolutePath(relative);
      if (fs.existsSync(absolute)) local = absolute;
    } else {
      try {
        const parsed = new URL(remote);
        if (parsed.pathname.startsWith('/media/')) {
          const relative = parsed.pathname.slice('/media/'.length).replace(/\//g, path.sep);
          const absolute = storageAbsolutePath(relative);
          if (fs.existsSync(absolute)) local = absolute;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (local) {
    const publicUrl = publicMediaUrlFromLocal(local);
    if (publicUrl && !/localhost|127\.0\.0\.1/i.test(publicUrl)) {
      return publicUrl;
    }
    // Localhost / sem APP_PUBLIC_URL: sobe para a Ayrshare
    return uploadMediaFile(local);
  }

  if (remote && /^https?:\/\//i.test(remote)) {
    return remote;
  }

  return null;
}

/**
 * RefId e Profile Key são coisas diferentes na Ayrshare: o painel “Manage Profiles”
 * mostra o RefId (hex de ~40 chars), mas o header Profile-Key exige a chave do profile.
 * Colar o RefId faz o post cair no Primary Profile / falhar.
 */
function looksLikeRefId(value) {
  return /^[0-9a-f]{32,64}$/i.test(String(value || '').trim());
}

/**
 * Detalhes do profile referente à Profile Key informada (GET /user).
 * Serve para validar a chave e saber se a Página do Facebook está conectada.
 */
async function fetchProfileByKey(profileKey) {
  assertConfigured();
  const key = String(profileKey || '').trim();
  if (!key) {
    const err = new Error('Profile Key vazia');
    err.status = 400;
    throw err;
  }

  const { data } = await axios.get(`${API}/user`, {
    headers: authHeaders({}, key),
    timeout: 30000,
  });

  const active = Array.isArray(data?.activeSocialAccounts) ? data.activeSocialAccounts : [];
  const displayNames = Array.isArray(data?.displayNames) ? data.displayNames : [];
  const facebook = displayNames.find(
    (d) => String(d?.platform || '').toLowerCase() === 'facebook'
  );

  return {
    refId: data?.refId || null,
    title: data?.title || data?.displayTitle || null,
    isPrimary: Boolean(data?.primaryProfile ?? data?.isPrimary ?? false),
    activeSocialAccounts: active,
    facebookConnected: active.some((p) => String(p).toLowerCase() === 'facebook'),
    facebookPageName: facebook?.displayName || facebook?.pageName || facebook?.username || null,
    facebookPageId: facebook?.id || facebook?.pageId || null,
    raw: data,
  };
}

/**
 * Publica na Página Facebook ligada ao perfil Ayrshare (Primary ou User Profile).
 * Com vários profiles (Business): passe profileKey da página.
 */
async function publishToFacebook({
  post,
  filePath = null,
  imageUrl = null,
  isReel = false,
  title = null,
  profileKey = null,
}) {
  assertConfigured();

  let content = String(post || '');
  const mediaUrl = await resolveMediaUrl({ filePath, imageUrl });

  if ((isReel || filePath || imageUrl) && !mediaUrl && isReel) {
    const err = new Error(
      'Vídeo do Reel não encontrado. Aguarde o processamento ou importe o link de novo.'
    );
    err.status = 422;
    throw err;
  }

  const body = {
    post: content,
    platforms: ['facebook'],
  };

  if (mediaUrl) {
    body.mediaUrls = [mediaUrl];
  }

  if (isReel) {
    body.faceBookOptions = {
      reels: true,
    };
    if (title) body.faceBookOptions.title = String(title).slice(0, 255);
  }

  const pk = profileKey != null ? String(profileKey).trim() : '';

  console.log('[ayrshare] post', {
    hasMedia: Boolean(mediaUrl),
    isReel,
    hasProfileKey: Boolean(pk),
    mediaHost: mediaUrl ? (() => {
      try {
        return new URL(mediaUrl).hostname;
      } catch {
        return '?';
      }
    })() : null,
  });

  try {
    const { data } = await axios.post(`${API}/post`, body, {
      headers: authHeaders({ 'Content-Type': 'application/json' }, pk || null),
      timeout: 120000,
    });

    const fb =
      (Array.isArray(data?.postIds) &&
        data.postIds.find((p) => String(p.platform).toLowerCase() === 'facebook')) ||
      (Array.isArray(data?.posts) &&
        data.posts.find((p) => String(p.platform).toLowerCase() === 'facebook')) ||
      null;

    const status = String(fb?.status || data?.status || '').toLowerCase();
    if (fb && (status === 'error' || status === 'failed')) {
      const err = new Error(fb.message || fb.error || 'Falha ao publicar no Facebook via Ayrshare');
      err.status = 502;
      err.response = { data, config: { url: `${API}/post` } };
      throw err;
    }

    const postId = fb?.id || data?.id || null;
    const postUrl = fb?.postUrl || null;

    return {
      id: postId,
      post_id: postId,
      postUrl,
      provider: 'ayrshare',
      raw: data,
    };
  } catch (err) {
    if (!err.status && err.response) err.status = err.response.status || 502;
    if (!err.message || err.message === 'Request failed with status code 400') {
      err.message = apiErrorMessage(err);
    }
    throw err;
  }
}

module.exports = {
  isConfigured,
  assertConfigured,
  apiErrorMessage,
  publishToFacebook,
  resolveMediaUrl,
  uploadMediaFile,
  publicMediaUrlFromLocal,
  looksLikeRefId,
  fetchProfileByKey,
};
