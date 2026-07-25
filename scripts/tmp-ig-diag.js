/* Diagnóstico temporário da busca IG do /viralizar. */
require('dotenv').config();
const s = require('../src/services/scrapeCreatorsSearch');
const v = require('../src/services/viralizarService');

(async () => {
  const seeds = v.PERFIL_VIRAL.seedsInstagram.slice(0, 4);
  const r = await s.buscarReelsPorQueries(seeds, { datePosted: 'last-week', limit: 8 });
  const classificados = r.topicos.map((t) => ({ ...t, ...v.classificarTopico(t) }));
  const noNicho = classificados.filter((x) => x.nichoGospel);
  const fora = classificados.filter((x) => !x.nichoGospel);
  console.log(
    JSON.stringify(
      {
        seeds,
        totalIg: r.topicos.length,
        noNicho: noNicho.length,
        foraNicho: fora.length,
        avisos: r.avisos.slice(0, 4),
        exemplosNoNicho: noNicho.slice(0, 3).map((x) => x.titulo.slice(0, 60)),
        exemplosFora: fora.slice(0, 5).map((x) => x.titulo.slice(0, 60)),
      },
      null,
      1
    )
  );
  process.exit(0);
})().catch((e) => {
  console.error('falhou:', e.message);
  process.exit(1);
});
