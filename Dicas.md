
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
git pull origin main
npm install --omit=dev
npm run build:css
NODE_ENV=production npm run migrate
pm2 reload viralizeai || pm2 start ecosystem.config.cjs
pm2 save
pm2 logs viralizeai --lines 50

SUBIR GIT
git add .
git commit -m "feat: sua mensagem aqui"
git push origin main


rapido
su - viralizeai
cd /home/viralizeai/htdocs/www.viralizeai.online
git pull origin main
pm2 reload viralizeai --update-env
pm2 logs viralizeai --lines 50
