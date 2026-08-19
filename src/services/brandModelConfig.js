/**
 * Personalização por modelo de arte (Minha marca → clicar no modelo).
 *
 * As opções da marca valem para todos os modelos; aqui ficam os ajustes de UM
 * modelo. O que não for personalizado continua seguindo a marca, então um
 * modelo sem configuração renderiza exatamente como antes.
 */
const { isArtModel } = require('./editorialCardModels');

/** Intensidade do escurecimento aplicado sobre a foto. */
const SOMBRAS = Object.freeze([
  Object.freeze({ id: 'leve', name: 'Leve', fator: 0.72 }),
  Object.freeze({ id: 'media', name: 'Média', fator: 1 }),
  Object.freeze({ id: 'forte', name: 'Forte', fator: 1.28 }),
]);
const SOMBRA_PADRAO = 'media';

/** Tamanho da foto = zoom do enquadramento (100 = preenche o quadro). */
const ZOOM_MIN = 80;
const ZOOM_MAX = 140;
const ZOOM_PADRAO = 100;

/** Distância vertical entre a faixa/logo do JM e o início da manchete. */
const JM_TITLE_GAP_MIN = 0;
const JM_TITLE_GAP_MAX = 140;
const JM_TITLE_GAP_DEFAULT = 18;

function normalizarCor(valor) {
  const cor = String(valor || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(cor) ? cor : null;
}

function normalizarSombra(valor) {
  const id = String(valor || '').trim().toLowerCase();
  return SOMBRAS.some((s) => s.id === id) ? id : SOMBRA_PADRAO;
}

function fatorDaSombra(valor) {
  const found = SOMBRAS.find((s) => s.id === normalizarSombra(valor));
  return found ? found.fator : 1;
}

function normalizarZoom(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return ZOOM_PADRAO;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n)));
}

function normalizarEspacoTituloJm(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return JM_TITLE_GAP_DEFAULT;
  return Math.min(JM_TITLE_GAP_MAX, Math.max(JM_TITLE_GAP_MIN, Math.round(n)));
}

function normalizarBooleano(valor, padrao = true) {
  if (valor == null || valor === '') return padrao;
  if (valor === true || valor === 1) return true;
  if (valor === false || valor === 0) return false;
  const s = String(valor).trim().toLowerCase();
  if (['1', 'true', 'on', 'sim'].includes(s)) return true;
  if (['0', 'false', 'off', 'nao', 'não'].includes(s)) return false;
  return padrao;
}

/**
 * Limpa a configuração de um modelo. Campo ausente = segue a marca (null),
 * e é isso que mantém o comportamento antigo de quem nunca personalizou.
 */
function normalizeModelConfig(entrada = {}) {
  const { normalizeBrandFont, normalizeTitleColor, normalizeTitleSize, BRAND_FONTS, TITLE_COLORS } =
    require('./brandFonts');

  const cfg = {};
  const tamanho = entrada.tituloTamanho ?? entrada.titulo_tamanho;
  if (tamanho != null && tamanho !== '') cfg.tituloTamanho = normalizeTitleSize(tamanho);

  const tituloEspaco =
    entrada.tituloEspaco ?? entrada.titulo_espaco ?? entrada.titleGap ?? entrada.title_gap;
  if (tituloEspaco != null && tituloEspaco !== '') {
    cfg.tituloEspaco = normalizarEspacoTituloJm(tituloEspaco);
  }

  const corTitulo = String(entrada.tituloCor ?? entrada.titulo_cor ?? '').trim();
  if (corTitulo && TITLE_COLORS.some((c) => c.id === corTitulo)) {
    cfg.tituloCor = normalizeTitleColor(corTitulo);
  }

  const fonte = String(entrada.fonte || '').trim();
  if (fonte && BRAND_FONTS.some((f) => f.id === fonte)) cfg.fonte = normalizeBrandFont(fonte);

  const primaria = normalizarCor(entrada.corPrimaria ?? entrada.cor_primaria);
  if (primaria) cfg.corPrimaria = primaria;
  const secundaria = normalizarCor(entrada.corSecundaria ?? entrada.cor_secundaria);
  if (secundaria) cfg.corSecundaria = secundaria;

  if (entrada.degrade != null && entrada.degrade !== '') {
    cfg.degrade = normalizarBooleano(entrada.degrade, true);
  }
  if (entrada.sombra != null && entrada.sombra !== '') cfg.sombra = normalizarSombra(entrada.sombra);
  if (entrada.zoom != null && entrada.zoom !== '') cfg.zoom = normalizarZoom(entrada.zoom);

  return cfg;
}

/** Lê o JSON salvo em users.marca_modelo_config. */
function parseModelConfigs(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const saida = {};
    for (const [modelo, cfg] of Object.entries(obj)) {
      if (!isArtModel(modelo) || !cfg || typeof cfg !== 'object') continue;
      saida[modelo] = normalizeModelConfig(cfg);
    }
    return saida;
  } catch {
    return {};
  }
}

/** Configuração salva de um modelo (vazio = tudo herdado da marca). */
function configForModel(user, modelId) {
  const todos = parseModelConfigs(user?.marca_modelo_config);
  return todos[String(modelId || '')] || {};
}

/** Grava a configuração de um modelo, preservando a dos demais. */
function withModelConfig(user, modelId, entrada) {
  const todos = parseModelConfigs(user?.marca_modelo_config);
  const cfg = normalizeModelConfig(entrada);
  if (Object.keys(cfg).length) todos[modelId] = cfg;
  else delete todos[modelId];
  return JSON.stringify(todos);
}

/**
 * Usuário "efetivo" para renderizar um modelo: marca + ajustes do modelo.
 * Devolve uma cópia — nunca altera o registro original.
 */
function applyModelConfig(user, modelId, extras = {}) {
  const base = { ...(user || {}) };
  const cfg = { ...configForModel(user, modelId), ...normalizeModelConfig(extras) };
  if (cfg.tituloTamanho != null) base.marca_titulo_tamanho = cfg.tituloTamanho;
  if (cfg.tituloCor) base.marca_titulo_cor = cfg.tituloCor;
  if (cfg.fonte) base.marca_fonte = cfg.fonte;
  if (cfg.corPrimaria) base.marca_cor_primaria = cfg.corPrimaria;
  if (cfg.corSecundaria) base.marca_cor_secundaria = cfg.corSecundaria;
  return {
    user: base,
    degrade: cfg.degrade !== false,
    sombra: normalizarSombra(cfg.sombra),
    sombraFator: fatorDaSombra(cfg.sombra),
    zoom: cfg.zoom != null ? normalizarZoom(cfg.zoom) : null,
    tituloEspaco:
      cfg.tituloEspaco != null
        ? normalizarEspacoTituloJm(cfg.tituloEspaco)
        : JM_TITLE_GAP_DEFAULT,
    config: cfg,
  };
}

module.exports = {
  SOMBRAS,
  SOMBRA_PADRAO,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_PADRAO,
  JM_TITLE_GAP_MIN,
  JM_TITLE_GAP_MAX,
  JM_TITLE_GAP_DEFAULT,
  normalizeModelConfig,
  parseModelConfigs,
  configForModel,
  withModelConfig,
  applyModelConfig,
  fatorDaSombra,
};
