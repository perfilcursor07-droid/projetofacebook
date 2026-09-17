const test = require('node:test');
const assert = require('node:assert/strict');
const { extrairImagemCapa } = require('../src/services/articleSource');

test('capa usa foto lazy em vez de placeholder', () => {
  const html = '<article><img class="wp-post-image" src="/placeholder.gif" data-lazy-src="/foto.jpg"></article>';
  assert.equal(extrairImagemCapa(html, 'https://noticias.test/post'), 'https://noticias.test/foto.jpg');
});

test('capa seleciona maior variante responsiva', () => {
  const html = '<article><img class="wp-post-image" src="/pequena.jpg" srcset="/pequena.jpg 300w, /grande.jpg 1200w"></article>';
  assert.equal(extrairImagemCapa(html, 'https://noticias.test/post'), 'https://noticias.test/grande.jpg');
});

test('capa preserva prioridade do Open Graph editorial', () => {
  const html = '<meta property="og:image" content="https://noticias.test/capa.jpg"><article><img src="/outra.jpg" width="1200" height="800"></article>';
  assert.equal(extrairImagemCapa(html, 'https://noticias.test/post'), 'https://noticias.test/capa.jpg');
});
