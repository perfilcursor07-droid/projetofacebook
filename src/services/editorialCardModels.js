const DEFAULT_ART_MODEL = 'faixa_classica';

const ART_MODELS = Object.freeze([
  Object.freeze({
    id: 'faixa_classica',
    name: 'Faixa clássica',
    description: 'Categoria e faixa horizontal, com título centralizado e espaçamento confortável.',
  }),
  Object.freeze({
    id: 'bloco_inferior',
    name: 'Bloco inferior',
    description: 'Painel escuro no rodapé e conteúdo alinhado à esquerda.',
  }),
  Object.freeze({
    id: 'minimalista',
    name: 'Minimalista',
    description: 'Mais destaque para a foto, com elementos leves e título amplo.',
  }),
  Object.freeze({
    id: 'barra_lateral',
    name: 'Barra lateral',
    description: 'Acento vertical e conteúdo editorial alinhado à esquerda.',
  }),
  Object.freeze({
    id: 'faixa_topo',
    name: 'Faixa no topo',
    description: 'Categoria em faixa colorida larga e título centralizado logo abaixo.',
  }),
  Object.freeze({
    id: 'moldura_editorial',
    name: 'Moldura editorial',
    description: 'Borda colorida envolvendo a arte, com título centralizado no rodapé.',
  }),
  Object.freeze({
    id: 'impacto_central',
    name: 'Impacto central',
    description: 'Categoria entre dois traços e título grande bem no centro inferior.',
  }),
  Object.freeze({
    id: 'canto_solido',
    name: 'Canto sólido',
    description: 'Bloco colorido no canto com a categoria e título alinhado à esquerda.',
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
