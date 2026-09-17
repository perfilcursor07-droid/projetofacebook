const test = require('node:test');
const assert = require('node:assert/strict');
const { pedidoSolicitaPesquisa } = require('../src/services/pesquisaIntent');
test('reconhece pedidos imperativos e atuais de pesquisa', () => {
  for (const pedido of ['busque livremente', 'busque vc no claude', 'pesquise na internet', 'últimas notícias sobre igreja', 'buscar sobre o tema']) {
    assert.equal(pedidoSolicitaPesquisa(pedido), true, pedido);
  }
});
test('preserva pedidos sem pesquisa e conversa casual', () => {
  for (const pedido of ['não busque na internet', 'não pesquise', 'sem pesquisa', 'olá']) {
    assert.equal(pedidoSolicitaPesquisa(pedido), false, pedido);
  }
});
