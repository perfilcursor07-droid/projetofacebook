const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const Users = require('../models/Users');
const { env } = require('../config/env');
const { buildBrandModelPreviewPng } = require('../services/editorialCardService');
const {
  ART_MODELS,
  DEFAULT_ART_MODEL,
  isArtModel,
} = require('../services/editorialCardModels');
const {
  SOMBRAS,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_PADRAO,
  JM_TITLE_GAP_MIN,
  JM_TITLE_GAP_MAX,
  JM_TITLE_GAP_DEFAULT,
  parseModelConfigs,
  withModelConfig,
} = require('../services/brandModelConfig');
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

/** Assinatura curta das opções que mudam o desenho — invalida o cache das miniaturas. */
function brandPreviewVersion(profile = {}) {
  const parts = [
    profile.marca_categoria,
    profile.marca_rodape,
    profile.marca_nome,
    profile.marca_cor_primaria,
    profile.marca_cor_secundaria,
    profile.marca_fonte,
    profile.marca_titulo_cor,
    profile.marca_titulo_tamanho,
    profile.marca_modelo_config,
    profile.logo_path,
    profile.updated_at ? new Date(profile.updated_at).getTime() : '',
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

/** PNG de pré-visualização de um modelo de arte, renderizado pelo gerador real. */
async function artModelPreview(req, res, next) {
  try {
    const modelId = String(req.params.model || '');
    if (!isArtModel(modelId)) return res.status(404).end();

    const profile = await Users.findById(req.session.userId);
    if (!profile) return res.status(404).end();

    // O painel de personalização manda as opções na query para ver o resultado
    // antes de salvar. Sem query, sai a miniatura com o que já está gravado.
    const overrides = {
      tituloTamanho: req.query.tamanho,
      tituloEspaco: req.query.tituloEspaco,
      tituloCor: req.query.tituloCor,
      fonte: req.query.fonte,
      corPrimaria: req.query.cor1,
      corSecundaria: req.query.cor2,
      degrade: req.query.degrade,
      sombra: req.query.sombra,
      zoom: req.query.zoom,
    };
    const aoVivo = Object.values(overrides).some((v) => v != null && v !== '');

    const png = await buildBrandModelPreviewPng({
      user: profile,
      model: modelId,
      width: 432,
      height: 540,
      overrides,
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', aoVivo ? 'no-store' : 'private, max-age=86400');
    return res.end(png);
  } catch (err) {
    return next(err);
  }
}

/** Salva a personalização de UM modelo (painel de Minha marca). */
async function saveModelConfig(req, res, next) {
  try {
    const modelId = String(req.body?.modelo || req.body?.model || '');
    if (!isArtModel(modelId)) {
      return res.status(400).json({ error: 'Modelo de arte inválido' });
    }

    const current = await Users.findById(req.session.userId);
    if (!current) return res.status(404).json({ error: 'Usuário não encontrado' });

    // "Restaurar padrão": manda vazio e o modelo volta a seguir a marca.
    const limpar = req.body?.limpar === true || req.body?.limpar === '1';
    const entrada = limpar ? {} : req.body?.config || req.body || {};
    const json = withModelConfig(current, modelId, entrada);
    await Users.update(current.id, { marca_modelo_config: json });

    const atualizado = await Users.findById(current.id);
    const configs = parseModelConfigs(atualizado.marca_modelo_config);
    return res.json({
      ok: true,
      modelo: modelId,
      config: configs[modelId] || {},
      previewVersion: brandPreviewVersion(atualizado),
    });
  } catch (err) {
    return next(err);
  }
}

async function show(req, res, next) {
  try {
    const profile = await Users.findById(req.session.userId);
    if (!profile) return res.redirect('/api/auth/logout');
    res.render('minha-marca', {
      title: 'Minha marca',
      profile,
      previewVersion: brandPreviewVersion(profile),
      artModels: ART_MODELS,
      defaultArtModel: DEFAULT_ART_MODEL,
      modelConfigs: parseModelConfigs(profile.marca_modelo_config),
      sombraOptions: SOMBRAS,
      zoomMin: ZOOM_MIN,
      zoomMax: ZOOM_MAX,
      zoomDefault: ZOOM_PADRAO,
      jmTitleGapMin: JM_TITLE_GAP_MIN,
      jmTitleGapMax: JM_TITLE_GAP_MAX,
      jmTitleGapDefault: JM_TITLE_GAP_DEFAULT,
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

    const { normalizeOptionalArtModel } = require('../services/editorialCardModels');
    let requestedSecondary = normalizeOptionalArtModel(req.body.marca_modelo_arte_secundario);
    if (requestedSecondary === requestedModel) requestedSecondary = null;

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
      marca_modelo_arte_secundario: requestedSecondary,
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
      patch.marca_modelo_arte = requestedModel;
      patch.marca_modelo_arte_secundario = requestedSecondary;
    } else {
      // Aba vídeo: não sobrescreve modelos de arte
      delete patch.marca_modelo_arte;
      delete patch.marca_modelo_arte_secundario;
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

module.exports = { show, update, artModelPreview, saveModelConfig };
