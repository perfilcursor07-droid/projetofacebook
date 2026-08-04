/* eslint-disable no-console */
require('dotenv').config();

const URL_TESTE = process.argv[2] || 'https://www.bbc.com/news/articles/cn8nvg7zllxo';

(async () => {
  const { extrairMetadadosArtigo, extrairMetadadosViaJina } = require('./src/services/articleSource');

  console.log('=== extrairMetadadosArtigo ===');
  let meta = null;
  try {
    meta = await extrairMetadadosArtigo(URL_TESTE);
  } catch (err) {
    console.log('ERRO:', err.message);
  }
  console.log({
    url: meta?.url,
    titulo: meta?.titulo,
    veiculo: meta?.veiculo,
    veiculoHost: meta?.veiculoHost,
    resumoLen: (meta?.resumo || '').length,
    trechoLen: (meta?.trecho || '').length,
  });
  console.log('--- trecho (600) ---');
  console.log(String(meta?.trecho || '').slice(0, 600));

  console.log('\n=== extrairMetadadosViaJina ===');
  let j = null;
  try {
    j = await extrairMetadadosViaJina(URL_TESTE);
  } catch (err) {
    console.log('ERRO:', err.message);
  }
  console.log({
    titulo: j?.titulo,
    veiculo: j?.veiculo,
    trechoLen: (j?.trecho || '').length,
  });
  console.log('--- trecho (600) ---');
  console.log(String(j?.trecho || '').slice(0, 600));
})();
