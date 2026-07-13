const fs = require('fs');
const path = require('path');
const app = require('./app');
const { env } = require('./config/env');

const storageDirs = ['videos', 'clips', 'imagens', 'temp'].map((dir) =>
  path.join(env.storagePath, dir)
);

for (const dir of storageDirs) {
  fs.mkdirSync(dir, { recursive: true });
}

app.listen(env.port, () => {
  console.log(`Clipador rodando em http://localhost:${env.port}`);
});
