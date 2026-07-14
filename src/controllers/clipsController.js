const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const deepseekService = require('../services/deepseekService');
const transcriptionService = require('../services/transcriptionService');
const processingService = require('../services/processingService');
const { enqueue } = require('../workers/queue');

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

    enqueue(`transcribe clip ${clip.id}`, async () => {
      try {
        const result = await transcriptionService.transcribeClip({
          clipPath: clip.caminho_arquivo,
          sourceUrl: video.url_original,
        });
        await VideoClips.update(clip.id, {
          transcricao: result.text,
          materia_status: 'pendente',
          erro_mensagem: null,
        });
      } catch (err) {
        await VideoClips.update(clip.id, {
          materia_status: 'erro',
          erro_mensagem: `Transcrição falhou: ${String(err.message || err).slice(0, 400)}`,
        });
        throw err;
      }
    });

    res.status(202).json({ queued: true, clipId: clip.id, message: 'Extração de fala enfileirada' });
  } catch (err) {
    next(err);
  }
}

/**
 * Gera matéria com DeepSeek a partir da transcrição.
 * Se ainda não houver transcrição, extrai a fala na mesma fila e depois gera.
 * body.tema opcional.
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

    const fresh = await VideoClips.findById(clip.id);

    enqueue(`materia clip ${clip.id}`, async () => {
      try {
        let transcricao = fresh.transcricao;
        let idioma = null;

        if (!transcricao) {
          const result = await transcriptionService.transcribeClip({
            clipPath: clip.caminho_arquivo,
            sourceUrl: video.url_original,
          });
          transcricao = result.text;
          idioma = result.language;
          await VideoClips.update(clip.id, { transcricao });
        }

        const gerado = await deepseekService.gerarMateriaVideo({
          transcricao,
          titulo: video.titulo || video.termo_busca,
          tema,
          idioma,
        });

        await VideoClips.update(clip.id, {
          legenda_sugerida: gerado.materia,
          materia_status: 'pronta',
          erro_mensagem: null,
        });
      } catch (err) {
        await VideoClips.update(clip.id, {
          materia_status: 'erro',
          erro_mensagem: `Matéria falhou: ${String(err.message || err).slice(0, 400)}`,
        });
        throw err;
      }
    });

    res.status(202).json({ queued: true, clipId: clip.id, message: 'Geração de matéria enfileirada' });
  } catch (err) {
    next(err);
  }
}

module.exports = { transcribe, gerarMateria, retryClip, removeClip };
