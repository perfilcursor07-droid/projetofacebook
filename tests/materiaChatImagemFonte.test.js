const test = require('node:test');
const assert = require('node:assert/strict');
const { imagemDaFonte, idDoVideoYoutube } = require('../src/services/materiaChatService');

test('reconhece o ID do vídeo nos formatos de link do YouTube', () => {
  assert.equal(idDoVideoYoutube('https://www.youtube.com/watch?v=pLZxThPyDoA&pp=ugUHEgVwdC1CUtIH'), 'pLZxThPyDoA');
  assert.equal(idDoVideoYoutube('https://youtu.be/ECKHGZ076qU?si=x'), 'ECKHGZ076qU');
  assert.equal(idDoVideoYoutube('https://www.youtube.com/shorts/ECKHGZ076qU'), 'ECKHGZ076qU');
  assert.equal(idDoVideoYoutube('https://g1.globo.com/noticia'), null);
});

test('mídia do post social vem antes de qualquer outra imagem', async () => {
  const capa = await imagemDaFonte({
    fontesDaMateria: [
      { url: 'https://g1.globo.com/a', imagem: 'https://g1.globo.com/foto.jpg', veiculo: 'g1' },
      { url: 'https://instagram.com/p/x', imagem: 'https://cdn.instagram.com/post.jpg', ehRedeSocial: true, veiculo: 'Instagram' },
    ],
  });
  assert.equal(capa.url, 'https://cdn.instagram.com/post.jpg');
  assert.equal(capa.origem, 'post');
});

test('vídeo do YouTube sem thumbnail salva usa a thumb pelo ID', async () => {
  const capa = await imagemDaFonte({
    fontesDaMateria: [{ url: 'https://www.youtube.com/watch?v=pLZxThPyDoA', ehRedeSocial: true, plataforma: 'youtube', veiculo: 'Pastor Pedro Reis' }],
  });
  assert.equal(capa.url, 'https://i.ytimg.com/vi/pLZxThPyDoA/hqdefault.jpg');
  assert.equal(capa.veiculo, 'Pastor Pedro Reis');
});

test('reportagem com imagem salva usa essa imagem', async () => {
  const capa = await imagemDaFonte({
    fontesDaMateria: [{ url: 'https://oglobo.globo.com/x', imagem: 'https://oglobo.globo.com/capa.jpg', veiculo: 'O Globo' }],
  });
  assert.equal(capa.url, 'https://oglobo.globo.com/capa.jpg');
  assert.equal(capa.origem, 'fonte');
});
