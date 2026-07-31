const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const processingService = require('../services/processingService');
const {
  resolveCapaTitulo,
  queueClipCover,
  queueClipMateriaAndCover,
} = require('../services/clipPostProcessService');
const deepseekService = require('../services/deepseekService');
const clipSplitService = require('../services/clipSplitService');

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
    const arquivos = new Set(
      [
        clip.caminho_arquivo,
        clip.arquivo_sem_capa,
        clip.arquivo_sem_split,
        clip.split_image_path,
        `clips/clip_${clip.id}.mp4`,
      ].filter(Boolean)
    );
    for (const arquivo of arquivos) processingService.safeUnlink(arquivo);
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
      // Mantém o título para facilitar gerar de novo; só tira a capa do arquivo.
      capa_status: 'pendente',
    });
    res.json({
      ok: true,
      message: 'Capa desmarcada — vídeo sem capa',
      video_url: `/media/${String(clip.arquivo_sem_capa).replace(/^\/+/, '')}`,
      capa_status: 'pendente',
      capa_titulo: clip.capa_titulo || '',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Monta a tela dividida do corte: imagem de um lado, vídeo do outro.
 * Aceita JSON (imagem da busca / frame) ou multipart (upload).
 */
async function montarSplit(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    const body = req.body || {};
    const fonte = req.file ? 'upload' : String(body.fonte || body.origem || 'busca');

    if (fonte === 'busca' && !String(body.imagem_url || body.imagemUrl || '').trim()) {
      throw httpError('Escolha uma imagem na busca ou envie um arquivo.', 400);
    }

    const result = await clipSplitService.aplicarSplitNoClip({
      clipId: clip.id,
      userId: req.session.userId,
      fonte,
      imagemUrl: String(body.imagem_url || body.imagemUrl || '').trim() || null,
      buffer: req.file?.buffer || null,
      frameSegundo: body.frame_segundo ?? body.frameSegundo,
      videoOffset: body.video_offset ?? body.videoOffset,
      imageOffset: body.imagem_offset ?? body.imageOffset,
      imagemLado: body.imagem_lado ?? body.imagemLado,
      texto: body.texto ?? body.split_texto,
      textoPosicao: body.texto_posicao ?? body.textoPosicao ?? body.split_texto_posicao,
      textoTamanho: body.texto_tamanho ?? body.textoTamanho ?? body.split_texto_tamanho,
    });

    res.status(202).json({
      ...result,
      clipId: clip.id,
      message: 'Montando a tela dividida — o vídeo atualiza em alguns segundos.',
    });
  } catch (err) {
    next(err);
  }
}

/** Reaplica a tela dividida mudando só o enquadramento (empurra imagem/vídeo). */
async function reenquadrarSplit(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    const body = req.body || {};
    const result = await clipSplitService.reenquadrarSplit({
      clipId: clip.id,
      userId: req.session.userId,
      videoOffset: body.video_offset ?? body.videoOffset,
      imageOffset: body.imagem_offset ?? body.imageOffset,
      imagemLado: body.imagem_lado ?? body.imagemLado,
      texto: body.texto ?? body.split_texto,
      textoPosicao: body.texto_posicao ?? body.textoPosicao ?? body.split_texto_posicao,
      textoTamanho: body.texto_tamanho ?? body.textoTamanho ?? body.split_texto_tamanho,
    });
    res.status(202).json({ ...result, clipId: clip.id, message: 'Reenquadrando…' });
  } catch (err) {
    next(err);
  }
}

/** Remove a tela dividida e volta ao vídeo cheio. */
async function removerSplit(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    await clipSplitService.removerSplitDoClip({
      clipId: clip.id,
      userId: req.session.userId,
    });
    res.json({ ok: true, message: 'Tela dividida removida — corte original restaurado.' });
  } catch (err) {
    next(err);
  }
}

/** Miniaturas do próprio corte para usar como imagem da tela dividida. */
async function listarFramesDoSplit(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    const frames = await clipSplitService.listarFramesDoClip(
      clip,
      req.query.quantidade || req.query.count || 6
    );
    res.json({ ok: true, frames });
  } catch (err) {
    next(err);
  }
}

/** Busca fotos na web (Brave e afins) para a metade da tela dividida. */
async function buscarImagensDoSplit(req, res, next) {
  try {
    await assertOwnedClip(req);
    const termo = String(req.query.q || req.query.termo || '').trim();
    const imageSuggestService = require('../services/imageSuggestService');

    if (String(req.query.fonte || '').toLowerCase() === 'brave') {
      const imagens = await imageSuggestService.buscarBraveImagens(termo, { count: 16 });
      if (!imagens.length) throw httpError(`Nenhuma imagem encontrada para “${termo}”.`, 422);
      return res.json({ ok: true, imagens, aviso: 'Fotos via Brave Images' });
    }

    const result = await imageSuggestService.buscarImagensPorPalavra(termo, { limite: 16 });
    res.json({ ok: true, imagens: result.imagens, aviso: result.aviso });
  } catch (err) {
    next(err);
  }
}

/**
 * Status leve do corte — o front usa para atualizar só o vídeo/badges
 * sem recarregar a página inteira (evita perder edições do usuário).
 */
async function statusClip(req, res, next) {
  try {
    const { clip } = await assertOwnedClip(req);
    let materia = String(clip.legenda_sugerida || '').trim();
    if (!materia || /^\[(sem fala|falha)/i.test(materia)) materia = '';

    const videoUrl = clip.caminho_arquivo
      ? `/media/${String(clip.caminho_arquivo).replace(/^\/+/, '')}`
      : null;

    res.json({
      ok: true,
      id: clip.id,
      status: clip.status,
      materia_status: clip.materia_status || 'pendente',
      capa_status: clip.capa_status || 'pendente',
      capa_titulo: clip.capa_titulo || '',
      split_status: clip.split_status || 'pendente',
      layout: clip.layout || 'normal',
      split_erro: clip.split_erro || null,
      erro_mensagem: clip.erro_mensagem || null,
      materia,
      video_url: videoUrl,
      split_imagem_url: clip.split_image_path ? `/media/${clip.split_image_path}` : null,
      split_video_offset: Number(clip.split_video_offset) || 50,
      split_image_offset: Number(clip.split_image_offset) || 50,
      split_texto: clip.split_texto || '',
      split_texto_posicao: clip.split_texto_posicao === 'topo' ? 'topo' : 'rodape',
      split_texto_tamanho: Math.min(160, Math.max(70, Number(clip.split_texto_tamanho) || 100)),
      preview_base_url: clipSplitService.previewBaseUrl(clip),
      updated_at: clip.updated_at || null,
    });
  } catch (err) {
    next(err);
  }
}

/** IA sugere o texto fixo do Reel (com tom e [[destaques]]). */
async function sugerirTextoSplit(req, res, next) {
  try {
    const { clip, video } = await assertOwnedClip(req);
    const body = req.body || {};
    const tom = String(body.tom || 'natural').toLowerCase();

    let materia = String(clip.legenda_sugerida || '').trim();
    if (!materia || /^\[(sem fala|falha)/i.test(materia)) materia = '';

    const result = await deepseekService.sugerirTextoSplitVideo({
      transcricao: clip.transcricao || '',
      materia,
      titulo: String(body.titulo || clip.capa_titulo || '').trim() || null,
      tituloVideo: video.titulo || video.termo_busca || null,
      tom,
      textoAtual: String(body.texto_atual || body.texto || clip.split_texto || '').trim(),
    });

    res.json({ ok: true, ...result });
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
      // Vídeo sem capa/tela dividida: é o que o preview da tela dividida usa.
      previewBaseUrl: clipSplitService.previewBaseUrl(clip),
      splitImagemUrl: clip.split_image_path ? `/media/${clip.split_image_path}` : null,
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
  montarSplit,
  reenquadrarSplit,
  removerSplit,
  listarFramesDoSplit,
  buscarImagensDoSplit,
  sugerirTextoSplit,
  statusClip,
  queueClipCover,
  resolveCapaTitulo,
  showClipPage,
};
