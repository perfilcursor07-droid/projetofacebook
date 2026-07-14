const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Users = require('../models/Users');
const { env } = require('../config/env');

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

function color(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function removeStorageFile(relativePath) {
  if (!relativePath) return;
  const storageRoot = path.resolve(env.storagePath);
  const absolute = path.resolve(storageRoot, relativePath);
  if (!absolute.startsWith(storageRoot + path.sep)) return;
  try {
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch {
    // A atualização da marca não deve falhar só porque a logo antiga não pôde ser removida.
  }
}

async function show(req, res, next) {
  try {
    const profile = await Users.findById(req.session.userId);
    if (!profile) return res.redirect('/api/auth/logout');
    res.render('minha-marca', {
      title: 'Minha marca',
      profile,
      saved: req.query.saved === '1',
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  let temporaryPath = req.file?.path || null;
  try {
    const current = await Users.findById(req.session.userId);
    if (!current) {
      const err = new Error('Usuário não encontrado');
      err.status = 404;
      throw err;
    }

    const patch = {
      marca_nome: clean(req.body.marca_nome, 120),
      marca_categoria: clean(req.body.marca_categoria, 80) || 'ÚLTIMAS',
      marca_rodape: clean(req.body.marca_rodape, 160),
      marca_cor_primaria: color(req.body.marca_cor_primaria, '#facc15'),
      marca_cor_secundaria: color(req.body.marca_cor_secundaria, '#fb923c'),
    };

    if (req.file) {
      const outputDir = path.resolve(env.storagePath, 'logos');
      const outputPath = path.join(outputDir, `user_${req.session.userId}.png`);
      fs.mkdirSync(outputDir, { recursive: true });

      // Decodificar e regravar elimina arquivos disfarçados e padroniza transparência/tamanho.
      await sharp(req.file.path, { failOn: 'error' })
        .rotate()
        .resize(1200, 400, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toFile(outputPath);
      fs.unlinkSync(req.file.path);
      temporaryPath = null;
      patch.logo_path = `logos/user_${req.session.userId}.png`;
      if (current.logo_path && current.logo_path !== patch.logo_path) {
        removeStorageFile(current.logo_path);
      }
    }

    if (req.body.remover_logo === '1') {
      removeStorageFile(current.logo_path);
      patch.logo_path = null;
    }

    await Users.update(req.session.userId, patch);
    res.redirect('/minha-marca?saved=1');
  } catch (err) {
    if (temporaryPath) removeStorageFile(path.relative(path.resolve(env.storagePath), temporaryPath));
    next(err);
  }
}

module.exports = { show, update };
