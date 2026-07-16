const fs = require('fs');
const path = require('path');
const Videos = require('../models/Videos');
const Imagens = require('../models/Imagens');
const VideoClips = require('../models/VideoClips');
const db = require('../config/db');
const { enqueue } = require('../workers/queue');
const { downloadToStorage, storageAbsolutePath } = require('./downloadService');
const { cutClip } = require('./ffmpegService');
const transcriptionService = require('./transcriptionService');
const deepseekService = require('./deepseekService');
const { queueClipMateriaAndCover } = require('./clipPostProcessService');
const { MAX_CLIP_SECONDS, MIN_CLIP_SECONDS } = require('./ffmpegService');

function extFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    return ext || fallback;
  } catch {
    return fallback;
  }
}

function safeUnlink(relativePath) {
  if (!relativePath) return;
  try {
    const abs = storageAbsolutePath(relativePath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    // ignore
  }
}

/** Enfileira o download de um vídeo. */
function queueVideoDownload(video) {
  enqueue(`download video ${video.id}`, async () => {
    try {
      const dest = `videos/video_${video.id}${extFromUrl(video.url_original, '.mp4')}`;
      await downloadToStorage(video.url_original, dest);
      await Videos.update(video.id, {
        status: 'baixado',
        caminho_local: dest,
        erro_mensagem: null,
      });
    } catch (err) {
      await Videos.update(video.id, {
        status: 'erro',
        erro_mensagem: `Download falhou: ${err.message}`,
      });
      throw err;
    }
  });
}

/** Enfileira o download de uma imagem. */
function queueImageDownload(imagem) {
  enqueue(`download imagem ${imagem.id}`, async () => {
    try {
      const dest = `imagens/img_${imagem.id}${extFromUrl(imagem.url_original, '.jpg')}`;
      await downloadToStorage(imagem.url_original, dest);
      await Imagens.update(imagem.id, {
        status: 'baixado',
        caminho_local: dest,
        erro_mensagem: null,
      });
    } catch (err) {
      await Imagens.update(imagem.id, {
        status: 'erro',
        erro_mensagem: `Download falhou: ${err.message}`,
      });
      throw err;
    }
  });
}

/** Extrai fala de um clipe pronto (legendas ou Whisper). Preferir queueClipMateriaAndCover. */
function queueClipTranscription(clip, video) {
  queueClipMateriaAndCover(clip, video, { userId: video?.user_id });
}

/** Enfileira a geração de um corte; ao ficar pronto, gera fala + matéria + capa. */
function queueClipGeneration(clip, video) {
  enqueue(`clip ${clip.id} (video ${video.id})`, async () => {
    try {
      const dest = `clips/clip_${clip.id}.mp4`;
      await cutClip({
        inputPath: storageAbsolutePath(video.caminho_local),
        outputPath: storageAbsolutePath(dest),
        inicio: Number(clip.inicio_segundo),
        fim: Number(clip.fim_segundo),
        aspectRatio: clip.aspect_ratio || '9:16',
      });
      await VideoClips.update(clip.id, {
        status: 'pronto',
        caminho_arquivo: dest,
        erro_mensagem: null,
        materia_status: 'gerando',
      });
      await Videos.update(video.id, { status: 'cortado' });

      const ready = await VideoClips.findById(clip.id);
      // Automático: fala → matéria → capa (Minha marca)
      queueClipMateriaAndCover(ready, video, { userId: video.user_id });
    } catch (err) {
      await VideoClips.update(clip.id, {
        status: 'erro',
        erro_mensagem: `Corte falhou: ${String(err.message || err).slice(0, 400)}`,
      });
      throw err;
    }
  });
}

/**
 * Recupera trabalhos perdidos quando o servidor reinicia (fila em memória).
 */
async function recoverStuckJobs() {
  const stuckClips = await db('video_clips').where({ status: 'processando' });
  for (const clip of stuckClips) {
    const video = await Videos.findById(clip.video_id);
    if (!video?.caminho_local) {
      await VideoClips.update(clip.id, {
        status: 'erro',
        erro_mensagem: 'Vídeo de origem sem arquivo local — baixe novamente',
      });
      continue;
    }
    console.log(`[recover] reenfileirando corte #${clip.id} (${clip.inicio_segundo}s→${clip.fim_segundo}s)`);
    queueClipGeneration(clip, video);
  }

  // Clip pronto sem matéria → retoma fala + matéria + capa
  const needPostProcess = await db('video_clips')
    .where({ status: 'pronto' })
    .whereNotNull('caminho_arquivo')
    .where(function whereNeed() {
      this.whereNull('materia_status')
        .orWhereIn('materia_status', ['pendente', 'gerando'])
        .orWhereNull('transcricao')
        .orWhere('transcricao', '');
    })
    .whereNot('materia_status', 'pronta')
    .whereNot('materia_status', 'erro');

  for (const clip of needPostProcess) {
    if (!clip.caminho_arquivo) continue;
    if (clip.materia_status === 'pronta' && clip.legenda_sugerida) continue;
    const video = await Videos.findById(clip.video_id);
    if (!video) continue;
    console.log(`[recover] reenfileirando matéria/capa do corte #${clip.id}`);
    queueClipMateriaAndCover(clip, video, { userId: video.user_id });
  }

  const nImgs = await db('imagens')
    .where({ materia_status: 'gerando' })
    .update({ materia_status: 'pendente' });

  if (stuckClips.length || needPostProcess.length || nImgs) {
    console.log(
      `[recover] cortes=${stuckClips.length}, pós-processo=${needPostProcess.length}, imagens matéria reset=${nImgs}`
    );
  }
}

/**
 * Analisa o vídeo com IA (transcrição + DeepSeek) e gera os melhores cortes.
 * @param {object} video
 * @param {{ aspectRatio?: string, maxCortes?: number, gerar?: boolean }} opts
 */
function queueVideoAnalyze(video, opts = {}) {
  const activeAnalyses = queueVideoAnalyze.activeJobs || new Set();
  queueVideoAnalyze.activeJobs = activeAnalyses;
  const videoKey = String(video.id);
  if (activeAnalyses.has(videoKey)) return false;
  activeAnalyses.add(videoKey);

  const aspectRatio = ['9:16', '1:1', 'original'].includes(opts.aspectRatio)
    ? opts.aspectRatio
    : '9:16';
  const maxCortes = Math.min(3, Math.max(1, Number(opts.maxCortes) || 3));
  const gerar = opts.gerar !== false;

  try {
    enqueue(`analyze video ${video.id}`, async () => {
      let meta = mergeMetadata(video.metadata, {});
      try {
        meta = mergeMetadata(meta, {
          analise_status: 'processando',
          analise_em: new Date().toISOString(),
        });
        await Videos.update(video.id, { erro_mensagem: null, metadata: meta });

        // 1) Transcreve o vídeo inteiro (com timestamps) — base da IA
        let transcricao = '';
        let segmentos = [];
        try {
          const result = await transcriptionService.transcribeClip({
            clipPath: video.caminho_local,
            sourceUrl: video.url_original || null,
          });
          transcricao = result.text || '';
          segmentos = Array.isArray(result.segments) ? result.segments : [];
        } catch (txErr) {
          console.warn(`[analyze] transcrição vídeo #${video.id}:`, txErr.message);
        }

        // 2) DeepSeek escolhe os melhores trechos
        const sugestoes = await deepseekService.sugerirCortes({
          duracao: video.duracao,
          titulo: video.titulo,
          termo: video.termo_busca,
          tags: video.origem,
          transcricao,
          segmentos,
          maxCortes,
          maxSegundos: MAX_CLIP_SECONDS,
          minSegundos: Math.max(MIN_CLIP_SECONDS, 40),
        });

        meta = mergeMetadata(meta, {
          analise_status: 'pronta',
          analise_em: new Date().toISOString(),
          sugestoes_corte: sugestoes,
          transcricao_full: String(transcricao || '').slice(0, 20000),
        });
        await Videos.update(video.id, { metadata: meta });

        if (!gerar || !sugestoes.length) return;

        // 3) Gera apenas cortes novos; refazer a análise não duplica intervalos idênticos.
        const fresh = await Videos.findById(video.id);
        const existingClips = await VideoClips.findByVideo(video.id);
        for (const s of sugestoes) {
          const duplicate = existingClips.some((clip) => (
            Math.abs(Number(clip.inicio_segundo) - Number(s.inicio)) <= 2 &&
            Math.abs(Number(clip.fim_segundo) - Number(s.fim)) <= 2
          ));
          if (duplicate) continue;

          // Matéria + capa nascem automaticamente quando o corte fica pronto.
          const [clipId] = await VideoClips.create({
            video_id: video.id,
            inicio_segundo: s.inicio,
            fim_segundo: s.fim,
            aspect_ratio: aspectRatio,
            legenda_sugerida: null,
            status: 'processando',
          });
          const created = await VideoClips.findById(clipId);
          existingClips.push(created);
          queueClipGeneration(created, fresh || video);
        }
      } catch (err) {
        meta = mergeMetadata(meta, {
          analise_status: 'erro',
          analise_erro: String(err.message || err).slice(0, 400),
        });
        await Videos.update(video.id, {
          erro_mensagem: `Análise IA falhou: ${String(err.message || err).slice(0, 400)}`,
          metadata: meta,
        });
        throw err;
      } finally {
        activeAnalyses.delete(videoKey);
      }
    });
    return true;
  } catch (err) {
    activeAnalyses.delete(videoKey);
    throw err;
  }
}

function mergeMetadata(current, patch) {
  let base = current;
  if (typeof base === 'string') {
    try {
      base = JSON.parse(base);
    } catch {
      base = {};
    }
  }
  if (!base || typeof base !== 'object') base = {};
  return { ...base, ...patch };
}

module.exports = {
  queueVideoDownload,
  queueImageDownload,
  queueClipGeneration,
  queueClipTranscription,
  queueVideoAnalyze,
  recoverStuckJobs,
  safeUnlink,
};
