const test = require('node:test');
const assert = require('node:assert/strict');
const { respostaAdmitePeriodoNaoAtendido, selecionarFontesRespostaLivre } = require('../src/services/materiaChatService');

test('não aceita substituição declarada de período explícito', () => {
  assert.equal(respostaAdmitePeriodoNaoAtendido('polêmica de 15 a 16 de setembro', 'Não localizei um fato novo e específico datado de 15-16/09. Vou usar o desdobramento mais próximo da data.'), true);
  assert.equal(respostaAdmitePeriodoNaoAtendido('polêmica de 15 a 16 de setembro', 'No dia 16 de setembro houve uma declaração.'), false);
});

test('Diário Carioca não recebe link do Diário do Poder', () => {
  const fontes = selecionarFontesRespostaLivre('Malafaia e Alexandre de Moraes no STF\n\nFonte: Diário Carioca', {
    fontesWeb: [{ veiculo: 'Diário do Poder', titulo: 'Malafaia questiona Alexandre de Moraes no STF', url: 'https://diariodopoder.com.br/malafaia-moraes-stf' }],
  });
  assert.equal(fontes[0].url, '');
});
