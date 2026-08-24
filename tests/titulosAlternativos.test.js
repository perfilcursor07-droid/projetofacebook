const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extrairAncorasTituloPrincipal,
  tituloPreservaNucleoPrincipal,
} = require('../src/services/deepseekService');

test('títulos alternativos preservam Janja e Michelle como núcleo da matéria', () => {
  const ancoras = extrairAncorasTituloPrincipal(
    'Janja e Michelle disputam voto evangélico feminino às vésperas da eleição de 2026'
  );

  assert.deepEqual(ancoras, ['Janja', 'Michelle']);
  assert.equal(
    tituloPreservaNucleoPrincipal(
      'Guerra pelo voto evangélico: Janja tenta avançar enquanto Michelle aposta nas igrejas',
      ancoras
    ),
    true
  );
  assert.equal(
    tituloPreservaNucleoPrincipal(
      'Datafolha aponta vantagem de Flávio Bolsonaro entre evangélicos no segundo turno',
      ancoras
    ),
    false
  );
  assert.equal(
    tituloPreservaNucleoPrincipal(
      'Por que Janja levou Kleber Lucas ao lançamento da campanha de Lula',
      ancoras
    ),
    false
  );
});

test('núcleo com nome composto aceita duas âncoras do assunto principal', () => {
  const ancoras = extrairAncorasTituloPrincipal(
    'Volta de David Filho à IPDA gera bate-boca nas redes'
  );

  assert.deepEqual(ancoras, ['David', 'Filho', 'IPDA']);
  assert.equal(
    tituloPreservaNucleoPrincipal(
      'David Filho volta à IPDA em meio a reações e bate-boca nas redes',
      ancoras
    ),
    true
  );
  assert.equal(
    tituloPreservaNucleoPrincipal('Sobrinho chama críticos de cachorros e provoca reação', ancoras),
    false
  );
});
