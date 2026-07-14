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
  console.log(`Clipador rodando em http://localhost:${env.port}`);
  try {
    await recoverStuckJobs();
  } catch (err) {
    console.error('[recover] falhou:', err.message);
  }
});
