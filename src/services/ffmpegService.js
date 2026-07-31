const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { env } = require('../config/env');

const ffmpegPath = env.ffmpegPath || require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const MAX_CLIP_SECONDS = 90; // Auto 90s / limite recomendado para Reels
// Corte manual pode passar de 90s (vídeo normal no feed). Limite de segurança.
const MAX_MANUAL_CLIP_SECONDS = 1800; // 30 min
// Reels aceita 3s no mínimo; para monetização o recomendado é >= 10s.
const MIN_CLIP_SECONDS = 3;
const MONETIZATION_MIN_SECONDS = 10;
const OUTPUT_FPS = 30;

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
  if (duration < MIN_CLIP_SECONDS) {
    const err = new Error(`Corte mínimo de ${MIN_CLIP_SECONDS} segundos (exigência do Facebook Reels)`);
    err.status = 400;
    throw err;
  }
  if (duration > MAX_MANUAL_CLIP_SECONDS) {
    const err = new Error(`Corte máximo de ${MAX_MANUAL_CLIP_SECONDS} segundos (30 min)`);
    err.status = 400;
    throw err;
  }

  const format = FORMATS[aspectRatio] || FORMATS['9:16'];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    // Saída conforme especificações do Facebook Reels:
    // H.264, fps fixo 24-60, chroma 4:2:0, closed GOP 2-5s, AAC estéreo 128kbps+ 48kHz.
    let command = ffmpeg(inputPath)
      .setStartTime(start)
      .duration(duration)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-preset', 'veryfast',
        '-crf', '23',
        '-r', String(OUTPUT_FPS),
        '-vsync', 'cfr',
        '-pix_fmt', 'yuv420p',
        '-g', String(OUTPUT_FPS * 2),
        '-keyint_min', String(OUTPUT_FPS * 2),
        '-sc_threshold', '0',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
      ]);

    if (format.filter) {
      command = command.videoFilters(format.filter);
    }

    command
      .on('error', (err) => reject(err))
      .on('end', () => resolve({ duracao: duration }))
      .save(outputPath);
  });
}

/** Resoluções de saída da tela dividida por formato. */
const SPLIT_CANVAS = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  original: { width: 1080, height: 1920 },
};

function clampOffset(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback / 100;
  return Math.min(100, Math.max(0, n)) / 100;
}

/**
 * Escala cobrindo a metade e recorta na posição pedida.
 * offset 0 = encostado à esquerda, 0.5 = centro, 1 = encostado à direita.
 */
function coverHalfFilter(halfWidth, height, offset) {
  const x = `(iw-ow)*${offset.toFixed(4)}`;
  return [
    `scale=${halfWidth}:${height}:force_original_aspect_ratio=increase`,
    `crop=${halfWidth}:${height}:${x}:(ih-oh)/2`,
    'setsar=1',
  ].join(',');
}

/**
 * Extrai um frame do vídeo como JPG (usado na capa e na tela dividida).
 * @returns {Promise<string>} caminho do jpg gerado
 */
function extractFrame(inputPath, outputPath, atSecond = 0.5) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(Math.max(0, Number(atSecond) || 0))
      .frames(1)
      .outputOptions(['-q:v', '2'])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * Monta a tela dividida: imagem fixa na esquerda, vídeo na direita, meio a meio.
 * Cada lado é escalado para cobrir sua metade e recortado no offset escolhido,
 * então nada é esticado — o usuário só empurra o enquadramento.
 *
 * @param {object} opts
 * @param {string} opts.videoPath vídeo (corte já pronto)
 * @param {string} opts.imagePath imagem da metade esquerda
 * @param {string} opts.outputPath mp4 de saída
 * @param {number} [opts.videoOffset] 0–100 (padrão 50)
 * @param {number} [opts.imageOffset] 0–100 (padrão 50)
 * @param {string} [opts.aspectRatio] "9:16" | "1:1"
 * @param {'esquerda'|'direita'} [opts.imagemLado] lado da imagem (padrão esquerda)
 * @returns {Promise<{ width: number, height: number }>}
 */
function renderSplitScreen({
  videoPath,
  imagePath,
  outputPath,
  videoOffset = 50,
  imageOffset = 50,
  aspectRatio = '9:16',
  imagemLado = 'esquerda',
}) {
  const canvas = SPLIT_CANVAS[aspectRatio] || SPLIT_CANVAS['9:16'];
  const height = canvas.height;
  const halfWidth = Math.round(canvas.width / 2);
  const imgOffset = clampOffset(imageOffset);
  const vidOffset = clampOffset(videoOffset);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const command = ffmpeg().input(videoPath).input(imagePath).inputOptions(['-loop', '1']);

    const filters = [
      `[0:v]${coverHalfFilter(halfWidth, height, vidOffset)},fps=${OUTPUT_FPS}[vid]`,
      `[1:v]${coverHalfFilter(halfWidth, height, imgOffset)}[img]`,
      imagemLado === 'direita'
        ? '[vid][img]hstack=inputs=2[v]'
        : '[img][vid]hstack=inputs=2[v]',
    ];

    command
      .complexFilter(filters)
      .outputOptions([
        '-map', '[v]',
        // O áudio do corte é opcional: "?" evita erro em vídeo mudo.
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-r', String(OUTPUT_FPS),
        '-vsync', 'cfr',
        '-pix_fmt', 'yuv420p',
        '-g', String(OUTPUT_FPS * 2),
        '-keyint_min', String(OUTPUT_FPS * 2),
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        // A imagem é um input infinito (-loop 1): termina junto com o vídeo.
        '-shortest',
        '-movflags', '+faststart',
      ])
      .on('error', (err) => reject(err))
      .on('end', () => resolve({ width: halfWidth * 2, height }))
      .save(outputPath);
  });
}

/**
 * Queima uma faixa PNG (texto) sobre o vídeo inteiro — topo ou rodapé.
 * O overlay é transparente fora da faixa; a capa depois é costurada à parte.
 *
 * @param {object} opts
 * @param {string} opts.videoPath
 * @param {string} opts.overlayPath PNG com alpha (mesmo tamanho do vídeo)
 * @param {string} opts.outputPath
 * @returns {Promise<void>}
 */
function overlayTextoFixo({ videoPath, overlayPath, outputPath }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(overlayPath)
      .complexFilter(['[0:v][1:v]overlay=0:0:format=auto[v]'])
      .outputOptions([
        '-map', '[v]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-r', String(OUTPUT_FPS),
        '-vsync', 'cfr',
        '-pix_fmt', 'yuv420p',
        '-g', String(OUTPUT_FPS * 2),
        '-keyint_min', String(OUTPUT_FPS * 2),
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
      ])
      .on('error', reject)
      .on('end', () => resolve())
      .save(outputPath);
  });
}

/**
 * Extrai áudio WAV mono 16kHz para STT (Whisper).
 * @returns {Promise<string>} caminho absoluto do wav
 */
function extractAudioWav(inputPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * Valida um arquivo de vídeo contra os requisitos do Facebook Reels.
 * Retorna { ok, erros[], avisos[], info } sem lançar exceção.
 */
async function validateReelFile(filePath) {
  const erros = [];
  const avisos = [];
  let info = {};

  try {
    const data = await probe(filePath);
    const stream = (data.streams || []).find((s) => s.codec_type === 'video') || {};
    const duracao = Number(data.format?.duration) || 0;
    const width = Number(stream.width) || 0;
    const height = Number(stream.height) || 0;

    let fps = 0;
    if (stream.avg_frame_rate && stream.avg_frame_rate !== '0/0') {
      const [num, den] = stream.avg_frame_rate.split('/').map(Number);
      if (den) fps = num / den;
    }

    info = { duracao, width, height, fps, codec: stream.codec_name };

    if (duracao < MIN_CLIP_SECONDS || duracao > MAX_CLIP_SECONDS) {
      erros.push(`Duração de ${duracao.toFixed(1)}s fora do permitido para Reels (${MIN_CLIP_SECONDS} a ${MAX_CLIP_SECONDS}s)`);
    } else if (duracao < MONETIZATION_MIN_SECONDS) {
      avisos.push(`Reels com menos de ${MONETIZATION_MIN_SECONDS}s não contam para monetização`);
    }

    if (width && height) {
      const ratio = width / height;
      if (Math.abs(ratio - 9 / 16) > 0.02) {
        erros.push(`Proporção ${width}×${height} não é 9:16 — gere o corte no formato 9:16 (Reels)`);
      }
      if (width < 540 || height < 960) {
        erros.push(`Resolução ${width}×${height} abaixo do mínimo de 540×960 para Reels`);
      } else if (width < 1080 || height < 1920) {
        avisos.push('Resolução abaixo da recomendada (1080×1920)');
      }
    }

    if (fps && (fps < 23.5 || fps > 60.5)) {
      erros.push(`Frame rate de ${fps.toFixed(1)}fps fora do permitido (24 a 60fps)`);
    }
  } catch (err) {
    erros.push(`Não foi possível analisar o arquivo: ${err.message}`);
  }

  return { ok: erros.length === 0, erros, avisos, info };
}

module.exports = {
  cutClip,
  extractAudioWav,
  extractFrame,
  renderSplitScreen,
  overlayTextoFixo,
  probe,
  validateReelFile,
  MAX_CLIP_SECONDS,
  MAX_MANUAL_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  MONETIZATION_MIN_SECONDS,
};
