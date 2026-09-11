
-- Local
git pull
npm install
npm run migrate
npm run seed
npm run build:css
npm run dev

PRODUÇÃO
export PATH=/home/viralizeai/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin
cd /home/viralizeai/htdocs/www.viralizeai.online
git pull --ff-only origin main
npm ci --omit=dev
npm run migrate
npm run build:css
npm run gateway:sync
node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 startOrReload ecosystem.config.cjs --only viralizeai --update-env
node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 save
node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 status viralizeai
curl -fsS http://127.0.0.1:3010/health
node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 logs viralizeai --lines 50

RAPIDO
su - viralizeai -c 'export PATH=/home/viralizeai/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin; cd /home/viralizeai/htdocs/www.viralizeai.online && git pull --ff-only origin main && npm ci --omit=dev && npm run migrate && npm run build:css && npm run gateway:sync && node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 startOrReload ecosystem.config.cjs --only viralizeai --update-env && node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 save && node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 status viralizeai && curl -fsS http://127.0.0.1:3010/health'


SUBIR GIT
git add .
git commit -m "feat: sua mensagem aqui"
git push origin main


Abre Powershell
ssh -N -L 6080:127.0.0.1:6080 viralizeai@www.viralizeai.online

Entra no link
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote



DER ERRO PORTA 3010
cd /home/viralizeai/htdocs/www.viralizeai.online
pm2 delete viralizeai || true
pm2 save
chown -R viralizeai:viralizeai /home/viralizeai/htdocs/www.viralizeai.online
chown -R viralizeai:viralizeai /home/viralizeai/.npm /home/viralizeai/.pm2
ss -ltnp 'sport = :3010'