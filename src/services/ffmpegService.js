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
 * Escala cobrindo o painel e recorta na posição pedida.
 * axis 'x' (lado a lado): offset empurra horizontalmente.
 * axis 'y' (empilhado): offset empurra verticalmente — enquadramento horizontal.
 */
function coverPaneFilter(paneW, paneH, offset, axis = 'x') {
  const o = Number(offset).toFixed(4);
  if (axis === 'y') {
    return [
      `scale=${paneW}:${paneH}:force_original_aspect_ratio=increase`,
      `crop=${paneW}:${paneH}:(iw-ow)/2:(ih-oh)*${o}`,
      'setsar=1',
    ].join(',');
  }
  return [
    `scale=${paneW}:${paneH}:force_original_aspect_ratio=increase`,
    `crop=${paneW}:${paneH}:(iw-ow)*${o}:(ih-oh)/2`,
    'setsar=1',
  ].join(',');
}

/** @deprecated use coverPaneFilter */
function coverHalfFilter(halfWidth, height, offset) {
  return coverPaneFilter(halfWidth, height, offset, 'x');
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
 * Monta a tela dividida 9:16.
 * - modo "lado": imagem | vídeo (hstack)
 * - modo "empilhado": imagem acima/abaixo do vídeo (vstack) — cada metade em landscape
 *
 * @param {object} opts
 * @param {'lado'|'empilhado'} [opts.modo]
 * @param {'esquerda'|'direita'|'cima'|'baixo'} [opts.imagemLado]
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
  modo = 'lado',
}) {
  const canvas = SPLIT_CANVAS[aspectRatio] || SPLIT_CANVAS['9:16'];
  const width = canvas.width;
  const height = canvas.height;
  const empilhado = String(modo) === 'empilhado';
  const paneW = empilhado ? width : Math.round(width / 2);
  const paneH = empilhado ? Math.round(height / 2) : height;
  const axis = empilhado ? 'y' : 'x';
  const imgOffset = clampOffset(imageOffset);
  const vidOffset = clampOffset(videoOffset);
  const pos = String(imagemLado || '');

  let stackFilter;
  if (empilhado) {
    stackFilter =
      pos === 'baixo' ? '[vid][img]vstack=inputs=2[v]' : '[img][vid]vstack=inputs=2[v]';
  } else {
    stackFilter =
      pos === 'direita' ? '[vid][img]hstack=inputs=2[v]' : '[img][vid]hstack=inputs=2[v]';
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const command = ffmpeg().input(videoPath).input(imagePath).inputOptions(['-loop', '1']);

    const filters = [
      `[0:v]${coverPaneFilter(paneW, paneH, vidOffset, axis)},fps=${OUTPUT_FPS}[vid]`,
      `[1:v]${coverPaneFilter(paneW, paneH, imgOffset, axis)}[img]`,
      stackFilter,
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
      .on('end', () => resolve({ width, height }))
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

/**
 * Mistura música de fundo no vídeo (rápido: copia vídeo, só remixa áudio).
 * BGM deve ser um loop curto; usamos aloop+atrim com duração explícita (sem -stream_loop infinito).
 *
 * @param {object} opts
 * @param {string} opts.videoPath
 * @param {string} opts.bgmPath WAV curto em loop
 * @param {string} opts.outputPath
 * @param {number} [opts.bgmVolume] 0–1
 * @param {number} opts.durationSec duração do vídeo (obrigatória para terminar rápido)
 * @returns {Promise<void>}
 */
function mixBackgroundMusic({ videoPath, bgmPath, outputPath, bgmVolume = 0.18, durationSec }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const vol = Math.min(0.5, Math.max(0.03, Number(bgmVolume) || 0.18));
  const dur = Math.max(1, Math.min(600, Number(durationSec) || 30));
  const durStr = dur.toFixed(3);

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (probeErr, data) => {
      if (probeErr) return reject(probeErr);
      const hasAudio = (data?.streams || []).some((s) => s.codec_type === 'audio');

      const cmd = ffmpeg().input(videoPath).input(bgmPath);

      if (hasAudio) {
        // aloop no BGM curto + atrim na duração do vídeo — evita hang do -stream_loop -1
        cmd.complexFilter([
          `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=1[voice]`,
          `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,aloop=loop=-1:size=2000000000,atrim=0:${durStr},asetpts=N/SR/TB,volume=${vol}[bgm]`,
          `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
        ]);
      } else {
        cmd.complexFilter([
          `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,aloop=loop=-1:size=2000000000,atrim=0:${durStr},asetpts=N/SR/TB,volume=${vol}[aout]`,
        ]);
      }

      cmd
        .outputOptions([
          '-map', '0:v:0',
          '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '48000',
          '-ac', '2',
          '-t', durStr,
          '-movflags', '+faststart',
          '-y',
        ])
        .on('error', reject)
        .on('end', () => resolve())
        .save(outputPath);
    });
  });
}

module.exports = {
  cutClip,
  extractAudioWav,
  extractFrame,
  renderSplitScreen,
  overlayTextoFixo,
  mixBackgroundMusic,
  probe,
  validateReelFile,
  MAX_CLIP_SECONDS,
  MAX_MANUAL_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  MONETIZATION_MIN_SECONDS,
};
