const AiMatters = require('../models/AiMatters');
const Users = require('../models/Users');
const { env } = require('../config/env');
const { createEditorialCard, removeEditorialCard, ART_WIDTH, ART_HEIGHT } = require('./editorialCardService');
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
      .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      .toFile(outputPath);
  } catch (_err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    const err = new Error('Não foi possível ler a imagem. Envie um arquivo PNG, JPG ou WebP válido.');
    err.status = 400;
    throw err;
  }

  return {
    relativePath,
    publicUrl: `/media/${relativePath.replace(/\\/g, '/')}`,
  };
}

async function composeMatterArtwork({ userId, matterId, sourceUrl, title, force = false }) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const finalTitle = String(title || matter.titulo || '').trim();
  const source = sourceUrl || matter.imagem_fonte_url ||
    (!matter.imagem_path && isRemoteUrl(matter.imagem_url) ? matter.imagem_url : null);
  if (!source) throw new Error('A matéria não possui foto de origem para criar a arte');

  const user = await Users.findById(userId);
  if (!user) throw new Error('Usuário da matéria não encontrado');
  const { normalizeArtModel } = require('./editorialCardModels');
  const modelId = normalizeArtModel(user.marca_modelo_arte);
  const currentFile = resolveArtworkPath(matter.imagem_path);

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
    currentFile &&
    sizeOk &&
    finalTitle === String(matter.titulo || '').trim() &&
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

  const card = await createEditorialCard({ sourceUrl: source, title: finalTitle, user });

  try {
    await AiMatters.update(matter.id, {
      titulo: finalTitle,
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
      imagem_url: null,
      error_message: String(err.message).slice(0, 500),
    });
    article.imagemUrl = null;
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
  applyBrandArtworkToResult,
  resolveArtworkPath,
  storeMatterSourceImage,
  removeMatterSourceImage,
};
