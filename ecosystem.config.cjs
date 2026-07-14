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
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3010,
        // Garante yt-dlp/node do sistema mesmo com PATH reduzido do PM2
        PATH: '/usr/local/bin:/usr/bin:/bin:/home/viralizeai/.nvm/versions/node/v22.23.1/bin',
        YTDLP_PATH: '/usr/local/bin/yt-dlp',
        YTDLP_JS_RUNTIME: 'node:/usr/local/bin/node',
        YTDLP_COOKIES_FILE: '/home/viralizeai/secrets/youtube-cookies.txt',
      },
      error_file: '/home/viralizeai/logs/viralizeai-error.log',
      out_file: '/home/viralizeai/logs/viralizeai-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
