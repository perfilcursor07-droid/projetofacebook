const test = require('node:test');
const assert = require('node:assert/strict');

const { escolherImagemDoPostFacebook } = require('../src/services/socialPostExtract');

test('extrai url de imagem nos campos atuais url/src do Facebook', () => {
  const mensagem = 'M'.repeat(200);
  const imagem =
    'https:\\/\\/scontent-gru2-2.xx.fbcdn.net\\/v\\/t39.30808-6\\/foto.jpg?ccb=1\\u0026_nc_sid=abc';
  const html = [
    mensagem,
    '"media":{"preferred_thumbnail":{"width":1080,"height":1350,',
    `"url":"${imagem}"}}}`,
  ].join('');

  const result = escolherImagemDoPostFacebook(html, { indice: 20 });

  assert.equal(
    result,
    'https://scontent-gru2-2.xx.fbcdn.net/v/t39.30808-6/foto.jpg?ccb=1&_nc_sid=abc'
  );
});

test('ignora avatar pequeno e escolhe a foto editorial do mesmo post', () => {
  const avatar =
    '"image":{"width":50,"height":50,"uri":"https:\\/\\/scontent.xx.fbcdn.net\\/p50x50\\/avatar.jpg"}';
  const foto =
    '"preview_image":{"width":1200,"height":900,"src":"https:\\/\\/external-gru2-2.xx.fbcdn.net\\/foto-materia.jpg"}';
  const html = `${avatar}${'X'.repeat(700)}MENSAGEM DO POST${'Y'.repeat(500)}${foto}`;

  const result = escolherImagemDoPostFacebook(html, {
    indice: html.indexOf('MENSAGEM DO POST'),
  });

  assert.equal(result, 'https://external-gru2-2.xx.fbcdn.net/foto-materia.jpg');
});

test('aceita imagem do lookaside fbsbx usada em preview compartilhado', () => {
  const html =
    'POST' +
    '"attachments":{"media":{"image":{"uri":' +
    '"https:\\/\\/lookaside.fbsbx.com\\/lookaside\\/crawler\\/media.jpg"}}}';

  assert.equal(
    escolherImagemDoPostFacebook(html, { indice: 0 }),
    'https://lookaside.fbsbx.com/lookaside/crawler/media.jpg'
  );
});
