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

/** Extrai fala de um clipe pronto (legendas ou Whisper). */
function queueClipTranscription(clip, video) {
  enqueue(`transcribe clip ${clip.id}`, async () => {
    try {
      await VideoClips.update(clip.id, {
        materia_status: 'gerando',
        erro_mensagem: null,
      });
      const fresh = await VideoClips.findById(clip.id);
      const result = await transcriptionService.transcribeClip({
        clipPath: fresh.caminho_arquivo,
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
}

/** Enfileira a geração de um corte; ao ficar pronto, extrai a fala automaticamente. */
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
      queueClipTranscription(ready, video);
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

  // Clip pronto sem transcrição e matéria “gerando” → reextrai fala
  const needTranscript = await db('video_clips')
    .where({ status: 'pronto' })
    .where(function whereNeed() {
      this.whereNull('transcricao').orWhere('transcricao', '').orWhere({ materia_status: 'gerando' });
    });

  for (const clip of needTranscript) {
    if (clip.status !== 'pronto' || !clip.caminho_arquivo) continue;
    if (clip.transcricao && clip.materia_status !== 'gerando') continue;
    const video = await Videos.findById(clip.video_id);
    if (!video) continue;
    console.log(`[recover] reenfileirando transcrição do corte #${clip.id}`);
    queueClipTranscription(clip, video);
  }

  const nImgs = await db('imagens')
    .where({ materia_status: 'gerando' })
    .update({ materia_status: 'pendente' });

  if (stuckClips.length || needTranscript.length || nImgs) {
    console.log(
      `[recover] cortes=${stuckClips.length}, transcrições=${needTranscript.length}, imagens matéria reset=${nImgs}`
    );
  }
}

module.exports = {
  queueVideoDownload,
  queueImageDownload,
  queueClipGeneration,
  queueClipTranscription,
  recoverStuckJobs,
  safeUnlink,
};
