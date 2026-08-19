/**
 * Teste manual do fluxo "matéria manual com pesquisa na web" (sem gravar no banco).
 * Uso: node scripts/test-materia-pesquisa.js "faça uma matéria sobre ..."
 */
require('dotenv').config();

const materiaIaService = require('../src/services/materiaIaService');
const deepseekService = require('../src/services/deepseekService');

async function main() {
  const pedido =
    process.argv[2] ||
    'faça uma materia de catolicos e evangelicos juntos para politica 2026 flavio';

  console.log('Pedido:', pedido, '\n');

  const sugestao = await deepseekService.sugerirConsultasPesquisa({ pedido });
  let consultas = [...sugestao.consultas];
  const tema = sugestao.tema;
  if (/\bmalafaia\b/i.test(pedido) && /\bvot/i.test(pedido) && /\besquerd/i.test(pedido)) {
    consultas = [
      'Silas Malafaia cristãos evangélicos votam esquerda',
      ...consultas.filter((consulta) => !/crist[aã]os evang[eé]licos votam esquerda/i.test(consulta)),
    ].slice(0, 6);
  }
  console.log('Tema:', tema);
  console.log('Consultas:', consultas, '\n');

  let fontes = await materiaIaService.coletarFatosNaWeb({
    consultas,
    periodo: '30d',
    max: 6,
    logPrefix: '[teste]',
  });
  console.log('Fontes encontradas:', fontes.length);
  for (const f of fontes) console.log(' -', f.veiculo, '|', f.titulo, '|', f.url);
  console.log('');

  let bloco = materiaIaService.montarBlocoFatos(fontes);
  let dossie = bloco
    ? await deepseekService.montarDossieApuracao({ pedido, fatosFontes: bloco })
    : null;
  if (
    dossie?.tipoPedido === 'fato' &&
    dossie.confirmado === false &&
    dossie.consultasComplementares?.length
  ) {
    const consultasResgate = [...consultas, ...dossie.consultasComplementares]
      .filter((consulta, indice, lista) => lista.indexOf(consulta) === indice)
      .slice(0, 6);
    console.log('\nBusca complementar:', consultasResgate);
    const extras = await materiaIaService.coletarFatosNaWeb({
      consultas: consultasResgate,
      periodo: '180d',
      max: 8,
      incluirWebGeral: true,
      logPrefix: '[teste:resgate]',
    });
    const urls = new Set(fontes.map((f) => f.url).filter(Boolean));
    fontes = fontes.concat(extras.filter((f) => !f.url || !urls.has(f.url)));
    bloco = materiaIaService.montarBlocoFatos(fontes);
    dossie = await deepseekService.montarDossieApuracao({ pedido, fatosFontes: bloco });
  }
  console.log('\nDossiê:', dossie);
  if (dossie?.texto) {
    bloco = `DOSSIÊ EDITORIAL:\n${dossie.texto}\n\n--- FONTES ORIGINAIS ---\n\n${bloco}`;
  }
  if (dossie?.tipoPedido === 'fato' && dossie.confirmado === false) {
    console.log('\nFato central não confirmado; produção interromperia a redação aqui.');
    return;
  }

  const artigo = await deepseekService.gerarMateriaComPesquisa({
    pedido,
    fatosFontes: bloco || null,
    tom: 'natural',
  });

  console.log('TÍTULO:', artigo.titulo);
  console.log('\nMATÉRIA:\n', artigo.materia);
  console.log('\nFatos usados:', artigo.fatosUsados);
  console.log('Aviso:', artigo.aviso);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERRO:', err.response?.data || err.message);
    process.exit(1);
  });
