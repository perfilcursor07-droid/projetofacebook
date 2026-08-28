const test = require('node:test');
const assert = require('node:assert/strict');

const {
  truncateForTwitter,
  twitterWeightedLength,
} = require('../src/services/ayrshareService');

test('legenda do X nunca ultrapassa o peso 280', () => {
  const input = 'A'.repeat(400);
  const output = truncateForTwitter(input);

  assert.equal(output.endsWith('...'), true);
  assert.equal(twitterWeightedLength(output), 280);
});

test('reticencias Unicode pesam 2 e nao causam mais o overage de 1', () => {
  const formatoAntigo = `${'A'.repeat(279)}…`;
  const output = truncateForTwitter(formatoAntigo);

  assert.equal(twitterWeightedLength(formatoAntigo), 281);
  assert.ok(twitterWeightedLength(output) <= 280);
});

test('emoji tem peso 2 e URL inteira usa o peso encurtado do X', () => {
  assert.equal(twitterWeightedLength('Notícia 🔥'), 10);
  assert.equal(
    twitterWeightedLength('Leia https://www.viralizeai.online/materia/123456789'),
    28
  );
});

test('corte nao parte URL', () => {
  const url = 'https://www.viralizeai.online/materia/uma-url-muito-grande';
  const output = truncateForTwitter(`${'A'.repeat(260)} ${url}`);

  assert.equal(output.includes('https://'), false);
  assert.ok(twitterWeightedLength(output) <= 280);
});
