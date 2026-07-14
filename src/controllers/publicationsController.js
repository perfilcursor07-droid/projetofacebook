const fs = require('fs');
const path = require('path');
const Publications = require('../models/Publications');
const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const Imagens = require('../models/Imagens');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const facebookService = require('../services/facebookService');
const { validateReelFile } = require('../services/ffmpegService');
const { storageAbsolutePath } = require('../services/downloadService');
const { enqueue } = require('../workers/queue');

// Formatos aceitos pela Graph API de fotos; limite de 10MB por arquivo.
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'];
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

async function resolvePage(userId, facebookPageId) {
  const page = await FacebookPages.findById(facebookPageId);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || page.facebook_account_id !== account.id) return null;
  return page;
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function queuePublication({ publicationId, page, filePath, texto, titulo, tipo, onSuccess }) {
  enqueue(`publish ${tipo} pub ${publicationId}`, async () => {
    try {
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
      } else if (tipo === 'foto') {
        result = await facebookService.publishPhoto({
          pageId: page.page_id,
          pageAccessToken: page.page_access_token,
          filePath,
          caption: texto,
        });
      } else {
        result = await facebookService.publishText({
          pageId: page.page_id,
          pageAccessToken: page.page_access_token,
          message: texto,
        });
      }

      const postId = result.post_id || result.id;
      await Publications.update(publicationId, {
        status: 'publicado',
        fb_post_id: postId,
        fb_post_url:
          tipo === 'reel'
            ? `https://www.facebook.com/reel/${postId}`
            : `https://www.facebook.com/${postId}`,
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

/**
 * Publica um clipe pronto em uma página.
 * body.modo: "reel" (padrão) publica via Reels API; "video" publica como vídeo comum.
 */
async function publishClip(req, res, next) {
  try {
    const clip = await VideoClips.findById(req.params.id);
    if (!clip) throw httpError('Clipe não encontrado', 404);

    const video = await Videos.findById(clip.video_id);
    if (!video || video.user_id !== req.session.userId) {
      throw httpError('Clipe não encontrado', 404);
    }
    if (clip.status !== 'pronto' && clip.status !== 'publicado') {
      throw httpError('O clipe ainda não está pronto para publicar', 422);
    }

    const page = await resolvePage(req.session.userId, req.body.facebook_page_id);
    if (!page) throw httpError('Página do Facebook inválida ou não conectada', 400);

    const modo = req.body.modo === 'video' ? 'video' : 'reel';
    const filePath = storageAbsolutePath(clip.caminho_arquivo);
    if (!fs.existsSync(filePath)) {
      throw httpError('Arquivo do clipe não encontrado no disco — gere o corte novamente', 422);
    }

    let avisos = [];
    if (modo === 'reel') {
      const check = await validateReelFile(filePath);
      if (!check.ok) {
        throw httpError(
          `O clipe não atende aos requisitos de Reels: ${check.erros.join('; ')}`,
          422
        );
      }
      avisos = check.avisos;

      const publicadosHoje = await Publications.countReelsLast24h(page.id);
      if (publicadosHoje >= facebookService.REELS_DAILY_LIMIT) {
        throw httpError(
          `Limite da API de Reels atingido (${facebookService.REELS_DAILY_LIMIT} publicações por página a cada 24h)`,
          429
        );
      }
    }

    const texto = (req.body.legenda || clip.legenda_sugerida || '').trim();
    const titulo = (req.body.titulo || '').trim() || null;

    const [pubId] = await Publications.create({
      video_clip_id: clip.id,
      facebook_page_id: page.id,
      tipo: modo,
      texto: texto || null,
      status: 'pendente',
    });

    queuePublication({
      publicationId: pubId,
      page,
      filePath,
      texto,
      titulo,
      tipo: modo,
      async onSuccess() {
        await VideoClips.update(clip.id, { status: 'publicado' });
        await Videos.update(video.id, { status: 'publicado' });
      },
    });

    res.status(202).json({ publicationId: pubId, queued: true, tipo: modo, avisos });
  } catch (err) {
    next(err);
  }
}

/** Publica uma imagem baixada em uma página. */
async function publishImage(req, res, next) {
  try {
    const imagem = await Imagens.findById(req.params.id);
    if (!imagem || imagem.user_id !== req.session.userId) {
      throw httpError('Imagem não encontrada', 404);
    }
    if (!imagem.caminho_local) throw httpError('Baixe a imagem antes de publicar', 422);

    const filePath = storageAbsolutePath(imagem.caminho_local);
    if (!fs.existsSync(filePath)) {
      throw httpError('Arquivo da imagem não encontrado no disco — baixe novamente', 422);
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!PHOTO_EXTENSIONS.includes(ext)) {
      throw httpError(`Formato ${ext || 'desconhecido'} não aceito pelo Facebook (use JPEG, PNG, GIF, BMP ou TIFF)`, 422);
    }
    const { size } = fs.statSync(filePath);
    if (size > PHOTO_MAX_BYTES) {
      throw httpError('Imagem maior que 10MB — o Facebook rejeita fotos acima desse tamanho', 422);
    }

    const page = await resolvePage(req.session.userId, req.body.facebook_page_id);
    if (!page) throw httpError('Página do Facebook inválida ou não conectada', 400);

    const texto = (req.body.legenda || imagem.materia || '').trim();

    const [pubId] = await Publications.create({
      imagem_id: imagem.id,
      facebook_page_id: page.id,
      tipo: 'foto',
      texto: texto || null,
      status: 'pendente',
    });

    queuePublication({
      publicationId: pubId,
      page,
      filePath,
      texto,
      tipo: 'foto',
      async onSuccess() {
        await Imagens.update(imagem.id, { status: 'publicado' });
      },
    });

    res.status(202).json({ publicationId: pubId, queued: true, tipo: 'foto' });
  } catch (err) {
    next(err);
  }
}

/** Publica um post apenas de texto (com link opcional) no feed da página. */
async function publishTextPost(req, res, next) {
  try {
    const texto = String(req.body.texto || req.body.legenda || '').trim();
    if (!texto) throw httpError('Informe o texto do post', 400);
    if (texto.length > 63206) {
      throw httpError('Texto acima do limite do Facebook (63.206 caracteres)', 422);
    }

    const link = String(req.body.link || '').trim();
    if (link && !/^https?:\/\//i.test(link)) {
      throw httpError('Link inválido: use uma URL http(s)', 400);
    }

    const page = await resolvePage(req.session.userId, req.body.facebook_page_id);
    if (!page) throw httpError('Página do Facebook inválida ou não conectada', 400);

    const [pubId] = await Publications.create({
      facebook_page_id: page.id,
      tipo: 'texto',
      texto,
      status: 'pendente',
    });

    enqueue(`publish texto pub ${pubId}`, async () => {
      try {
        const result = await facebookService.publishText({
          pageId: page.page_id,
          pageAccessToken: page.page_access_token,
          message: texto,
          link: link || undefined,
        });
        await Publications.update(pubId, {
          status: 'publicado',
          fb_post_id: result.id,
          fb_post_url: `https://www.facebook.com/${result.id}`,
          published_at: new Date(),
          erro_mensagem: null,
        });
      } catch (err) {
        await Publications.update(pubId, {
          status: 'erro',
          erro_mensagem: facebookService.graphErrorMessage(err).slice(0, 500),
        });
        await Publications.increment(pubId);
        throw err;
      }
    });

    res.status(202).json({ publicationId: pubId, queued: true, tipo: 'texto' });
  } catch (err) {
    next(err);
  }
}

/** Lista publicações recentes do usuário (todos os tipos). */
async function listPublications(req, res, next) {
  try {
    const publications = await Publications.recent(req.session.userId, 50);
    res.json({ publications });
  } catch (err) {
    next(err);
  }
}

module.exports = { publishClip, publishImage, publishTextPost, listPublications };
