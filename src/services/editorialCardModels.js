const DEFAULT_ART_MODEL = 'faixa_classica';

const ART_MODELS = Object.freeze([
  Object.freeze({
    id: 'faixa_classica',
    name: 'Faixa clássica',
    description: 'Categoria e faixa horizontal. A foto preenche a arte 4:5 inteira (sem faixas blur).',
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
    description: 'Banner colorido da categoria com título limpo abaixo.',
  }),
  Object.freeze({
    id: 'moldura_editorial',
    name: 'Moldura editorial',
    description: 'Moldura dupla e tipografia central, estilo revista.',
  }),
  Object.freeze({
    id: 'impacto_central',
    name: 'Impacto central',
    description: 'Placa escura central com título de alto impacto.',
  }),
  Object.freeze({
    id: 'canto_solido',
    name: 'Canto sólido',
    description: 'Selo angular no canto e hierarquia editorial à esquerda.',
  }),
  Object.freeze({
    id: 'estilo_fatos',
    name: 'Estilo Fatos',
    description: 'Foto full-bleed, logo da marca acima do título e tipografia grande no rodapé escuro.',
  }),
  Object.freeze({
    id: 'citacao_marcador',
    name: 'Citação marcador',
    description: 'Foto no topo, logo no divisor e citação com destaque amarelo no bloco preto — estilo viral.',
  }),
  Object.freeze({
    id: 'urgente_alerta',
    name: 'Urgente alerta',
    description: 'Faixa vermelha de plantão no topo, manchete em caixa alta com palavras destacadas e logo no rodapé.',
  }),
  Object.freeze({
    id: 'jm',
    name: 'JM',
    description:
      'Foto no topo, logo na faixa amarela e manchete escura em cartão branco, com palavras destacadas em azul e o site no rodapé.',
  }),
]);

const ART_MODEL_IDS = new Set(ART_MODELS.map((model) => model.id));
const ART_MODEL_BY_ID = Object.freeze(
  Object.fromEntries(ART_MODELS.map((model) => [model.id, model]))
);

function isArtModel(value) {
  return ART_MODEL_IDS.has(String(value || ''));
}

function normalizeArtModel(value) {
  return isArtModel(value) ? String(value) : DEFAULT_ART_MODEL;
}

/** Secundário opcional — null se vazio ou inválido. */
function normalizeOptionalArtModel(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'none' || raw === 'nenhum') return null;
  return isArtModel(raw) ? raw : null;
}

/**
 * Principal + secundário (se distinto) cadastrados em Minha marca.
 */
function getUserArtModelChoices(user) {
  const primary = normalizeArtModel(user?.marca_modelo_arte);
  let secondary = normalizeOptionalArtModel(user?.marca_modelo_arte_secundario);
  if (secondary === primary) secondary = null;

  const choices = [{ ...ART_MODEL_BY_ID[primary], role: 'principal' }];
  if (secondary && ART_MODEL_BY_ID[secondary]) {
    choices.push({ ...ART_MODEL_BY_ID[secondary], role: 'secundario' });
  }
  return { primary, secondary, choices };
}

/** Modelo efetivo da arte: preferência da matéria/request, senão principal. */
function resolveArtModelForMatter(user, preferred) {
  const { primary, secondary } = getUserArtModelChoices(user);
  const pref = String(preferred || '').trim();
  if (pref && (pref === primary || pref === secondary)) return pref;
  return primary;
}

module.exports = {
  ART_MODELS,
  DEFAULT_ART_MODEL,
  isArtModel,
  normalizeArtModel,
  normalizeOptionalArtModel,
  getUserArtModelChoices,
  resolveArtModelForMatter,
};
