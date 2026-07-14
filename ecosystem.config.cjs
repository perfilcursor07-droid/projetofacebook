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
      },
      error_file: '/home/viralizeai/logs/viralizeai-error.log',
      out_file: '/home/viralizeai/logs/viralizeai-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
