const facebookService = require('./facebookService');
const postpulseService = require('./postpulseService');
const postsyncerService = require('./postsyncerService');
const PostpulseConnections = require('../models/PostpulseConnections');
const { env } = require('../config/env');
const fs = require('fs');
const path = require('path');
const { storageAbsolutePath } = require('./downloadService');
const { resolveArtworkPath } = require('./matterArtworkService');

/**
 * Decide o provedor de publicação.
 * provider: auto | postsyncer | postpulse | facebook
 */
async function resolveProvider(userId, page) {
  const mode = env.postpulse.publishProvider || 'auto';
  if (mode === 'facebook') return 'facebook';

  const canPostsyncer =
    postsyncerService.isConfigured() && Boolean(page?.postsyncer_account_id);

  if (mode === 'postsyncer') {
    if (!canPostsyncer) {
      const err = new Error(
        'Publicação via PostSyncer exigida, mas a página não está vinculada. Em /paginas sincronize o PostSyncer.'
      );
      err.status = 400;
      throw err;
    }
    return 'postsyncer';
  }

  const conn = await PostpulseConnections.findByUser(userId);
  const canPostpulse =
    postpulseService.isConfigured() && Boolean(conn?.access_token) && Boolean(page?.postpulse_account_id);

  if (mode === 'postpulse') {
    if (!canPostpulse) {
      const err = new Error(
        'Publicação via PostPulse exigida, mas a página não está vinculada. Conecte o PostPulse em /paginas e sincronize.'
      );
      err.status = 400;
      throw err;
    }
    return 'postpulse';
  }

  // auto: PostSyncer → PostPulse → Graph
  if (canPostsyncer) return 'postsyncer';
  return canPostpulse ? 'postpulse' : 'facebook';
}

function buildFbPostUrl(page, postId) {
  if (!postId) return null;
  const id = String(postId);
  if (id.startsWith('postpulse:') || id.startsWith('postsyncer:')) return null;
  if (id.includes('_')) return `https://www.facebook.com/${id}`;
  return `https://www.facebook.com/${page.page_id}/posts/${id}`;
}

/**
 * Converte imagem da matéria em arquivo local (PostPulse/PostSyncer exigem upload ou https).
 * Aceita imagem_path (artes/…) ou URL /media/….
 */
function resolveLocalImageFile({ imagemPath, imageUrl }) {
  const fromArtwork = resolveArtworkPath(imagemPath);
  if (fromArtwork) return fromArtwork;

  const url = String(imageUrl || '').trim();
  if (!url) return null;

  if (url.startsWith('/media/')) {
    const relative = url.slice('/media/'.length).replace(/\//g, path.sep);
    const absolute = storageAbsolutePath(relative);
    if (fs.existsSync(absolute)) return absolute;
  }

  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/media/')) {
      const relative = parsed.pathname.slice('/media/'.length).replace(/\//g, path.sep);
      const absolute = storageAbsolutePath(relative);
      if (fs.existsSync(absolute)) return absolute;
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * Publica foto/vídeo/reel/texto na página (PostSyncer, PostPulse ou Graph API).
 */
async function publishContent({ userId, page, tipo, filePath, imageUrl, texto, titulo, link, imagemPath }) {
  const provider = await resolveProvider(userId, page);

  let localFile = filePath || null;
  if (!localFile && (tipo === 'foto' || imageUrl || imagemPath)) {
    localFile = resolveLocalImageFile({ imagemPath, imageUrl });
  }

  const remoteUrl =
    !localFile && imageUrl && /^https?:\/\//i.test(String(imageUrl)) && !String(imageUrl).includes('/media/')
      ? String(imageUrl)
      : null;

  if (provider === 'postsyncer') {
    let content = texto || '';
    if (link) content = content ? `${content}\n\n${link}` : link;

    if (tipo === 'foto' && !localFile && !remoteUrl) {
      const err = new Error(
        'Imagem da arte não encontrada no servidor. Gere a arte novamente antes de publicar.'
      );
      err.status = 422;
      throw err;
    }

    if (tipo === 'reel' && !localFile) {
      const err = new Error(
        'Vídeo do Reel não encontrado para upload. Aguarde o processamento ou importe o link de novo.'
      );
      err.status = 422;
      throw err;
    }

    const publicationType = tipo === 'reel' ? 'REELS' : 'POST';
    const FacebookPages = require('../models/FacebookPages');
    const freshPage = await FacebookPages.findById(page.id);

    console.log('[publish] postsyncer', {
      pageId: page.id,
      tipo,
      publicationType,
      hasFile: Boolean(localFile),
      file: localFile ? path.basename(localFile) : null,
    });

    const result = await postsyncerService.publishToFacebook({
      accountId: freshPage.postsyncer_account_id || page.postsyncer_account_id,
      content,
      filePath: localFile || null,
      imageUrl: localFile ? null : remoteUrl,
      publicationType,
      // Em REELS o title sobrescreve a legenda no Facebook — só usar em POST
      title: publicationType === 'REELS' ? null : titulo || null,
      link: link || null,
      scheduleType: 'publish_now',
    });

    const postId = result.post_id || result.id;
    return {
      ...result,
      id: postId,
      post_id: postId,
      fb_post_url: buildFbPostUrl(page, postId),
    };
  }

  if (provider === 'postpulse') {
    const conn = await PostpulseConnections.findByUser(userId);
    const publicationType = tipo === 'reel' ? 'REELS' : 'FEED';
    let content = texto || '';
    if (link) content = content ? `${content}\n\n${link}` : link;

    const { ensureChatId } = require('./postpulseSync');
    const chatId = await ensureChatId(userId, page);
    if (!chatId) {
      const err = new Error(
        'PostPulse: Página (chat) não encontrada. Em /paginas clique em Sincronizar páginas. No PostPulse a conta Facebook precisa ter a Page conectada.'
      );
      err.status = 400;
      throw err;
    }

    const FacebookPages = require('../models/FacebookPages');
    const freshPage = await FacebookPages.findById(page.id);

    if (tipo === 'foto' && !localFile && !remoteUrl) {
      const err = new Error(
        'Imagem da arte não encontrada no servidor. Gere a arte novamente antes de publicar.'
      );
      err.status = 422;
      throw err;
    }

    const result = await postpulseService.publishToFacebook({
      accessToken: conn.access_token,
      socialMediaAccountId: freshPage.postpulse_account_id || page.postpulse_account_id,
      chatId: freshPage.postpulse_chat_id || chatId,
      content,
      filePath: localFile || null,
      imageUrl: localFile ? null : remoteUrl,
      publicationType,
    });
    const postId = result.post_id || result.id;
    return {
      ...result,
      id: postId,
      post_id: postId,
      fb_post_url: buildFbPostUrl(page, postId),
    };
  }

  let result;
  if (tipo === 'reel') {
    result = await facebookService.publishReel({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath: localFile || filePath,
      description: texto,
      title: titulo,
    });
  } else if (tipo === 'video') {
    result = await facebookService.publishVideo({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath: localFile || filePath,
      description: texto,
    });
  } else if (tipo === 'foto' && localFile) {
    result = await facebookService.publishPhoto({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath: localFile,
      caption: texto,
    });
  } else if (tipo === 'foto' && remoteUrl) {
    result = await facebookService.publishPhotoFromUrl({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      imageUrl: remoteUrl,
      caption: texto,
    });
  } else {
    result = await facebookService.publishText({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      message: texto,
      link,
    });
  }

  const postId = result.post_id || result.id;
  return {
    ...result,
    id: postId,
    post_id: postId,
    fb_post_url: buildFbPostUrl(page, postId),
    provider: 'facebook',
  };
}

function publishErrorMessage(err) {
  const url = String(err.response?.config?.url || '');
  if (url.includes('postsyncer.com')) return postsyncerService.apiErrorMessage(err);
  if (url.includes('post-pulse')) return postpulseService.apiErrorMessage(err);
  return (
    facebookService.graphErrorMessage(err) ||
    postsyncerService.apiErrorMessage(err) ||
    postpulseService.apiErrorMessage(err)
  );
}

module.exports = {
  resolveProvider,
  publishContent,
  publishErrorMessage,
  buildFbPostUrl,
  resolveLocalImageFile,
};
