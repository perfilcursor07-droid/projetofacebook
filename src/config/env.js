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
  ffmpegPath: process.env.FFMPEG_PATH || '',
  pythonPath: process.env.PYTHON_PATH || '',
  storagePath: process.env.STORAGE_PATH || './storage',
};

module.exports = { env, required };
