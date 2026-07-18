const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const processingService = require('../services/processingService');
const {
  resolveCapaTitulo,
  queueClipCover,
  queueClipMateriaAndCover,
} = require('../services/clipPostProcessService');
const deepseekService = require('../services/deepseekService');

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function assertOwnedClip(req) {
  const clip = await VideoClips.findById(req.params.id);
  if (!clip) throw httpError('Clipe não encontrado', 404);
  const video = await Videos.findById(clip.video_id);
  if (!video || video.user_id !== req.session.userId) {
    throw httpError('Clipe não encontrado', 404);
  }
  return { clip, video };
}

/** Reenfileira um corte preso em processando/erro. */
async function retryClip(req, res, next) {
  try {
    const { clip, video } = await assertOwnedClip(req);
    if (!['processando', 'erro'].includes(clip.status)) {
      throw httpError('Só é possível retentar cortes em processando ou erro', 422);
    }
    if (!video.caminho_local) {
      throw httpError('Baixe o vídeo original antes de gerar o corte', 422);
    }

    await VideoClips.update(clip.id, {
      status: 'processando',
      erro_mensagem: null,
      caminho_arquivo: null,
    });

    const updated = await VideoClips.findById(clip.id);
    processingService.queueClipGeneration(updated, video);

    res.status(202).json({ queued: true, clipId: clip.id, message: 'Corte reenfileirado' });
  } catch (err) {
    next(err);
  }
}

/** Remove um corte (e o arquivo local). */
async function removeClip(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    processingService.safeUnlink(clip.caminho_arquivo);
    if (clip.arquivo_sem_capa && clip.arquivo_sem_capa !== clip.caminho_arquivo) {
      processingService.safeUnlink(clip.arquivo_sem_capa);
    }
    await VideoClips.remove(clip.id);
    res.json({ deleted: true, id: clip.id });
  } catch (err) {
    next(err);
  }
}

/** Enfileira extração de fala (legendas yt-dlp ou Whisper local). */
async function transcribe(req, res, next) {
  try {
    const { clip, video } = await assertOwnedClip(req);
    if (clip.status !== 'pronto' && clip.status !== 'publicado') {
      throw httpError('O clipe precisa estar pronto antes de extrair a fala', 422);
    }
    if (!clip.caminho_arquivo) {
      throw httpError('Clipe sem arquivo — gere o corte novamente', 422);
    }

    await VideoClips.update(clip.id, {
      materia_status: 'gerando',
      erro_mensagem: null,
    });

    queueClipMateriaAndCover(clip, video, {
      userId: req.session.userId,
      force: true,
    });

    res.status(202).json({
      queued: true,
      clipId: clip.id,
      message: 'Extração de fala + matéria + capa enfileiradas',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Gera matéria com DeepSeek a partir da transcrição.
 * Ao terminar, gera automaticamente a capa de marca no início do vídeo.
 */
async function gerarMateria(req, res, next) {
  try {
    const { clip, video } = await assertOwnedClip(req);
    if (clip.status !== 'pronto' && clip.status !== 'publicado') {
      throw httpError('O clipe precisa estar pronto antes de gerar a matéria', 422);
    }
    if (!clip.caminho_arquivo) {
      throw httpError('Clipe sem arquivo — gere o corte novamente', 422);
    }

    deepseekService.assertDeepseek();
    const tema = String(req.body.tema || '').trim() || null;

    await VideoClips.update(clip.id, {
      materia_status: 'gerando',
      erro_mensagem: null,
    });

    queueClipMateriaAndCover(clip, video, {
      tema,
      userId: req.session.userId,
      force: true,
    });

    res.status(202).json({
      queued: true,
      clipId: clip.id,
      message: 'Geração de matéria enfileirada — a capa será criada em seguida',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Gera capa de marca (frame + título) e costura no início do corte.
 * body.titulo opcional — se vazio, usa matéria / título do vídeo.
 */
async function gerarCapa(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    if (clip.status !== 'pronto' && clip.status !== 'publicado') {
      throw httpError('O clipe precisa estar pronto antes de gerar a capa', 422);
    }
    // Se ficou presa em "gerando" (restart/crash), libera e tenta de novo
    if (clip.capa_status === 'gerando') {
      await VideoClips.update(clip.id, { capa_status: 'pendente', erro_mensagem: null });
    }

    const result = await queueClipCover({
      clipId: clip.id,
      userId: req.session.userId,
      titulo: String(req.body.titulo || '').trim() || null,
    });

    res.status(202).json({
      queued: true,
      clipId: clip.id,
      titulo: result.titulo,
      message: 'Geração da capa enfileirada',
    });
  } catch (err) {
    next(err);
  }
}

/** Remove a capa e volta ao corte original. */
async function removerCapa(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    if (!clip.arquivo_sem_capa) {
      throw httpError('Este corte não tem capa aplicada', 422);
    }
    if (clip.caminho_arquivo !== clip.arquivo_sem_capa) {
      processingService.safeUnlink(clip.caminho_arquivo);
    }
    await VideoClips.update(clip.id, {
      caminho_arquivo: clip.arquivo_sem_capa,
      arquivo_sem_capa: null,
      capa_titulo: null,
      capa_status: 'pendente',
    });
    res.json({ ok: true, message: 'Capa removida — corte original restaurado' });
  } catch (err) {
    next(err);
  }
}

/** Página dedicada: revisar matéria e publicar o corte. */
async function showClipPage(req, res, next) {
  try {
    const clip = await VideoClips.findById(req.params.id);
    if (!clip) {
      const err = httpError('Corte não encontrado', 404);
      return next(err);
    }
    const video = await Videos.findById(clip.video_id);
    if (!video || video.user_id !== req.session.userId) {
      return next(httpError('Corte não encontrado', 404));
    }

    let materia = String(clip.legenda_sugerida || '').trim();
    if (!materia || /^\[(sem fala|falha)/i.test(materia)) materia = '';

    res.render('fila-corte', {
      title: `Corte #${clip.id}`,
      clip,
      video,
      materia,
      currentPath: '/fila',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  transcribe,
  gerarMateria,
  retryClip,
  removeClip,
  gerarCapa,
  removerCapa,
  queueClipCover,
  resolveCapaTitulo,
  showClipPage,
};
