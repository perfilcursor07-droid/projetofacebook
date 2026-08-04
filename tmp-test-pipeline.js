/* eslint-disable no-console */
require('dotenv').config();

const URL_TESTE = process.argv[2] || 'https://www.bbc.com/news/articles/cn8nvg7zllxo';

(async () => {
  const chatService = require('./src/services/materiaChatService');
  const materiaIaService = require('./src/services/materiaIaService');
  const deepseekService = require('./src/services/deepseekService');
  const { montarRodapeMateriaComFontes } = require('./src/services/editorialGuidelinesFb');

  const { fontes, falhas } = await chatService.extrairFontesDeArtigos([URL_TESTE], {
    onPasso: (p) => console.log(`[passo:${p.kind}] ${p.texto}`),
  });
  console.log('falhas:', falhas);
  if (!fontes.length) process.exit(1);
  const fonte = fontes[0];
  console.log('FONTE:', { veiculo: fonte.veiculo, titulo: fonte.titulo, trechoLen: fonte.trecho.length });

  const estrangeira = chatService.fonteEmOutroIdioma(fontes);
  console.log('fonteEstrangeira:', estrangeira);

  const blocoFatos = materiaIaService.montarBlocoFatos(fontes);
  const veiculosColados = [{ veiculo: fonte.veiculo, url: fonte.url }];

  console.log('\n=== conversarMateria ===');
  let resposta = await deepseekService.conversarMateria({
    pedido: URL_TESTE,
    historico: [],
    fatosFontes: blocoFatos,
    tom: 'natural',
    veiculosColados,
    fonteEstrangeira: estrangeira,
  });
  console.log(resposta);

  console.log('\n=== interpretarResposta ===');
  const info = chatService.interpretarResposta(resposta);
  console.log({ ehMateria: info.ehMateria, titulo: info.titulo, hashtags: info.hashtags });

  console.log('\n=== revisarMateriaContraFontes ===');
  const revisao = await deepseekService.revisarMateriaContraFontes({
    texto: resposta,
    fatosFontes: blocoFatos,
    pedido: URL_TESTE,
    suspeitas: [],
    fonteEstrangeira: estrangeira,
    veiculosColados,
  });
  console.log('problemas:', revisao.problemas, '| descartada:', Boolean(revisao.revisaoDescartada));
  if (revisao.texto) resposta = revisao.texto;

  const { texto: comCredito, inserido } = chatService.garantirCitacaoDoVeiculo(resposta, fontes);
  console.log('\ncredito inserido automaticamente:', inserido);
  resposta = comCredito;

  console.log('\n=== TEXTO FINAL ===');
  console.log(resposta);

  const rodape = montarRodapeMateriaComFontes({ materia: resposta, fontes, creditoImagem: null });
  console.log('\n=== MATERIA SALVA (rodape) ===');
  console.log(rodape.materia);
  console.log('\n--- fonte_credito ---');
  console.log(rodape.fonteCredito);
  console.log('\ncita veiculo no corpo:', /BBC/i.test(rodape.materia));
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
