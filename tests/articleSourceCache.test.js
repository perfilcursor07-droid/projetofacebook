const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Servidor local: /ok devolve um artigo; /bloqueado responde 403.
function iniciarServidor() {
  const chamadas = { ok: 0, bloqueado: 0 };
  const paragrafo = '<p>' + 'Texto factual da reportagem com detalhes suficientes. '.repeat(8) + '</p>';
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ok')) {
      chamadas.ok += 1;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Artigo</title></head><body>${paragrafo.repeat(4)}</body></html>`);
      return;
    }
    chamadas.bloqueado += 1;
    res.writeHead(403);
    res.end('bloqueado');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, chamadas })));
}

test('mesmo link é lido uma vez só (memória por link)', async () => {
  const { server, chamadas } = await iniciarServidor();
  const { extrairMetadadosArtigo } = require('../src/services/articleSource');
  const url = `http://127.0.0.1:${server.address().port}/ok/materia-1`;
  try {
    const [a, b] = await Promise.all([extrairMetadadosArtigo(url), extrairMetadadosArtigo(url)]);
    const c = await extrairMetadadosArtigo(url);
    assert.ok(String(a?.trecho || '').length > 200);
    assert.equal(b, a);
    assert.equal(c, a);
    assert.equal(chamadas.ok, 1);
  } finally {
    server.close();
  }
});
