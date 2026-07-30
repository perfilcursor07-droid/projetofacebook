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

  const { consultas, tema } = await deepseekService.sugerirConsultasPesquisa({ pedido });
  console.log('Tema:', tema);
  console.log('Consultas:', consultas, '\n');

  const fontes = await materiaIaService.coletarFatosNaWeb({
    consultas,
    periodo: '30d',
    max: 6,
    logPrefix: '[teste]',
  });
  console.log('Fontes encontradas:', fontes.length);
  for (const f of fontes) console.log(' -', f.veiculo, '|', f.titulo, '|', f.url);
  console.log('');

  const bloco = fontes
    .map(
      (f, i) =>
        `Fonte ${i + 1} — ${f.veiculo}${f.url ? ` (${f.url})` : ''}\nTítulo: ${f.titulo}\nTrecho factual:\n${String(f.trecho || '').slice(0, 1800)}`
    )
    .join('\n\n---\n\n');

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
