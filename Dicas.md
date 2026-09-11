
-- Local
git pull
npm install
npm run migrate
npm run seed
npm run build:css
npm run dev

-- Produção CloudPanel (www.viralizeai.online) — NÃO use root
su - viralizeai
cd /home/viralizeai/htdocs/www.viralizeai.online
git pull --ff-only origin main
npm ci --omit=dev
npm run migrate
npm run build:css
npm run gateway:sync
pm2 startOrReload ecosystem.config.cjs --only viralizeai --update-env
pm2 save
pm2 status viralizeai
pm2 logs viralizeai --lines 50

SUBIR GIT

git add .
git commit -m "feat: sua mensagem aqui"
git push origin main

rapido - CORRETO PARA NAO DAR ERRO 3010
su - viralizeai -c 'export PATH=/home/viralizeai/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin; cd /home/viralizeai/htdocs/www.viralizeai.online && git pull --ff-only origin main && npm ci --omit=dev && npm run migrate && npm run build:css && npm run gateway:sync && node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 startOrReload ecosystem.config.cjs --only viralizeai --update-env && node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 save && node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 status viralizeai && curl -fsS http://127.0.0.1:3010/health'

Abre Powershell
ssh -N -L 6080:127.0.0.1:6080 viralizeai@www.viralizeai.online

Entra no link
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote


erro porta 310
pm2 delete viralizeai
pm2 save

su - viralizeai
cd /home/viralizeai/htdocs/www.viralizeai.online

pm2 restart viralizeai --update-env || pm2 start ecosystem.config.cjs --only viralizeai --update-env
pm2 save

curl http://127.0.0.1:3010/health
pm2 logs viralizeai --lines 30 --nostream
