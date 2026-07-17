const fs = require('fs');
const os = require('os');
const path = require('path');
const { env } = require('../config/env');

const IG_APP_ID = '936619743392459';

/**
 * Lê YTDLP_IG_COOKIES_FILE (Netscape), remove aspas e valores inválidos.
 * @returns {{ file: string, cookies: Record<string, string> } | null}
 */
function loadInstagramCookies() {
  const file = String(env.ytDlp?.igCookiesFile || '').trim();
  if (!file || !fs.existsSync(file)) return null;

  const text = fs.readFileSync(file, 'utf8');
  const cookies = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const domain = cols[0];
    const name = cols[5];
    let value = cols.slice(6).join('\t'); // valor pode conter tabs raramente
    if (!name) continue;
    if (!/instagram\.com/i.test(domain) && domain !== '.instagram.com') continue;
    value = String(value || '')
      .trim()
      .replace(/^"|"$/g, '')
      .replace(/\\054/g, ',');
    if (!value) continue;
    cookies[name] = value;
  }
  if (!cookies.sessionid) return null;
  return { file, cookies };
}

function buildInstagramCookieHeader(cookiesMap = null) {
  const loaded = cookiesMap || loadInstagramCookies()?.cookies;
  if (!loaded) return null;
  const wanted = ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'datr', 'rur'];
  const parts = [];
  for (const name of wanted) {
    if (loaded[name]) parts.push(`${name}=${loaded[name]}`);
  }
  // inclui outros cookies IG úteis se existirem
  for (const [name, value] of Object.entries(loaded)) {
    if (wanted.includes(name)) continue;
    if (/^(ps_l|ps_n|oo|ig_nrcb|wd)$/i.test(name)) parts.push(`${name}=${value}`);
  }
  return parts.length ? parts.join('; ') : null;
}

/**
 * Gera arquivo Netscape limpo (sem aspas) para o yt-dlp — evita HTTP 400 por parse quebrado.
 * @returns {string|null} caminho absoluto do arquivo limpo (ou o original se já ok)
 */
function resolveCleanInstagramCookiesFile() {
  const loaded = loadInstagramCookies();
  if (!loaded) return null;

  const raw = fs.readFileSync(loaded.file, 'utf8');
  const needsClean = /"[^\t\n]*"|\\054/.test(raw);
  if (!needsClean) return loaded.file;

  const lines = [
    '# Netscape HTTP Cookie File',
    '# sanitized for yt-dlp (ViralizeAI)',
  ];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    cols[6] = String(cols.slice(6).join('\t'))
      .trim()
      .replace(/^"|"$/g, '')
      .replace(/\\054/g, ',');
    lines.push(cols.slice(0, 7).join('\t'));
  }

  const out = path.join(os.tmpdir(), `viralizeai-ig-cookies-${process.pid}.txt`);
  fs.writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
  return out;
}

function shortcodeToMediaId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const char of String(shortcode || '')) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) return null;
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

function instagramApiHeaders(cookieHeader) {
  const csrf = loadInstagramCookies()?.cookies?.csrftoken || '';
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129477',
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://www.instagram.com/',
    Origin: 'https://www.instagram.com',
    Cookie: cookieHeader,
    ...(csrf ? { 'X-CSRFToken': csrf } : {}),
  };
}

module.exports = {
  IG_APP_ID,
  loadInstagramCookies,
  buildInstagramCookieHeader,
  resolveCleanInstagramCookiesFile,
  shortcodeToMediaId,
  instagramApiHeaders,
};
