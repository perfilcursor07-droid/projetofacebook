const path = require('path');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const Videos = require('../models/Videos');
const { enqueue } = require('../workers/queue');
const { storageAbsolutePath } = require('./downloadService');

/**
 * Metadados de um link (YouTube, TikTok, URL direta) via yt-dlp.
 */
async function fetchLinkMetadata(url) {
  const info = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    skipDownload: true,
  });

  return {
    titulo: info.title || null,
    duracao: info.duration ? Math.round(info.duration) : null,
    thumbnail: info.thumbnail || null,
    autor: info.uploader || info.channel || null,
    autorUrl: info.uploader_url || info.channel_url || null,
    extractor: info.extractor_key || null,
  };
}

/** Enfileira download de um vídeo importado por link. */
function queueLinkImport(video) {
  enqueue(`import link video ${video.id}`, async () => {
    try {
      const dest = `videos/video_${video.id}.mp4`;
      await youtubedl(video.url_original, {
        output: storageAbsolutePath(dest),
        format: 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        mergeOutputFormat: 'mp4',
        ffmpegLocation: path.dirname(ffmpegPath),
        noPlaylist: true,
        noWarnings: true,
      });

      await Videos.update(video.id, {
        status: 'baixado',
        caminho_local: dest,
        erro_mensagem: null,
      });
    } catch (err) {
      const msg = String(err.stderr || err.message || err).slice(0, 500);
      await Videos.update(video.id, {
        status: 'erro',
        erro_mensagem: `Importação falhou: ${msg}`,
      });
      throw err;
    }
  });
}

module.exports = { fetchLinkMetadata, queueLinkImport };
