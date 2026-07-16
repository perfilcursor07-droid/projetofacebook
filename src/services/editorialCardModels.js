const DEFAULT_ART_MODEL = 'faixa_classica';

const ART_MODELS = Object.freeze([
  Object.freeze({
    id: 'faixa_classica',
    name: 'Clássica',
    description: 'Faixa e título centralizados.',
  }),
  Object.freeze({
    id: 'bloco_inferior',
    name: 'Painel',
    description: 'Bloco escuro no rodapé.',
  }),
  Object.freeze({
    id: 'minimalista',
    name: 'Minimal',
    description: 'Foto em destaque, badge leve.',
  }),
  Object.freeze({
    id: 'barra_lateral',
    name: 'Editorial',
    description: 'Acento vertical à esquerda.',
  }),
  Object.freeze({
    id: 'vidro',
    name: 'Vidro',
    description: 'Painel translúcido arredondado.',
  }),
  Object.freeze({
    id: 'manchete',
    name: 'Manchete',
    description: 'Caixa de título com impacto.',
  }),
  Object.freeze({
    id: 'fita_diagonal',
    name: 'Fita',
    description: 'Categoria em faixa diagonal.',
  }),
  Object.freeze({
    id: 'ticker',
    name: 'Ticker',
    description: 'Barra de notícia no rodapé.',
  }),
]);

const ART_MODEL_IDS = new Set(ART_MODELS.map((model) => model.id));

function isArtModel(value) {
  return ART_MODEL_IDS.has(String(value || ''));
}

function normalizeArtModel(value) {
  return isArtModel(value) ? String(value) : DEFAULT_ART_MODEL;
}

module.exports = { ART_MODELS, DEFAULT_ART_MODEL, isArtModel, normalizeArtModel };
