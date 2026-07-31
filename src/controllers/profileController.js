const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Users = require('../models/Users');
const { env } = require('../config/env');
const {
  ART_MODELS,
  DEFAULT_ART_MODEL,
  isArtModel,
} = require('../services/editorialCardModels');
const {
  VIDEO_BRAND_MODELS,
  DEFAULT_VIDEO_BRAND_MODEL,
  isVideoBrandModel,
  normalizeVideoBrandModel,
} = require('../services/videoBrandModels');
const {
  BRAND_FONTS,
  DEFAULT_BRAND_FONT,
  TITLE_COLORS,
  DEFAULT_TITLE_COLOR,
  TITLE_SIZE_MIN,
  TITLE_SIZE_MAX,
  DEFAULT_TITLE_SIZE,
  normalizeBrandFont,
  normalizeTitleColor,
  normalizeTitleSize,
  googleFontsHref,
} = require('../services/brandFonts');

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
      artModels: ART_MODELS,
      defaultArtModel: DEFAULT_ART_MODEL,
      videoBrandModels: VIDEO_BRAND_MODELS,
      defaultVideoBrandModel: DEFAULT_VIDEO_BRAND_MODEL,
      brandFonts: BRAND_FONTS,
      defaultBrandFont: DEFAULT_BRAND_FONT,
      titleColors: TITLE_COLORS,
      defaultTitleColor: DEFAULT_TITLE_COLOR,
      titleSizeMin: TITLE_SIZE_MIN,
      titleSizeMax: TITLE_SIZE_MAX,
      defaultTitleSize: DEFAULT_TITLE_SIZE,
      googleFontsHref: googleFontsHref(),
      saved: req.query.saved === '1',
      error: req.query.error || null,
      tab: String(req.query.tab || 'imagem') === 'video' ? 'video' : 'imagem',
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

    const requestedModel = String(req.body.marca_modelo_arte || current.marca_modelo_arte || DEFAULT_ART_MODEL);
    if (!isArtModel(requestedModel)) {
      if (temporaryPath) {
        removeStorageFile(path.relative(path.resolve(env.storagePath), temporaryPath));
        temporaryPath = null;
      }
      return res.redirect(`/minha-marca?error=${encodeURIComponent('Selecione um modelo de arte válido.')}`);
    }

    const requestedVideoModel = String(
      req.body.marca_video_modelo || current.marca_video_modelo || DEFAULT_VIDEO_BRAND_MODEL
    );
    if (!isVideoBrandModel(requestedVideoModel)) {
      if (temporaryPath) {
        removeStorageFile(path.relative(path.resolve(env.storagePath), temporaryPath));
        temporaryPath = null;
      }
      return res.redirect(
        `/minha-marca?tab=video&error=${encodeURIComponent('Selecione um modelo de vídeo válido.')}`
      );
    }

    const tab = String(req.body.marca_tab || req.query.tab || 'imagem') === 'video' ? 'video' : 'imagem';

    // Nome/logo/cores são comuns. Tipografia e modelo de arte só na aba imagem;
    // modelo de vídeo e cor de destaque só na aba vídeo (não sobrescreve a outra).
    const patch = {
      marca_nome: clean(req.body.marca_nome, 120),
      marca_categoria: clean(req.body.marca_categoria, 80) || 'ÚLTIMAS',
      marca_rodape: clean(req.body.marca_rodape, 160),
      marca_cor_primaria: color(req.body.marca_cor_primaria, '#ffbd59'),
      marca_cor_secundaria: color(req.body.marca_cor_secundaria, '#fb923c'),
      marca_modelo_arte: requestedModel,
      marca_video_modelo: normalizeVideoBrandModel(requestedVideoModel),
    };

    if (tab === 'imagem') {
      patch.marca_fonte = normalizeBrandFont(req.body.marca_fonte || current.marca_fonte);
      patch.marca_titulo_cor = normalizeTitleColor(req.body.marca_titulo_cor || current.marca_titulo_cor);
      patch.marca_titulo_tamanho = normalizeTitleSize(
        req.body.marca_titulo_tamanho != null && req.body.marca_titulo_tamanho !== ''
          ? req.body.marca_titulo_tamanho
          : current.marca_titulo_tamanho
      );
    } else {
      patch.marca_video_cor_destaque = color(
        req.body.marca_video_cor_destaque || current.marca_video_cor_destaque,
        '#facc15'
      );
    }

    const removeLogo = req.body.remover_logo === '1';
    if (removeLogo) {
      if (temporaryPath) {
        removeStorageFile(path.relative(path.resolve(env.storagePath), temporaryPath));
        temporaryPath = null;
      }
      removeStorageFile(current.logo_path);
      patch.logo_path = null;
    } else if (req.file) {
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

    await Users.update(req.session.userId, patch);
    res.redirect(tab === 'video' ? '/minha-marca?tab=video&saved=1' : '/minha-marca?saved=1');
  } catch (err) {
    if (temporaryPath) removeStorageFile(path.relative(path.resolve(env.storagePath), temporaryPath));
    next(err);
  }
}

module.exports = { show, update };
