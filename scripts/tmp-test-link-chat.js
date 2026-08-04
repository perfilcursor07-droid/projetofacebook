// Teste rápido: link de notícia colado no chat vira fonte com veículo + texto.
require('dotenv').config();
const chat = require('../src/services/materiaChatService');

(async () => {
  const url = process.argv[2] || 'https://www.bbc.com/news/articles/cn8nvg7zllxo';
  const { fontes, falhas } = await chat.extrairFontesDeArtigos([url], {
    onPasso: (p) => console.log(`[passo:${p.kind}] ${p.texto}`),
  });
  console.log('\nFALHAS:', falhas);
  for (const f of fontes) {
    console.log('\n--- FONTE ---');
    console.log('veiculo :', f.veiculo);
    console.log('host    :', f.veiculoHost);
    console.log('titulo  :', f.titulo);
    console.log('url     :', f.url);
    console.log('trecho  :', f.trecho.length, 'chars');
    console.log(f.trecho.slice(0, 600));
  }
  const materiaIa = require('../src/services/materiaIaService');
  console.log('\n=== BLOCO DE FATOS ENVIADO AO MODELO ===');
  console.log(materiaIa.montarBlocoFatos(fontes).slice(0, 900));
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
