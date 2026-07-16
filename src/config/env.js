require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'mysql://root:@localhost:3306/clipador',
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  pexelsApiKey: process.env.PEXELS_API_KEY || '',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  serperApiKey: process.env.SERPER_API_KEY || '',
  facebook: {
    appId: process.env.FACEBOOK_APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    redirectUri:
      process.env.FACEBOOK_REDIRECT_URI ||
      'http://localhost:3000/api/auth/facebook/callback',
  },
  postpulse: {
    clientId: process.env.POSTPULSE_CLIENT_ID || '',
    clientSecret: process.env.POSTPULSE_CLIENT_SECRET || '',
    redirectUri:
      process.env.POSTPULSE_REDIRECT_URI ||
      'http://localhost:3000/api/auth/postpulse/callback',
    /** auto | postpulse | facebook */
    publishProvider: (process.env.PUBLISH_PROVIDER || 'auto').toLowerCase(),
  },
  ffmpegPath: process.env.FFMPEG_PATH || '',
  pythonPath: process.env.PYTHON_PATH || '',
  storagePath: process.env.STORAGE_PATH || './storage',
  ytDlp: {
    cookiesFile: process.env.YTDLP_COOKIES_FILE || '',
    cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || '',
    /** ex.: node  |  node:/usr/local/bin/node  |  deno */
    jsRuntime: process.env.YTDLP_JS_RUNTIME || '',
    /** caminho do binário node/deno (opcional) */
    jsRuntimePath: process.env.YTDLP_JS_RUNTIME_PATH || '',
  },
};

module.exports = { env, required };
