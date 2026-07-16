const facebookService = require('./facebookService');
const postpulseService = require('./postpulseService');
const PostpulseConnections = require('../models/PostpulseConnections');
const { env } = require('../config/env');

/**
 * Decide se a publicação deve ir pelo PostPulse.
 * provider: auto | postpulse | facebook
 */
async function resolveProvider(userId, page) {
  const mode = env.postpulse.publishProvider || 'auto';
  if (mode === 'facebook') return 'facebook';

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

  return canPostpulse ? 'postpulse' : 'facebook';
}

function buildFbPostUrl(page, postId) {
  if (!postId) return null;
  const id = String(postId);
  if (id.startsWith('postpulse:')) return null;
  if (id.includes('_')) return `https://www.facebook.com/${id}`;
  return `https://www.facebook.com/${page.page_id}/posts/${id}`;
}

/**
 * Publica foto/vídeo/reel/texto na página (PostPulse ou Graph API).
 * Aceita filePath local e/ou imageUrl pública.
 */
async function publishContent({ userId, page, tipo, filePath, imageUrl, texto, titulo, link }) {
  const provider = await resolveProvider(userId, page);

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

    // Garante page atualizado com chat_id
    const FacebookPages = require('../models/FacebookPages');
    const freshPage = await FacebookPages.findById(page.id);

    const result = await postpulseService.publishToFacebook({
      accessToken: conn.access_token,
      socialMediaAccountId: freshPage.postpulse_account_id || page.postpulse_account_id,
      chatId: freshPage.postpulse_chat_id || chatId,
      content,
      filePath: filePath || null,
      imageUrl: imageUrl || null,
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
      filePath,
      description: texto,
      title: titulo,
    });
  } else if (tipo === 'video') {
    result = await facebookService.publishVideo({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath,
      description: texto,
    });
  } else if (tipo === 'foto' && filePath) {
    result = await facebookService.publishPhoto({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      filePath,
      caption: texto,
    });
  } else if (tipo === 'foto' && imageUrl) {
    result = await facebookService.publishPhotoFromUrl({
      pageId: page.page_id,
      pageAccessToken: page.page_access_token,
      imageUrl,
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
  if (url.includes('post-pulse')) return postpulseService.apiErrorMessage(err);
  return facebookService.graphErrorMessage(err) || postpulseService.apiErrorMessage(err);
}

module.exports = {
  resolveProvider,
  publishContent,
  publishErrorMessage,
  buildFbPostUrl,
};
