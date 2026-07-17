
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

# Instagram (Biblioteca + /conteudo a partir de link):
# 1) Extensão "Get cookies.txt LOCALLY" no Chrome
# 2) Logado no instagram.com → exportar cookies Netscape
# 3) Salvar em /home/viralizeai/secrets/instagram-cookies.txt
# 4) chmod 600 /home/viralizeai/secrets/instagram-cookies.txt
# 5) YTDLP_IG_COOKIES_FILE já está no ecosystem.config.cjs
# 6) pm2 delete viralizeai && pm2 start ecosystem.config.cjs && pm2 save
# Obs: Meta oEmbed (#10) exige review — não funciona sem aprovação.
# Obs: posts só com FOTO costumam falhar no yt-dlp (HTTP 400); o app usa a API web com sessionid.
# Se colar o sessionid em chat/log, regenere: sair do IG no browser e exportar cookies de novo.

# Biblioteca de fontes: /biblioteca — monitor YouTube/TikTok (yt-dlp) + IG/FB (cookies/Serper)
