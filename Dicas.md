
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
# SEMPRE como viralizeai (NVM). Nunca root — PM2 do root é outro.
su - viralizeai
# ou: sudo -iu viralizeai
cd /home/viralizeai/htdocs/www.viralizeai.online
git pull origin main
npm install --omit=dev
NODE_ENV=production npm run migrate
pm2 reload viralizeai --update-env
# após mudar ecosystem.config.cjs:
# pm2 delete viralizeai && pm2 start ecosystem.config.cjs && pm2 save
pm2 logs viralizeai --lines 50

# YouTube cookies (se expirar): exportar em aba anônima + robots.txt
# YTDLP_COOKIES_FILE=/home/viralizeai/secrets/youtube-cookies.txt

# Biblioteca de fontes: /biblioteca — monitor YouTube/TikTok (yt-dlp) + IG/FB (Serper)
