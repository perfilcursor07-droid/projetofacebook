const facebookService = require('./facebookService');
const postpulseService = require('./postpulseService');
const postsyncerService = require('./postsyncerService');
const ayrshareService = require('./ayrshareService');
const PostpulseConnections = require('../models/PostpulseConnections');
const { env } = require('../config/env');
const fs = require('fs');
const path = require('path');
const { storageAbsolutePath } = require('./downloadService');
const { resolveArtworkPath } = require('./matterArtworkService');

/**
 * Decide o provedor de publicação.
 * provider: auto | ayrshare | postsyncer | postpulse | facebook
 */
async function resolveProvider(userId, page) {
  const mode = env.postpulse.publishProvider || 'auto';
  if (mode === 'facebook') return 'facebook';

  const canAyrshare = ayrshareService.isConfigured();

  if (mode === 'ayrshare') {
    if (!canAyrshare) {
      const err = new Error(
        'Publicação via Ayrshare exigida, mas AYRSHARE_API_KEY não está configurada no .env.'
      );
      err.status = 400;
      throw err;
    }
    return 'ayrshare';
  }

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

  // auto: Ayrshare → PostSyncer → PostPulse → Graph
  if (canAyrshare) return 'ayrshare';
  if (canPostsyncer) return 'postsyncer';
  return canPostpulse ? 'postpulse' : 'facebook';
}

function buildFbPostUrl(page, postId) {
  if (!postId) return null;
  const id = String(postId);
  if (
    id.startsWith('postpulse:') ||
    id.startsWith('postsyncer:') ||
    id.startsWith('ayrshare:')
  ) {
    return null;
  }
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
 * Publica foto/vídeo/reel/texto na página (Ayrshare, PostSyncer, PostPulse ou Graph API).
 */
async function publishContent({
  userId,
  page,
  tipo,
  filePath,
  imageUrl,
  texto,
  titulo,
  link,
  imagemPath,
  publicarInstagram = false,
}) {
  const provider = await resolveProvider(userId, page);

  let localFile = filePath || null;
  if (!localFile && (tipo === 'foto' || imageUrl || imagemPath)) {
    localFile = resolveLocalImageFile({ imagemPath, imageUrl });
  }

  const remoteUrl =
    !localFile && imageUrl && /^https?:\/\//i.test(String(imageUrl)) && !String(imageUrl).includes('/media/')
      ? String(imageUrl)
      : null;

  if (provider === 'ayrshare') {
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

    console.log('[publish] ayrshare', {
      pageId: page.id,
      tipo,
      hasFile: Boolean(localFile),
      file: localFile ? path.basename(localFile) : null,
    });

    const { resolvePageForUser, pagesForUser } = require('./facebookPageResolver');

    // A página precisa pertencer ao usuário logado, senão nem tenta publicar.
    const freshPage = await resolvePageForUser(userId, page.id);
    if (!freshPage) {
      const err = new Error(
        'Esta Página do Facebook não pertence à conta logada. Selecione a página padrão em /paginas.'
      );
      err.status = 403;
      throw err;
    }

    const profileKey = String(freshPage.ayrshare_profile_key || '').trim();

    // Sem Profile Key a Ayrshare publica no Primary Profile, ou seja, em outra Página.
    // Com mais de uma Página cadastrada isso publica no lugar errado — bloqueia.
    if (!profileKey) {
      const paginas = await pagesForUser(userId);
      if (paginas.length > 1) {
        const err = new Error(
          `A Página “${freshPage.page_name}” está sem Profile Key da Ayrshare. ` +
            'Sem ela o post iria para o Primary Profile (outra Página). ' +
            'Cole o Profile Key desta Página em /paginas e publique de novo.'
        );
        err.status = 422;
        err.code = 'AYRSHARE_PROFILE_KEY_MISSING';
        throw err;
      }
    }

    if (profileKey && ayrshareService.looksLikeRefId(profileKey)) {
      const err = new Error(
        `A Página “${freshPage.page_name}” tem um RefId salvo no lugar do Profile Key. ` +
          'No painel da Ayrshare, o “Manage Profiles” mostra o RefId; o ViralizeAI precisa do Profile Key ' +
          'do User Profile. Corrija em /paginas.'
      );
      err.status = 422;
      err.code = 'AYRSHARE_PROFILE_KEY_INVALID';
      throw err;
    }

    console.log('[publish] ayrshare destino', {
      pageId: freshPage.id,
      page: freshPage.page_name,
      hasProfileKey: Boolean(profileKey),
    });

    // Instagram só sai com mídia e só quando a Página está marcada em /paginas.
    const querInstagram = Boolean(publicarInstagram) && Boolean(freshPage.instagram_ativo);
    if (publicarInstagram && !freshPage.instagram_ativo) {
      console.warn(
        '[publish] instagram pedido mas a Página não está marcada em /paginas:',
        freshPage.page_name
      );
    }
    if (querInstagram && tipo === 'texto') {
      const err = new Error(
        'O Instagram não aceita post só de texto. Escolha uma imagem para a matéria ou desmarque o Instagram.'
      );
      err.status = 422;
      throw err;
    }

    const result = await ayrshareService.publishToFacebook({
      post: content,
      filePath: localFile || null,
      imageUrl: localFile ? null : remoteUrl || imageUrl || null,
      isReel: tipo === 'reel',
      title: titulo || null,
      profileKey: profileKey || null,
      publicarInstagram: querInstagram,
    });

    const postId = result.post_id || result.id;
    const nativeId = result.fb_native_post_id || null;
    return {
      ...result,
      id: postId,
      post_id: postId,
      fb_native_post_id: nativeId,
      fb_post_url:
        result.postUrl ||
        buildFbPostUrl(page, nativeId || postId),
      provider: 'ayrshare',
      instagram_pedido: Boolean(publicarInstagram),
      instagram_publicado: Boolean(result.instagram_publicado),
      instagram_post_id: result.instagram_post_id || null,
      instagram_post_url: result.instagram_post_url || null,
      instagram_erro:
        result.instagram_erro ||
        (publicarInstagram && !freshPage.instagram_ativo
          ? 'Esta Página não tem Instagram ativado em /paginas — publicou só no Facebook.'
          : null),
    };
  }

  // Só o Ayrshare integra o Instagram hoje; nos outros provedores o pedido
  // seria silenciosamente ignorado.
  if (publicarInstagram) {
    const err = new Error(
      `Instagram só está disponível pela Ayrshare (provedor atual: ${provider}). ` +
        'Ajuste PUBLISH_PROVIDER ou desmarque a opção de Instagram.'
    );
    err.status = 422;
    throw err;
  }

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
      // O adapter só usa title como fallback quando content está vazio.
      title: titulo || null,
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
  if (url.includes('ayrshare.com')) return ayrshareService.apiErrorMessage(err);
  if (url.includes('postsyncer.com')) return postsyncerService.apiErrorMessage(err);
  if (url.includes('post-pulse')) return postpulseService.apiErrorMessage(err);
  return (
    facebookService.graphErrorMessage(err) ||
    ayrshareService.apiErrorMessage(err) ||
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
