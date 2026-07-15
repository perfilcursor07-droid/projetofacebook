const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const { env } = require('../config/env');
const { probe } = require('./ffmpegService');
const { wrapTitle } = require('./editorialCardService');

const COVER_SECONDS = 2.5;
const OUTPUT_FPS = 30;

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeColor(value, fallback) {
  const candidate = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(candidate) ? candidate : fallback;
}

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
      .seekInput(atSecond)
      .frames(1)
      .outputOptions(['-q:v', '2'])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * SVG da capa no estilo "Minha marca", dimensionado ao quadro do vídeo.
 */
function buildCoverOverlay({ width, height, title, category, footer, primary, secondary }) {
  // Escala tipográfica proporcional (base: 1080 de largura)
  const s = width / 1080;
  const isVertical = height > width;
  const maxChars = isVertical ? 18 : 24;
  const lines = wrapTitle(title, maxChars, 4);
  const fontSize = Math.round((lines.length <= 2 ? 84 : lines.length === 3 ? 72 : 62) * s);
  const lineHeight = Math.round(fontSize * 1.12);

  const blockH = Math.round(lineHeight * lines.length + 260 * s);
  const blockY = Math.round(height * (isVertical ? 0.56 : 0.5));
  const titleY = blockY + Math.round(120 * s) + Math.round(fontSize * 0.8);
  const centerX = Math.round(width / 2);

  const titleSvg = lines
    .map((line, i) => `<text x="${centerX}" y="${titleY + i * lineHeight}" text-anchor="middle" class="title">${escapeXml(line)}</text>`)
    .join('');

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity=".30"/>
          <stop offset="45%" stop-color="#000" stop-opacity=".45"/>
          <stop offset="100%" stop-color="#000" stop-opacity=".9"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${primary}"/>
          <stop offset="100%" stop-color="${secondary}"/>
        </linearGradient>
        <filter id="shadow"><feDropShadow dx="0" dy="${Math.max(2, Math.round(3 * s))}" stdDeviation="${Math.max(3, Math.round(5 * s))}" flood-opacity=".8"/></filter>
        <style>
          .category { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: ${Math.round(44 * s)}px; letter-spacing: ${Math.max(1, Math.round(3 * s))}px; fill: #fff; filter: url(#shadow); }
          .title { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${fontSize}px; fill: #fff; filter: url(#shadow); }
          .footer { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${Math.round(36 * s)}px; letter-spacing: ${Math.max(1, Math.round(2 * s))}px; fill: ${primary}; filter: url(#shadow); }
          .play-tip { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 700; font-size: ${Math.round(30 * s)}px; fill: rgba(255,255,255,.85); }
        </style>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#shade)"/>
      <text x="${centerX}" y="${blockY + Math.round(52 * s)}" text-anchor="middle" class="category">${escapeXml(category || 'ASSISTA')}</text>
      <rect x="${centerX - Math.round(220 * s)}" y="${blockY + Math.round(78 * s)}" width="${Math.round(440 * s)}" height="${Math.round(12 * s)}" rx="${Math.round(6 * s)}" fill="url(#accent)"/>
      ${titleSvg}
      <text x="${centerX}" y="${Math.min(height - Math.round(60 * s), blockY + blockH)}" text-anchor="middle" class="footer">${escapeXml(footer || '')}</text>
    </svg>
  `);
}

async function buildLogoComposite(logoPath, width) {
  if (!logoPath) return null;
  const absolute = storageAbs(logoPath);
  const storageRoot = path.resolve(env.storagePath);
  if (!absolute.startsWith(storageRoot + path.sep) || !fs.existsSync(absolute)) return null;
  const maxW = Math.round(width * 0.5);
  const maxH = Math.round(width * 0.12);
  const input = await sharp(absolute)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    input: input.data,
    left: Math.max(20, Math.round((width - input.info.width) / 2)),
    top: Math.round(width * 0.05),
  };
}

/** Compõe a imagem da capa (frame + overlay da marca) e salva jpg. */
async function composeCoverImage({ framePath, outputPath, width, height, title, user }) {
  const primary = normalizeColor(user.marca_cor_primaria, '#facc15');
  const secondary = normalizeColor(user.marca_cor_secundaria, '#fb923c');
  const overlay = buildCoverOverlay({
    width,
    height,
    title,
    category: user.marca_categoria || 'ASSISTA',
    footer: user.marca_rodape || user.marca_nome || '',
    primary,
    secondary,
  });

  const composites = [{ input: overlay, left: 0, top: 0 }];
  const logo = await buildLogoComposite(user.logo_path, width);
  if (logo) composites.push(logo);

  await sharp(framePath, { failOn: 'error' })
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .composite(composites)
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(outputPath);

  return outputPath;
}

/** Converte a imagem da capa em um clipe mudo de COVER_SECONDS com os mesmos parâmetros do corte. */
function coverImageToVideo({ imagePath, outputPath, width, height }) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1'])
      .input('anullsrc=channel_layout=stereo:sample_rate=48000')
      .inputFormat('lavfi')
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
        '-vf', `scale=${width}:${height}`,
        '-shortest',
        '-movflags', '+faststart',
      ])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/** Concatena capa + clipe reencodando com parâmetros compatíveis com Reels. */
function concatCoverAndClip({ coverPath, clipPath, outputPath, width, height }) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(coverPath)
      .input(clipPath)
      .complexFilter([
        `[0:v]scale=${width}:${height},setsar=1,fps=${OUTPUT_FPS}[v0]`,
        `[1:v]scale=${width}:${height},setsar=1,fps=${OUTPUT_FPS}[v1]`,
        '[0:a]aresample=48000[a0]',
        '[1:a]aresample=48000[a1]',
        '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
      ])
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
 * Gera a capa de marca e devolve o corte com a capa costurada no início.
 * @returns {Promise<{ relativePath: string, coverSeconds: number }>}
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

  const uid = crypto.randomBytes(4).toString('hex');
  const framePath = tempPath(`capa_frame_${clip.id}_${uid}.jpg`);
  const coverImagePath = tempPath(`capa_img_${clip.id}_${uid}.jpg`);
  const coverVideoPath = tempPath(`capa_video_${clip.id}_${uid}.mp4`);
  const outRelative = `clips/clip_${clip.id}_capa_${Date.now()}.mp4`;
  const outAbs = storageAbs(outRelative);

  try {
    await extractFrame(clipAbs, framePath, 0.5);
    await composeCoverImage({ framePath, outputPath: coverImagePath, width, height, title, user });
    await coverImageToVideo({ imagePath: coverImagePath, outputPath: coverVideoPath, width, height });
    await concatCoverAndClip({ coverPath: coverVideoPath, clipPath: clipAbs, outputPath: outAbs, width, height });
    return { relativePath: outRelative, coverSeconds: COVER_SECONDS };
  } catch (err) {
    safeUnlink(outAbs);
    throw err;
  } finally {
    safeUnlink(framePath);
    safeUnlink(coverImagePath);
    safeUnlink(coverVideoPath);
  }
}

module.exports = { addCoverToClip, COVER_SECONDS };
