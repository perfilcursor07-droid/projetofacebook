const DEFAULT_VIDEO_BRAND_MODEL = 'faixa_rodape';

/**
 * Modelos de identidade para VÍDEO / Reels — independentes dos modelos de arte (imagem).
 * Controlam como o texto fixo e overlays aparecem no corpo do vídeo (após a capa).
 */
const VIDEO_BRAND_MODELS = Object.freeze([
  Object.freeze({
    id: 'faixa_rodape',
    name: 'Faixa no rodapé',
    description: 'Barra escura no rodapé com título em caixa-alta. Limpo e legível.',
    posicaoPadrao: 'rodape',
  }),
  Object.freeze({
    id: 'faixa_topo',
    name: 'Faixa no topo',
    description: 'Barra escura no topo — útil quando o assunto está na parte de baixo do quadro.',
    posicaoPadrao: 'topo',
  }),
  Object.freeze({
    id: 'destaque_viral',
    name: 'Destaque viral',
    description:
      'Texto grande à esquerda com palavras em caixas coloridas (marque com [[palavra]]). Estilo thumbnail.',
    posicaoPadrao: 'rodape',
  }),
  Object.freeze({
    id: 'impacto_central',
    name: 'Impacto central',
    description: 'Título centralizado com fundo escuro e destaque nas palavras marcadas.',
    posicaoPadrao: 'rodape',
  }),
]);

const VIDEO_BRAND_MODEL_IDS = new Set(VIDEO_BRAND_MODELS.map((m) => m.id));

function isVideoBrandModel(value) {
  return VIDEO_BRAND_MODEL_IDS.has(String(value || ''));
}

function normalizeVideoBrandModel(value) {
  return isVideoBrandModel(value) ? String(value) : DEFAULT_VIDEO_BRAND_MODEL;
}

function videoBrandModelMeta(value) {
  const id = normalizeVideoBrandModel(value);
  return VIDEO_BRAND_MODELS.find((m) => m.id === id) || VIDEO_BRAND_MODELS[0];
}

module.exports = {
  VIDEO_BRAND_MODELS,
  DEFAULT_VIDEO_BRAND_MODEL,
  isVideoBrandModel,
  normalizeVideoBrandModel,
  videoBrandModelMeta,
};
