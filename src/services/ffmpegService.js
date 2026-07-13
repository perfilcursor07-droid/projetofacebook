const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { env } = require('../config/env');

const ffmpegPath = env.ffmpegPath || require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const MAX_CLIP_SECONDS = 90;

/**
 * Filtros de vídeo por formato de saída.
 * 9:16 (Reels) e 1:1 cortam centralizado; "original" mantém o quadro.
 */
const FORMATS = {
  '9:16': {
    filter: 'crop=min(iw\\,ih*9/16):ih,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
  },
  '1:1': {
    filter: 'crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080',
  },
  original: {
    filter: null,
  },
};

function probe(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/**
 * Gera um corte de vídeo.
 * @param {object} opts
 * @param {string} opts.inputPath caminho absoluto do vídeo de origem
 * @param {string} opts.outputPath caminho absoluto do mp4 de saída
 * @param {number} opts.inicio segundo inicial
 * @param {number} opts.fim segundo final
 * @param {string} [opts.aspectRatio] "9:16" | "1:1" | "original"
 * @returns {Promise<{ duracao: number }>}
 */
function cutClip({ inputPath, outputPath, inicio, fim, aspectRatio = '9:16' }) {
  const start = Math.max(0, Number(inicio) || 0);
  const end = Number(fim);
  let duration = end - start;

  if (!Number.isFinite(duration) || duration <= 0) {
    const err = new Error('Intervalo de corte inválido (fim deve ser maior que início)');
    err.status = 400;
    throw err;
  }
  if (duration > MAX_CLIP_SECONDS) duration = MAX_CLIP_SECONDS;

  const format = FORMATS[aspectRatio] || FORMATS['9:16'];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath)
      .setStartTime(start)
      .duration(duration)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart']);

    if (format.filter) {
      command = command.videoFilters(format.filter);
    }

    command
      .on('error', (err) => reject(err))
      .on('end', () => resolve({ duracao: duration }))
      .save(outputPath);
  });
}

module.exports = { cutClip, probe, MAX_CLIP_SECONDS };
