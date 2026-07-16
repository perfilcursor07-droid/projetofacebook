/**
 * PM2 — ViralizeAI / CloudPanel
 * App port: 3010 (Node.js Settings no painel)
 *
 * Uso (como usuário do site, NÃO root):
 *   su - viralizeai
 *   cd /home/viralizeai/htdocs/www.viralizeai.online
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   # se o painel pedir, rode o comando que ele mostrar (como root)
 */
module.exports = {
  apps: [
    {
      name: 'viralizeai',
      script: 'src/server.js',
      cwd: '/home/viralizeai/htdocs/www.viralizeai.online',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Geração de matérias/capa (sharp) pode passar de 512MB e o restart
      // derrubava a sessão em memória — login “sumia” no meio do lote.
      max_memory_restart: '1024M',
      env: {
        NODE_ENV: 'production',
        PORT: 3010,
        // Garante yt-dlp/node do sistema mesmo com PATH reduzido do PM2.
        // NVM do viralizeai vem PRIMEIRO: /usr/local/bin/node é symlink para o
        // NVM de outro usuário (sem permissão) e quebra o desafio JS do YouTube.
        PATH: '/home/viralizeai/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin',
        YTDLP_PATH: '/usr/local/bin/yt-dlp',
        YTDLP_JS_RUNTIME: 'node',
        YTDLP_COOKIES_FILE: '/home/viralizeai/secrets/youtube-cookies.txt',
      },
      error_file: '/home/viralizeai/logs/viralizeai-error.log',
      out_file: '/home/viralizeai/logs/viralizeai-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
