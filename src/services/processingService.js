const path = require('path');
const Videos = require('../models/Videos');
const Imagens = require('../models/Imagens');
const VideoClips = require('../models/VideoClips');
const { enqueue } = require('../workers/queue');
const { downloadToStorage, storageAbsolutePath } = require('./downloadService');
const { cutClip } = require('./ffmpegService');

function extFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    return ext || fallback;
  } catch {
    return fallback;
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

/** Enfileira a geração de um corte já registrado como "processando". */
function queueClipGeneration(clip, video) {
  enqueue(`clip ${clip.id} (video ${video.id})`, async () => {
    try {
      const dest = `clips/clip_${clip.id}.mp4`;
      await cutClip({
        inputPath: storageAbsolutePath(video.caminho_local),
        outputPath: storageAbsolutePath(dest),
        inicio: clip.inicio_segundo,
        fim: clip.fim_segundo,
        aspectRatio: clip.aspect_ratio,
      });
      await VideoClips.update(clip.id, {
        status: 'pronto',
        caminho_arquivo: dest,
        erro_mensagem: null,
      });
      await Videos.update(video.id, { status: 'cortado' });
    } catch (err) {
      await VideoClips.update(clip.id, {
        status: 'erro',
        erro_mensagem: `Corte falhou: ${err.message}`,
      });
      throw err;
    }
  });
}

module.exports = { queueVideoDownload, queueImageDownload, queueClipGeneration };
