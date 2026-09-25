const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pedidoQuerPesquisaGuardada,
  fontesDaPesquisaGuardada,
} = require('../src/services/materiaChatService');

test('reaproveita a pesquisa quando o editor pede', () => {
  for (const pedido of [
    'aproveite as pesquisas que vc já fez e faça outra materia',
    'use a pesquisa anterior e escreva outra',
    'faça outra matéria com essas informações',
    'outra matéria',
    'mais uma pauta',
  ]) {
    assert.equal(pedidoQuerPesquisaGuardada(pedido), true, pedido);
  }
});

test('nova pesquisa, link ou outro assunto seguem o fluxo normal', () => {
  for (const pedido of [
    'faça uma nova pesquisa',
    'pesquise de novo e faça outra matéria',
    'outra matéria sobre o pastor Silas Malafaia',
    'outra matéria, pesquise na internet',
    'faça uma matéria deste link https://exemplo.com/noticia',
    'deixa mais curta',
  ]) {
    assert.equal(pedidoQuerPesquisaGuardada(pedido), false, pedido);
  }
});

test('pesquisa guardada junta fontes recentes sem repetir', () => {
  const agora = Date.parse('2026-09-24T12:00:00Z');
  const anteriores = [
    {
      role: 'assistant',
      created_at: '2026-09-22T10:00:00Z', // mais de 24h: fora
      fontes: JSON.stringify([{ url: 'https://velha.com/a', trecho: 'fato velho' }]),
    },
    {
      role: 'assistant',
      created_at: '2026-09-24T10:00:00Z',
      fontes: JSON.stringify([
        { url: 'https://uol.com/a', trecho: 'fato 1' },
        { url: 'https://nd.com/b', resumo: 'fato 2' },
        { url: 'https://sem-trecho.com/c' },
        { titulo: 'Pauta', ehPauta: true, resumo: 'lista' },
      ]),
    },
    { role: 'user', created_at: '2026-09-24T11:00:00Z', content: 'outra' },
    {
      role: 'assistant',
      created_at: '2026-09-24T11:30:00Z',
      fontes: JSON.stringify([
        { url: 'https://uol.com/a?utm=x', trecho: 'fato 1 repetido' },
        { url: 'https://g1.com/d', trecho: 'fato 3' },
      ]),
    },
  ];
  const pool = fontesDaPesquisaGuardada(anteriores, { agora });
  assert.deepEqual(pool.map((f) => f.url), [
    'https://uol.com/a?utm=x',
    'https://g1.com/d',
    'https://nd.com/b',
  ]);
});
