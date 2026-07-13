const Publications = require('../models/Publications');
const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const Imagens = require('../models/Imagens');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const facebookService = require('../services/facebookService');
const { storageAbsolutePath } = require('../services/downloadService');
const { enqueue } = require('../workers/queue');

async function resolvePage(userId, facebookPageId) {
  const page = await FacebookPages.findById(facebookPageId);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || page.facebook_account_id !== account.id) return null;
  return page;
}

function queuePublication({ publicationId, page, filePath, texto, tipo, onSuccess }) {
  enqueue(`publish ${tipo} pub ${publicationId}`, async () => {
    try {
      const fn = tipo === 'video' ? facebookService.publishVideo : facebookService.publishPhoto;
      const result = await fn({
        pageId: page.page_id,
        pageAccessToken: page.page_access_token,
        filePath,
        description: texto,
        caption: texto,
      });

      const postId = result.post_id || result.id;
      await Publications.update(publicationId, {
        status: 'publicado',
        fb_post_id: postId,
        fb_post_url: `https://www.facebook.com/${postId}`,
        published_at: new Date(),
        erro_mensagem: null,
      });
      if (onSuccess) await onSuccess();
    } catch (err) {
      await Publications.update(publicationId, {
        status: 'erro',
        erro_mensagem: facebookService.graphErrorMessage(err).slice(0, 500),
      });
      await Publications.increment(publicationId);
      throw err;
    }
  });
}

/** Publica um clipe pronto em uma página. */
async function publishClip(req, res, next) {
  try {
    const clip = await VideoClips.findById(req.params.id);
    if (!clip) {
      const err = new Error('Clipe não encontrado');
      err.status = 404;
      throw err;
    }

    const video = await Videos.findById(clip.video_id);
    if (!video || video.user_id !== req.session.userId) {
      const err = new Error('Clipe não encontrado');
      err.status = 404;
      throw err;
    }
    if (clip.status !== 'pronto' && clip.status !== 'publicado') {
      const err = new Error('O clipe ainda não está pronto para publicar');
      err.status = 422;
      throw err;
    }

    const page = await resolvePage(req.session.userId, req.body.facebook_page_id);
    if (!page) {
      const err = new Error('Página do Facebook inválida ou não conectada');
      err.status = 400;
      throw err;
    }

    const texto = (req.body.legenda || clip.legenda_sugerida || '').trim();

    const [pubId] = await Publications.create({
      video_clip_id: clip.id,
      facebook_page_id: page.id,
      status: 'pendente',
    });

    queuePublication({
      publicationId: pubId,
      page,
      filePath: storageAbsolutePath(clip.caminho_arquivo),
      texto,
      tipo: 'video',
      async onSuccess() {
        await VideoClips.update(clip.id, { status: 'publicado' });
        await Videos.update(video.id, { status: 'publicado' });
      },
    });

    res.status(202).json({ publicationId: pubId, queued: true });
  } catch (err) {
    next(err);
  }
}

/** Publica uma imagem baixada em uma página. */
async function publishImage(req, res, next) {
  try {
    const imagem = await Imagens.findById(req.params.id);
    if (!imagem || imagem.user_id !== req.session.userId) {
      const err = new Error('Imagem não encontrada');
      err.status = 404;
      throw err;
    }
    if (!imagem.caminho_local) {
      const err = new Error('Baixe a imagem antes de publicar');
      err.status = 422;
      throw err;
    }

    const page = await resolvePage(req.session.userId, req.body.facebook_page_id);
    if (!page) {
      const err = new Error('Página do Facebook inválida ou não conectada');
      err.status = 400;
      throw err;
    }

    const texto = (req.body.legenda || '').trim();

    const [pubId] = await Publications.create({
      imagem_id: imagem.id,
      facebook_page_id: page.id,
      status: 'pendente',
    });

    queuePublication({
      publicationId: pubId,
      page,
      filePath: storageAbsolutePath(imagem.caminho_local),
      texto,
      tipo: 'foto',
      async onSuccess() {
        await Imagens.update(imagem.id, { status: 'publicado' });
      },
    });

    res.status(202).json({ publicationId: pubId, queued: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { publishClip, publishImage };
