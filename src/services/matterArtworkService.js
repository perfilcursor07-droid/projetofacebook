const fs = require('fs');
const path = require('path');
const AiMatters = require('../models/AiMatters');
const Users = require('../models/Users');
const { env } = require('../config/env');
const { createEditorialCard, removeEditorialCard } = require('./editorialCardService');

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

  const currentFile = resolveArtworkPath(matter.imagem_path);
  if (!force && currentFile && finalTitle === String(matter.titulo || '').trim()) {
    const user = await Users.findById(userId);
    return {
      matter,
      relativePath: matter.imagem_path,
      publicUrl: matter.imagem_url,
      filePath: currentFile,
      hasLogo: Boolean(user?.logo_path),
      reused: true,
    };
  }

  const user = await Users.findById(userId);
  if (!user) throw new Error('Usuário da matéria não encontrado');
  const card = await createEditorialCard({ sourceUrl: source, title: finalTitle, user });

  try {
    await AiMatters.update(matter.id, {
      titulo: finalTitle,
      imagem_path: card.relativePath,
      imagem_url: card.publicUrl,
      imagem_fonte_url: source,
      error_message: null,
    });
  } catch (err) {
    removeEditorialCard(card.relativePath);
    throw err;
  }

  if (matter.imagem_path && matter.imagem_path !== card.relativePath) {
    removeEditorialCard(matter.imagem_path);
  }

  return {
    ...card,
    filePath: resolveArtworkPath(card.relativePath),
    matter: await AiMatters.findById(matter.id),
    reused: false,
  };
}

module.exports = { composeMatterArtwork, resolveArtworkPath };
