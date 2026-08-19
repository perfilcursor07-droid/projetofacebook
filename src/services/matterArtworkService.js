const AiMatters = require('../models/AiMatters');
const Users = require('../models/Users');
const { env } = require('../config/env');
const { createEditorialCard, removeEditorialCard, fetchImage, ART_WIDTH, ART_HEIGHT, ensureTituloUrgenteAlerta, stripAlertMarks } = require('./editorialCardService');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function resolveArtworkPath(relativePath) {
  if (!relativePath) return null;
  const storageRoot = path.resolve(env.storagePath);
  const artworkRoot = path.resolve(storageRoot, 'artes');
  const absolute = path.resolve(storageRoot, relativePath);
  if (!absolute.startsWith(artworkRoot + path.sep) || !fs.existsSync(absolute)) return null;
  return absolute;
}

function resolveMatterSourcePath(publicUrl) {
  const normalized = String(publicUrl || '').replace(/\\/g, '/');
  if (!normalized.startsWith('/media/fontes/')) return null;
  const storageRoot = path.resolve(env.storagePath);
  const sourcesRoot = path.resolve(storageRoot, 'fontes');
  const relativePath = normalized.slice('/media/'.length).replace(/\//g, path.sep);
  const absolutePath = path.resolve(storageRoot, relativePath);
  if (!absolutePath.startsWith(sourcesRoot + path.sep)) return null;
  return absolutePath;
}

function removeMatterSourceImage(publicUrl) {
  const absolutePath = resolveMatterSourcePath(publicUrl);
  if (!absolutePath) return;
  try {
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (err) {
    console.warn('removeMatterSourceImage:', err.message);
  }
}

async function storeMatterSourceImage({ userId, matterId, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('Selecione uma imagem para continuar');
    err.status = 400;
    throw err;
  }

  const relativeDir = `fontes/user_${Number(userId)}`;
  const fileName = `materia_${Number(matterId)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const relativePath = `${relativeDir}/${fileName}`;
  const outputPath = path.resolve(env.storagePath, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .resize(3600, 3600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(outputPath);
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    const msg = String(err?.message || err || '');
    if (/heif|heic|bad seek|bitstream not supported/i.test(msg)) {
      const e = new Error(
        'Não foi possível ler a imagem (formato HEIF/HEIC). Envie um arquivo PNG ou JPG.'
      );
      e.status = 400;
      throw e;
    }
    const e = new Error('Não foi possível ler a imagem. Envie um arquivo PNG, JPG ou WebP válido.');
    e.status = 400;
    throw e;
  }

  return {
    relativePath,
    publicUrl: `/media/${relativePath.replace(/\\/g, '/')}`,
  };
}

function clampCropFraction(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * Recorta a foto original e salva uma nova fonte local em 4:5 (1080×1350).
 * As coordenadas são frações da imagem já orientada: 0 = início, 1 = fim.
 */
async function cropMatterSourceImage({
  userId,
  matterId,
  sourceUrl,
  left,
  top,
  width,
  height,
}) {
  const source = String(sourceUrl || '').trim();
  if (!source) {
    const err = new Error('A foto original não está disponível para recortar');
    err.status = 400;
    throw err;
  }

  const sourceBuffer = await fetchImage(source);
  const oriented = await sharp(sourceBuffer, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .toBuffer();
  const metadata = await sharp(oriented, { failOn: 'error', limitInputPixels: 40_000_000 })
    .metadata();
  const sourceWidth = Math.max(1, Number(metadata.width) || 0);
  const sourceHeight = Math.max(1, Number(metadata.height) || 0);

  const x = clampCropFraction(left, 0);
  const y = clampCropFraction(top, 0);
  const w = Math.min(1 - x, Math.max(0.03, clampCropFraction(width, 1)));
  const h = Math.min(1 - y, Math.max(0.03, clampCropFraction(height, 1)));

  let cropLeft = Math.min(sourceWidth - 1, Math.max(0, Math.round(x * sourceWidth)));
  let cropTop = Math.min(sourceHeight - 1, Math.max(0, Math.round(y * sourceHeight)));
  let cropWidth = Math.min(sourceWidth - cropLeft, Math.max(1, Math.round(w * sourceWidth)));
  let cropHeight = Math.min(sourceHeight - cropTop, Math.max(1, Math.round(h * sourceHeight)));

  if (cropWidth < 40 || cropHeight < 50) {
    const err = new Error('A área selecionada é pequena demais. Aumente o quadro de recorte.');
    err.status = 400;
    throw err;
  }

  // Corrige pequenos desvios de arredondamento para preservar 4:5 sem distorcer.
  const targetRatio = ART_WIDTH / ART_HEIGHT;
  if (cropWidth / cropHeight > targetRatio) {
    const adjustedWidth = Math.max(1, Math.round(cropHeight * targetRatio));
    cropLeft += Math.round((cropWidth - adjustedWidth) / 2);
    cropWidth = adjustedWidth;
  } else {
    const adjustedHeight = Math.max(1, Math.round(cropWidth / targetRatio));
    cropTop += Math.round((cropHeight - adjustedHeight) / 2);
    cropHeight = adjustedHeight;
  }

  const croppedBuffer = await sharp(oriented, { failOn: 'error', limitInputPixels: 40_000_000 })
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(ART_WIDTH, ART_HEIGHT, { fit: 'fill' })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  return storeMatterSourceImage({ userId, matterId, buffer: croppedBuffer });
}

async function composeMatterArtwork({
  userId,
  matterId,
  sourceUrl,
  title,
  force = false,
  zoom,
  offsetX,
  offsetY,
  model,
} = {}) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const finalTitleRaw = String(title || matter.titulo || '').trim();
  const user = await Users.findById(userId);
  if (!user) throw new Error('Usuário da matéria não encontrado');
  const { resolveArtModelForMatter } = require('./editorialCardModels');
  const modelId = resolveArtModelForMatter(user, model || matter.arte_modelo);

  let titleForArt = finalTitleRaw;
  let titleToStore = finalTitleRaw;
  if (modelId === 'urgente_alerta') {
    titleForArt = ensureTituloUrgenteAlerta(finalTitleRaw);
    titleToStore = titleForArt;
  } else {
    titleForArt = stripAlertMarks(finalTitleRaw);
  }

  const source = sourceUrl || matter.imagem_fonte_url ||
    (!matter.imagem_path && isRemoteUrl(matter.imagem_url) ? matter.imagem_url : null);
  if (!source) throw new Error('A matéria não possui foto de origem para criar a arte');

  const currentFile = resolveArtworkPath(matter.imagem_path);
  const hasFrame =
    zoom != null || offsetX != null || offsetY != null;

  let sizeOk = false;
  if (currentFile) {
    try {
      const meta = await sharp(currentFile).metadata();
      sizeOk = Number(meta.width) === ART_WIDTH && Number(meta.height) === ART_HEIGHT;
    } catch {
      sizeOk = false;
    }
  }

  // Reusa só se título/modelo iguais E arte já estiver no tamanho do feed (4:5).
  if (
    !force &&
    !hasFrame &&
    currentFile &&
    sizeOk &&
    titleToStore === String(matter.titulo || '').trim() &&
    matter.arte_modelo === modelId
  ) {
    return {
      matter,
      relativePath: matter.imagem_path,
      publicUrl: matter.imagem_url,
      filePath: currentFile,
      hasLogo: Boolean(user.logo_path),
      modelId,
      reused: true,
    };
  }

  const card = await createEditorialCard({
    sourceUrl: source,
    title: titleForArt,
    user,
    zoom,
    offsetX,
    offsetY,
    model: modelId,
  });

  try {
    await AiMatters.update(matter.id, {
      titulo: titleToStore,
      imagem_path: card.relativePath,
      imagem_url: card.publicUrl,
      imagem_fonte_url: source,
      arte_modelo: card.modelId,
      error_message: null,
    });
  } catch (err) {
    removeEditorialCard(card.relativePath);
    throw err;
  }

  if (matter.imagem_path && matter.imagem_path !== card.relativePath) {
    removeEditorialCard(matter.imagem_path);
  }
  if (matter.imagem_fonte_url && matter.imagem_fonte_url !== source) {
    removeMatterSourceImage(matter.imagem_fonte_url);
  }

  return {
    ...card,
    filePath: resolveArtworkPath(card.relativePath),
    matter: await AiMatters.findById(matter.id),
    reused: false,
  };
}

/**
 * Monta arte destacada a partir de DUAS fotos (lado a lado ou cima/baixo),
 * depois aplica Minha marca no mesmo fluxo 4:5.
 */
async function composeDualCollageArtwork({
  userId,
  matterId,
  imageUrlA,
  imageUrlB,
  thumbnailA = null,
  thumbnailB = null,
  layout = 'lado',
  title = null,
  zoom = 108,
  offsetX = 50,
  offsetY = 50,
} = {}) {
  const urlA = String(imageUrlA || '').trim();
  const urlB = String(imageUrlB || '').trim();
  if (!urlA || !urlB) {
    const err = new Error('Selecione duas imagens para montar a colagem');
    err.status = 400;
    throw err;
  }

  const { fetchImageWithFallback, buildDualCollageBuffer } = require('./editorialCardService');
  let bufA;
  let bufB;
  try {
    bufA = await fetchImageWithFallback(urlA, thumbnailA);
  } catch (err) {
    const e = new Error(`1ª foto: ${err.message || 'não baixou'}`);
    e.status = 400;
    throw e;
  }
  try {
    bufB = await fetchImageWithFallback(urlB, thumbnailB);
  } catch (err) {
    const e = new Error(`2ª foto: ${err.message || 'não baixou'}`);
    e.status = 400;
    throw e;
  }

  let collageBuffer;
  try {
    collageBuffer = await buildDualCollageBuffer(bufA, bufB, {
      layout,
      zoom,
      offsetX,
      offsetY,
    });
  } catch (err) {
    const e = new Error(`Falha ao montar as 2 fotos: ${err.message}`);
    e.status = 400;
    throw e;
  }

  const stored = await storeMatterSourceImage({
    userId,
    matterId,
    buffer: collageBuffer,
  });

  // Colagem já veio enquadrada; marca em cima com zoom neutro.
  return composeMatterArtwork({
    userId,
    matterId,
    sourceUrl: stored.publicUrl,
    title,
    force: true,
    zoom: 100,
    offsetX: 50,
    offsetY: 50,
  });
}

/**
 * Após gerar a matéria, compõe a arte 4:5 com título + Minha marca.
 * Se falhar, guarda a foto de origem e avisa (não derruba o fluxo).
 */
async function applyBrandArtworkToResult(userId, result) {
  const article = { ...(result.artigo || result.preview || {}) };
  const matter = result.matter;
  const warnings = Array.isArray(result.avisos) ? [...result.avisos] : [];
  const sourceUrl =
    article.imagemUrl ||
    matter?.imagem_fonte_url ||
    (matter && !matter.imagem_path && isRemoteUrl(matter.imagem_url) ? matter.imagem_url : null);

  if (!matter?.id || !sourceUrl) {
    return { ...result, artigo: article, preview: article, avisos: warnings };
  }

  // Já tem arte com marca no tamanho certo — evita regenerar em loops.
  if (matter.imagem_path && matter.arte_modelo && matter.imagem_fonte_url) {
    return { ...result, artigo: article, preview: article, avisos: warnings };
  }

  const sourceMeta = article.imagemOrigem || null;
  try {
    const artwork = await composeMatterArtwork({
      userId,
      matterId: matter.id,
      sourceUrl,
      title: article.titulo || matter.titulo,
      force: true,
    });
    article.imagemUrl = artwork.publicUrl;
    article.imagemOrigem = {
      ...(sourceMeta || {}),
      tipo: 'arte',
      rotulo: `Arte final 4:5 (1080×1350) com título${artwork.hasLogo ? ' e logomarca' : ''} · ${sourceMeta?.rotulo || 'foto editorial'}`,
      hasLogo: artwork.hasLogo,
    };
    return { ...result, matter: artwork.matter, artigo: article, preview: article, avisos: warnings };
  } catch (err) {
    await AiMatters.update(matter.id, {
      imagem_fonte_url: sourceUrl,
      imagem_path: null,
      // Preserve a foto editorial para exibição/seleção mesmo quando a composição da arte falha.
      imagem_url: sourceUrl,
      error_message: String(err.message).slice(0, 500),
    });
    article.imagemUrl = sourceUrl;
    warnings.push(`Não foi possível criar a arte com título e logomarca: ${err.message}`);
    return {
      ...result,
      matter: await AiMatters.findById(matter.id),
      artigo: article,
      preview: article,
      avisos: warnings,
    };
  }
}

module.exports = {
  composeMatterArtwork,
  composeDualCollageArtwork,
  applyBrandArtworkToResult,
  resolveArtworkPath,
  storeMatterSourceImage,
  cropMatterSourceImage,
  removeMatterSourceImage,
};
