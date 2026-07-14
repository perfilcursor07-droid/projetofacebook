
-- Servidor Produção (NÃO use root — use o usuário do site)
su - obuxixogospel
cd /home/obuxixogospel/htdocs/www.obuxixogospel.com.br
git pull origin feature/portal-globo
NODE_ENV=production npm run db:migrate
pm2 reload all
pm2 logs --lines 50

Servidor Local Baixar
git pull origin feature/portal-globo
npm install
npm run migrate
npm run seed
npm run dev

SUBIR GIT
git add .
git commit -m "feat: sua mensagem aqui"
git push origin
