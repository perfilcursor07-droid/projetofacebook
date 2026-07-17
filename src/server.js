const fs = require('fs');
const path = require('path');
const app = require('./app');
const { env } = require('./config/env');
const { recoverStuckJobs } = require('./services/processingService');

const storageDirs = ['videos', 'clips', 'imagens', 'temp', 'tmp'].map((dir) =>
  path.join(env.storagePath, dir)
);

for (const dir of storageDirs) {
  fs.mkdirSync(dir, { recursive: true });
}

app.listen(env.port, async () => {
  console.log(`ViralizeAI rodando em http://localhost:${env.port}`);
  try {
    const { diagnoseInstagramCookies } = require('./services/instagramCookies');
    const ig = diagnoseInstagramCookies();
    console.log(
      `[ig-cookies] ${ig.ok ? 'OK' : 'FALHA'} — ${ig.reason}` +
        (ig.file ? ` (${ig.file}, ${ig.size || 0}b, tabs=${ig.hasTabs})` : '')
    );
  } catch (err) {
    console.warn('[ig-cookies] diagnose:', err.message);
  }
  try {
    await recoverStuckJobs();
  } catch (err) {
    console.error('[recover] falhou:', err.message);
  }

  try {
    const materiaIaService = require('./services/materiaIaService');
    const bibliotecaService = require('./services/bibliotecaService');
    const tick = async () => {
      try {
        await materiaIaService.tickMonitores();
        await materiaIaService.tickFilaJobs();
      } catch (err) {
        console.error('[materias-ia tick]', err.message);
      }
      try {
        await bibliotecaService.tickFontes();
      } catch (err) {
        console.error('[biblioteca tick]', err.message);
      }
    };
    setInterval(tick, 60_000);
    setTimeout(tick, 15_000);
  } catch (err) {
    console.error('[materias-ia] init tick falhou:', err.message);
  }
});
