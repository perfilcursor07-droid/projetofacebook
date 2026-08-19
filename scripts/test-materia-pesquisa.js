/**
 * Teste manual do fluxo "matéria manual com pesquisa na web" (sem gravar no banco).
 * Uso: node scripts/test-materia-pesquisa.js "faça uma matéria sobre ..."
 */
require('dotenv').config();

const materiaIaService = require('../src/services/materiaIaService');
const deepseekService = require('../src/services/deepseekService');

async function main() {
  const inicio = Date.now();
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
    incluirRedes: false,
    maxConsultasNoticias: 2,
    logPrefix: '[teste]',
  });
  console.log('Fontes encontradas:', fontes.length);
  for (const f of fontes) console.log(' -', f.veiculo, '|', f.titulo, '|', f.url);
  console.log('');

  let bloco = materiaIaService.montarBlocoFatos(fontes);
  let checagem = bloco
    ? await deepseekService.checarPedidoNasFontes({ pedido, fatosFontes: bloco })
    : null;
  if (checagem?.tipoPedido === 'fato' && checagem.confirmado === false) {
    console.log('\nBusca complementar:', consultas.slice(0, 2));
    const extras = await materiaIaService.coletarFatosNaWeb({
      consultas: consultas.slice(0, 2),
      periodo: '90d',
      max: 7,
      incluirRedes: false,
      maxConsultasNoticias: 2,
      incluirWebGeral: true,
      logPrefix: '[teste:resgate]',
    });
    const urls = new Set(fontes.map((f) => f.url).filter(Boolean));
    fontes = fontes.concat(extras.filter((f) => !f.url || !urls.has(f.url)));
    bloco = materiaIaService.montarBlocoFatos(fontes);
    checagem = await deepseekService.checarPedidoNasFontes({ pedido, fatosFontes: bloco });
  }
  console.log('\nChecagem:', checagem);
  if (checagem?.tipoPedido === 'fato' && checagem.confirmado === false) {
    console.log('\nFato central não confirmado; produção interromperia a redação aqui.');
    return;
  }

  const materia = await deepseekService.conversarMateria({
    pedido,
    fatosFontes: bloco || null,
    tom: 'natural',
    periodoPesquisa: '30d',
    pesquisaAmpliada: true,
    periodoPesquisaAmpliada: '90d',
  });

  console.log('\nMATÉRIA:\n', materia);
  console.log(`Tempo total: ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERRO:', err.response?.data || err.message);
    process.exit(1);
  });
