
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

rapido
git pull --ff-only origin main
npm ci --omit=dev
npm run migrate
npm run build:css
npm run gateway:sync
pm2 restart viralizeai --update-env
pm2 save
pm2 logs viralizeai --lines 50

Abre Powershell
ssh -N -L 6080:127.0.0.1:6080 viralizeai@www.viralizeai.online

Entra no link
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote
