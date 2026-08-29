const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  ART_MODELS,
  isArtModel,
  normalizeArtModel,
} = require('../src/services/editorialCardModels');
const { buildBrandModelPreviewPng } = require('../src/services/editorialCardService');
const {
  normalizeModelConfig,
  applyModelConfig,
} = require('../src/services/brandModelConfig');

test('Painel premium está disponível como modelo de arte', () => {
  const model = ART_MODELS.find((item) => item.id === 'painel_premium');

  assert.ok(model);
  assert.equal(model.name, 'Painel premium');
  assert.equal(isArtModel('painel_premium'), true);
  assert.equal(normalizeArtModel('painel_premium'), 'painel_premium');
});

test('Painel premium renderiza uma prévia PNG válida em 4:5', async () => {
  const png = await buildBrandModelPreviewPng({
    user: {
      marca_nome: 'Portal Exemplo',
      marca_categoria: 'DESTAQUE',
      marca_rodape: 'Informação com credibilidade',
      marca_cor_primaria: '#f5a623',
      marca_cor_secundaria: '#f97316',
      marca_titulo_tamanho: 'medio',
    },
    model: 'painel_premium',
    title: 'Lideranças anunciam uma nova etapa para projeto que mobiliza a comunidade',
    width: 432,
    height: 540,
  });

  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 432);
  assert.equal(metadata.height, 540);
  assert.ok(png.length > 20_000);
});

test('Largura do Painel premium é configurável e limitada entre 80% e 100%', () => {
  assert.equal(normalizeModelConfig({ painelLargura: 76 }).painelLargura, 80);
  assert.equal(normalizeModelConfig({ painelLargura: 95 }).painelLargura, 95);
  assert.equal(normalizeModelConfig({ painelLargura: 120 }).painelLargura, 100);

  const aplicado = applyModelConfig(
    { marca_modelo_config: JSON.stringify({ painel_premium: { painelLargura: 84 } }) },
    'painel_premium'
  );
  assert.equal(aplicado.painelLargura, 84);
});
