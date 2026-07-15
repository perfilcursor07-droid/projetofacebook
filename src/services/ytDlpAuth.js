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

function resolveNodeBinary() {
  const configured = String(env.ytDlp.jsRuntimePath || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  // process.execPath = node que está rodando o app (NVM do usuário do site).
  // Evita /usr/local/bin/node, que pode ser symlink para home de outro usuário
  // sem permissão de leitura — isso quebra o desafio JS do YouTube.
  return process.execPath || 'node';
}

function getYtDlpAuthFlags() {
  const configuredFile = String(env.ytDlp.cookiesFile || '').trim();
  if (configuredFile) {
    if (!path.isAbsolute(configuredFile)) {
      throw configError('YTDLP_COOKIES_FILE deve usar um caminho absoluto.');
    }
    let realPath;
    try {
      realPath = fs.realpathSync(configuredFile);
    } catch {
      throw configError('Arquivo de autenticação do YouTube não encontrado.');
    }
    const stat = fs.statSync(realPath);
    const publicRoot = path.resolve(__dirname, '../../public');
    const storageRoot = path.resolve(env.storagePath);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 5 * 1024 * 1024 ||
      path.extname(realPath).toLowerCase() !== '.txt'
    ) {
      throw configError('Arquivo de autenticação do YouTube inválido.');
    }
    if (isInside(publicRoot, realPath) || isInside(storageRoot, realPath)) {
      throw configError('O arquivo de cookies do YouTube deve ficar fora das pastas public e storage.');
    }
    return { cookies: realPath };
  }

  const browser = String(env.ytDlp.cookiesFromBrowser || '').trim().toLowerCase();
  if (!browser) return {};
  if (env.nodeEnv === 'production') {
    throw configError('Cookies do navegador não são permitidos em produção; configure YTDLP_COOKIES_FILE.');
  }
  if (!ALLOWED_BROWSERS.has(browser)) {
    throw configError('Navegador inválido em YTDLP_COOKIES_FROM_BROWSER.');
  }
  return { cookiesFromBrowser: browser };
}

/**
 * Flags comuns para YouTube em 2026.
 * Deno é o default do yt-dlp; em produção costuma faltar — habilitamos Node.
 * @see https://github.com/yt-dlp/yt-dlp/wiki/EJS
 */
function getYtDlpBaseFlags() {
  const nodePath = resolveNodeBinary();
  const jsRuntime = String(env.ytDlp.jsRuntime || `node:${nodePath}`).trim();

  return {
    noJsRuntimes: true,
    jsRuntimes: jsRuntime,
    retries: 3,
    socketTimeout: 30,
  };
}

function runYtDlp(executable, url, flags = {}) {
  const auth = getYtDlpAuthFlags();
  const base = getYtDlpBaseFlags();
  const merged = { ...base, ...auth, ...flags };

  if (flags.jsRuntimes && !Object.prototype.hasOwnProperty.call(flags, 'noJsRuntimes')) {
    delete merged.noJsRuntimes;
  }

  return executable(url, merged).catch((error) => {
    const raw = String(error?.stderr || error?.message || '').toLowerCase();
    if (raw.includes('sign in') || raw.includes('not a bot') || raw.includes('confirm you')) {
      const message = Object.keys(auth).length
        ? 'A sessão usada para acessar o YouTube expirou. Atualize os cookies e tente novamente.'
        : 'O YouTube solicitou autenticação. Configure YTDLP_COOKIES_FROM_BROWSER no ambiente local ou YTDLP_COOKIES_FILE no servidor.';
      error.message = message;
      error.stderr = message;
    } else if (raw.includes('n challenge') || raw.includes('javascript runtime') || raw.includes('js runtime')) {
      const message =
        'YouTube bloqueou o download (desafio JS). Confirme yt-dlp do sistema e --js-runtimes node.';
      error.message = message;
      error.stderr = message;
    }
    throw error;
  });
}

module.exports = { getYtDlpAuthFlags, getYtDlpBaseFlags, resolveNodeBinary, runYtDlp };
