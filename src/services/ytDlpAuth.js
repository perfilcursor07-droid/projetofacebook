const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const ALLOWED_BROWSERS = new Set(['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi']);

function isInside(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function getYtDlpAuthFlags() {
  const configuredFile = String(env.ytDlp.cookiesFile || '').trim();
  if (configuredFile) {
    if (!path.isAbsolute(configuredFile)) throw configError('YTDLP_COOKIES_FILE deve usar um caminho absoluto.');
    let realPath;
    try { realPath = fs.realpathSync(configuredFile); } catch { throw configError('Arquivo de autenticação do YouTube não encontrado.'); }
    const stat = fs.statSync(realPath);
    const publicRoot = path.resolve(__dirname, '../../public');
    const storageRoot = path.resolve(env.storagePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 5 * 1024 * 1024 || path.extname(realPath).toLowerCase() !== '.txt') {
      throw configError('Arquivo de autenticação do YouTube inválido.');
    }
    if (isInside(publicRoot, realPath) || isInside(storageRoot, realPath)) {
      throw configError('O arquivo de cookies do YouTube deve ficar fora das pastas public e storage.');
    }
    return { cookies: realPath };
  }

  const browser = String(env.ytDlp.cookiesFromBrowser || '').trim().toLowerCase();
  if (!browser) return {};
  if (env.nodeEnv === 'production') throw configError('Cookies do navegador não são permitidos em produção; configure YTDLP_COOKIES_FILE.');
  if (!ALLOWED_BROWSERS.has(browser)) throw configError('Navegador inválido em YTDLP_COOKIES_FROM_BROWSER.');
  return { cookiesFromBrowser: browser };
}

function runYtDlp(executable, url, flags = {}) {
  const auth = getYtDlpAuthFlags();
  return executable(url, { ...auth, ...flags }).catch((error) => {
    const raw = String(error?.stderr || error?.message || '').toLowerCase();
    if (raw.includes('sign in') || raw.includes('not a bot') || raw.includes('confirm you')) {
      const message = Object.keys(auth).length
        ? 'A sessão usada para acessar o YouTube expirou. Atualize os cookies e tente novamente.'
        : 'O YouTube solicitou autenticação. Configure YTDLP_COOKIES_FROM_BROWSER no ambiente local ou YTDLP_COOKIES_FILE no servidor.';
      error.message = message;
      error.stderr = message;
    }
    throw error;
  });
}

module.exports = { getYtDlpAuthFlags, runYtDlp };