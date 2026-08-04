/* eslint-disable no-console */
require('dotenv').config();

const URL_TESTE = process.argv[2] || 'https://www.bbc.com/news/articles/cn8nvg7zllxo';

(async () => {
  const { extrairMetadadosArtigo } = require('./src/services/articleSource');
  const materiaIaService = require('./src/services/materiaIaService');
  const deepseekService = require('./src/services/deepseekService');
  const { montarRodapeMateriaComFontes } = require('./src/services/editorialGuidelinesFb');

  const meta = await extrairMetadadosArtigo(URL_TESTE);
  const fonte = {
    veiculo: meta.veiculo || meta.veiculoHost,
    veiculoHost: meta.veiculoHost,
    titulo: meta.titulo,
    url: meta.url,
    resumo: (meta.resumo || '').slice(0, 400),
    trecho: (meta.trecho || '').slice(0, 9000),
    fonteColada: true,
  };
  console.log('FONTE:', { veiculo: fonte.veiculo, titulo: fonte.titulo, trechoLen: fonte.trecho.length });

  const blocoFatos = materiaIaService.montarBlocoFatos([fonte]);
  console.log('\nblocoFatos len:', blocoFatos.length);
  console.log(blocoFatos.slice(0, 400));

  console.log('\n=== checarPedidoNasFontes ===');
  const checagem = await deepseekService.checarPedidoNasFontes({ pedido: URL_TESTE, fatosFontes: blocoFatos });
  console.log(checagem);

  console.log('\n=== conversarMateria ===');
  const raw = await deepseekService.conversarMateria({
    pedido: URL_TESTE,
    historico: [],
    fatosFontes: blocoFatos,
    tom: 'natural',
  });
  console.log(raw);

  console.log('\n=== rodape ===');
  const rodape = montarRodapeMateriaComFontes({ materia: raw, fontes: [fonte], creditoImagem: null });
  console.log('--- materia final ---');
  console.log(rodape.materia.slice(-600));
  console.log('--- fonteCredito ---');
  console.log(rodape.fonteCredito);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
