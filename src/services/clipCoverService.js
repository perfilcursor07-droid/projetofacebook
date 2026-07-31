const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { env } = require('../config/env');
const { probe } = require('./ffmpegService');
const { composeBrandOverlayOnImage } = require('./editorialCardService');

const COVER_SECONDS = 2.5;
const OUTPUT_FPS = 30;

function storageAbs(relative) {
  return path.resolve(env.storagePath, relative);
}

function tempPath(name) {
  const dir = storageAbs('temp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/** Extrai um frame do vídeo (jpg) para servir de fundo da capa. */
function extractFrame(inputPath, outputPath, atSecond = 0.5) {
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

/** Tenta vários pontos do vídeo se o seek falhar (clipes curtos / keyframes). */
async function extractFrameRobust(inputPath, outputPath) {
  const attempts = [0.5, 0.2, 0.05, 0];
  let lastErr;
  for (const at of attempts) {
    try {
      await extractFrame(inputPath, outputPath, at);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
        return outputPath;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Não foi possível extrair um frame para a capa');
}

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 2));
  return v % 2 === 0 ? v : v + 1;
}

/**
 * WAV PCM estéreo 48kHz silencioso — evita depender de lavfi/anullsrc
 * (muitos builds de ffmpeg do servidor vêm sem lavfi).
 */
function writeSilentWav(outputPath, seconds) {
  const sampleRate = 48000;
  const channels = 2;
  const bitsPerSample = 16;
  const numSamples = Math.max(1, Math.ceil(Number(seconds) * sampleRate));
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize); // PCM zero = silêncio

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/** Converte a imagem da capa em um clipe com áudio silencioso (sem lavfi). */
function coverImageToVideo({ imagePath, silentWavPath, outputPath, width, height }) {
  const w = even(width);
  const h = even(height);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1'])
      .input(silentWavPath)
      .outputOptions([
        '-t', String(COVER_SECONDS),
        '-r', String(OUTPUT_FPS),
        '-vsync', 'cfr',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-g', String(OUTPUT_FPS * 2),
        '-keyint_min', String(OUTPUT_FPS * 2),
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
        '-shortest',
        '-movflags', '+faststart',
      ])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/** Concatena capa + clipe reencodando com parâmetros compatíveis com Reels. */
function concatCoverAndClip({ coverPath, clipPath, silentWavPath, outputPath, width, height, hasAudio }) {
  const w = even(width);
  const h = even(height);
  const v0 = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUTPUT_FPS}[v0]`;
  const v1 = `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUTPUT_FPS}[v1]`;
  const a0 = '[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]';

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(coverPath).input(clipPath);
    const filters = [v0, v1, a0];

    if (hasAudio) {
      filters.push('[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]');
      filters.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
    } else {
      cmd.input(silentWavPath);
      filters.push('[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]');
      filters.push('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]');
    }

    cmd
      .complexFilter(filters)
      .outputOptions([
        '-map', '[v]',
        '-map', '[a]',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-r', String(OUTPUT_FPS),
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
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * Gera a capa de marca (modelo Minha marca) e devolve o corte com a capa costurada no início.
 * @returns {Promise<{ relativePath: string, coverSeconds: number, modelId?: string }>}
 */
async function addCoverToClip({ clip, user, titulo }) {
  const title = String(titulo || '').trim();
  if (!title) {
    const err = new Error('Informe o título da capa');
    err.status = 400;
    throw err;
  }

  // Base do vídeo: sempre o corte SEM capa (permite refazer sem acumular capas)
  const baseRelative = clip.arquivo_sem_capa || clip.caminho_arquivo;
  const clipAbs = storageAbs(baseRelative);
  if (!baseRelative || !fs.existsSync(clipAbs)) {
    const err = new Error('Arquivo do corte não encontrado — gere o corte novamente');
    err.status = 422;
    throw err;
  }

  const data = await probe(clipAbs);
  const stream = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const width = Number(stream.width) || 1080;
  const height = Number(stream.height) || 1920;
  const hasAudio = (data.streams || []).some((s) => s.codec_type === 'audio');

  const uid = crypto.randomBytes(4).toString('hex');
  const framePath = tempPath(`capa_frame_${clip.id}_${uid}.jpg`);
  const coverImagePath = tempPath(`capa_img_${clip.id}_${uid}.jpg`);
  const coverVideoPath = tempPath(`capa_video_${clip.id}_${uid}.mp4`);
  const silentWavPath = tempPath(`capa_silent_${clip.id}_${uid}.wav`);
  const outRelative = `clips/clip_${clip.id}_capa_${Date.now()}.mp4`;
  const outAbs = storageAbs(outRelative);

  try {
    writeSilentWav(silentWavPath, Math.max(COVER_SECONDS + 0.5, Number(data.format?.duration) || 60));
    await extractFrameRobust(clipAbs, framePath);
    const composed = await composeBrandOverlayOnImage({
      imagePath: framePath,
      outputPath: coverImagePath,
      title,
      user,
      width,
      height,
    });
    await coverImageToVideo({
      imagePath: coverImagePath,
      silentWavPath,
      outputPath: coverVideoPath,
      width,
      height,
    });
    if (!fs.existsSync(coverVideoPath) || fs.statSync(coverVideoPath).size < 1000) {
      throw new Error('Falha ao gerar o vídeo da capa (arquivo vazio)');
    }
    await concatCoverAndClip({
      coverPath: coverVideoPath,
      clipPath: clipAbs,
      silentWavPath,
      outputPath: outAbs,
      width,
      height,
      hasAudio,
    });
    if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size < 1000) {
      throw new Error('Falha ao costurar a capa no Reel (arquivo final vazio)');
    }
    return {
      relativePath: outRelative,
      coverSeconds: COVER_SECONDS,
      modelId: composed.modelId,
    };
  } catch (err) {
    safeUnlink(outAbs);
    throw err;
  } finally {
    safeUnlink(framePath);
    safeUnlink(coverImagePath);
    safeUnlink(coverVideoPath);
    safeUnlink(silentWavPath);
  }
}

/**
 * Arquivo `_capa_` = intro Minha marca costurada no início.
 */
function isCapaVideoPath(relative) {
  return /_capa_/i.test(String(relative || ''));
}

function fileExistsRel(relative) {
  return Boolean(relative) && fs.existsSync(storageAbs(relative));
}

/**
 * Candidatos a “corpo” do Reel sem a intro de capa.
 */
function listCorpoSemCapaCandidates(clip) {
  if (!clip?.id) return [];
  const list = [
    clip.arquivo_sem_capa,
    clip.arquivo_sem_split,
    clip.arquivo_sem_speed,
    clip.arquivo_sem_bgm,
    `clips/clip_${clip.id}.mp4`,
    clip.caminho_arquivo,
  ];
  const seen = new Set();
  const out = [];
  for (const rel of list) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    if (!fileExistsRel(rel)) continue;
    if (isCapaVideoPath(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Remove a intro da capa (primeiros ~COVER_SECONDS) de um mp4.
 * Usado quando a capa ficou embutida num arquivo sem sufixo `_capa_`.
 */
function stripCoverIntro({ inputRelative, outputRelative, coverSeconds = COVER_SECONDS }) {
  const inputPath = storageAbs(inputRelative);
  const outputPath = storageAbs(outputRelative);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return probe(inputPath).then((meta) => {
    const dur = Number(meta.format?.duration) || 0;
    const skip = Math.min(Number(coverSeconds) || COVER_SECONDS, Math.max(0, dur - 3));
    if (skip < 0.35) {
      fs.copyFileSync(inputPath, outputPath);
      return outputRelative;
    }

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(skip)
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
          '-y',
        ])
        .on('error', reject)
        .on('end', () => resolve(outputRelative))
        .save(outputPath);
    });
  });
}

/** Existe algum mp4 de capa gerado para este clip? (mesmo se o caminho atual não tiver `_capa_`) */
function clipHasCapaArtifact(clipId) {
  const id = Number(clipId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const dir = storageAbs('clips');
  if (!fs.existsSync(dir)) return false;
  try {
    const re = new RegExp(`^clip_${id}.*_capa_`, 'i');
    return fs.readdirSync(dir).some((name) => re.test(name) && /\.mp4$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * Vídeo do preview/publicação conforme o flag da capa.
 * Com capa desmarcada, nunca devolve arquivo `_capa_` nem “surpresa”
 * de arquivo_sem_speed com intro embutida.
 */
function resolvePlaybackVideoPath(clip) {
  if (!clip) return null;
  const capaOn = String(clip.capa_status || '') === 'pronta';

  if (capaOn) {
    if (fileExistsRel(clip.caminho_arquivo)) return clip.caminho_arquivo;
    if (fileExistsRel(clip.arquivo_sem_capa)) return clip.arquivo_sem_capa;
    return clip.caminho_arquivo || null;
  }

  // Capa off: o caminho atual (já corrigido pelo DELETE) tem prioridade.
  // Não preferir arquivo_sem_speed/bgm — podem ter a intro queimada sem `_capa_` no nome.
  if (fileExistsRel(clip.caminho_arquivo) && !isCapaVideoPath(clip.caminho_arquivo)) {
    return clip.caminho_arquivo;
  }

  const trusted = [
    clip.arquivo_sem_capa,
    clip.arquivo_sem_split,
    `clips/clip_${clip.id}.mp4`,
  ];
  for (const rel of trusted) {
    if (rel && fileExistsRel(rel) && !isCapaVideoPath(rel)) return rel;
  }

  return clip.caminho_arquivo || null;
}

/**
 * Se a capa está off mas o caminho ainda é `_capa_`, corrige no banco.
 */
async function syncClipVideoToCapaFlag(clip) {
  if (!clip?.id) return clip;
  const capaOn = String(clip.capa_status || '') === 'pronta';
  const atual = clip.caminho_arquivo;

  if (capaOn || !isCapaVideoPath(atual)) return clip;

  const corpos = [
    clip.arquivo_sem_capa,
    clip.arquivo_sem_split,
    `clips/clip_${clip.id}.mp4`,
  ].filter((rel) => rel && fileExistsRel(rel) && !isCapaVideoPath(rel) && rel !== atual);

  const corpo = corpos[0] || null;
  if (!corpo) return clip;

  const VideoClips = require('../models/VideoClips');
  await VideoClips.update(clip.id, {
    caminho_arquivo: corpo,
    arquivo_sem_capa: null,
    capa_status: 'pendente',
  });
  return {
    ...clip,
    caminho_arquivo: corpo,
    arquivo_sem_capa: null,
    capa_status: 'pendente',
  };
}

/**
 * Remove a capa do arquivo do clip (volta ao corpo limpo ou corta a intro).
 * @returns {Promise<{ relativePath: string, stripped: boolean }>}
 */
async function removeCoverFromClip(clip, { forceStrip = false } = {}) {
  if (!clip?.id) throw new Error('Clip inválido');

  const atual = clip.caminho_arquivo;
  const capaWasOn =
    String(clip.capa_status || '') === 'pronta' || isCapaVideoPath(atual);
  const hasArtifact = clipHasCapaArtifact(clip.id);
  const alreadyStripped = /_sem_capa_/i.test(String(atual || ''));

  // Corpo limpo explícito (backup feito ao gerar a capa)
  const semCapaBackup =
    fileExistsRel(clip.arquivo_sem_capa) && !isCapaVideoPath(clip.arquivo_sem_capa)
      ? clip.arquivo_sem_capa
      : null;

  if (semCapaBackup && semCapaBackup !== atual) {
    return { relativePath: semCapaBackup, stripped: false };
  }

  const shouldStrip =
    (forceStrip || capaWasOn || isCapaVideoPath(atual) || hasArtifact) &&
    !(alreadyStripped && !capaWasOn && !isCapaVideoPath(atual));

  // force sem evidência de capa: não corta os primeiros segundos à toa
  if (forceStrip && !capaWasOn && !isCapaVideoPath(atual) && !hasArtifact && !semCapaBackup) {
    if (fileExistsRel(atual)) return { relativePath: atual, stripped: false };
  }

  if (shouldStrip && fileExistsRel(atual)) {
    const outRel = `clips/clip_${clip.id}_sem_capa_${Date.now()}.mp4`;
    await stripCoverIntro({
      inputRelative: atual,
      outputRelative: outRel,
      coverSeconds: COVER_SECONDS + 0.2,
    });
    if (!fileExistsRel(outRel)) {
      throw new Error('Falha ao gerar o vídeo sem capa');
    }
    return { relativePath: outRel, stripped: true };
  }

  // Soft: troca de `_capa_` para split / original
  if (isCapaVideoPath(atual)) {
    const soft = [
      clip.arquivo_sem_split,
      `clips/clip_${clip.id}.mp4`,
    ].find((rel) => rel && fileExistsRel(rel) && !isCapaVideoPath(rel));
    if (soft) return { relativePath: soft, stripped: false };
  }

  if (fileExistsRel(atual) && !isCapaVideoPath(atual)) {
    return { relativePath: atual, stripped: false };
  }

  const fallback = [
    clip.arquivo_sem_split,
    `clips/clip_${clip.id}.mp4`,
  ].find((rel) => rel && fileExistsRel(rel) && !isCapaVideoPath(rel));

  if (fallback) return { relativePath: fallback, stripped: false };

  throw new Error('Arquivo do vídeo não encontrado para remover a capa');
}

module.exports = {
  addCoverToClip,
  COVER_SECONDS,
  isCapaVideoPath,
  resolvePlaybackVideoPath,
  syncClipVideoToCapaFlag,
  removeCoverFromClip,
  stripCoverIntro,
  listCorpoSemCapaCandidates,
};

