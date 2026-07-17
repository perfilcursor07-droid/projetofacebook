const fs = require('fs');
const os = require('os');
const path = require('path');
const { env } = require('../config/env');

const IG_APP_ID = '936619743392459';
const DEFAULT_IG_COOKIES = '/home/viralizeai/secrets/instagram-cookies.txt';

function resolveIgCookiesPath() {
  const configured = String(env.ytDlp?.igCookiesFile || '').trim();
  if (configured) return configured;
  if (fs.existsSync(DEFAULT_IG_COOKIES)) return DEFAULT_IG_COOKIES;
  return '';
}

/**
 * Parseia linha Netscape (tabs) ou fallback com espaços (File Manager às vezes troca tab).
 */
function parseNetscapeLine(line) {
  if (!line || line.startsWith('#')) return null;
  let cols;
  if (line.includes('\t')) {
    cols = line.split('\t');
  } else {
    // domain flag path secure expiry name value...
    const m = line.match(
      /^(\S+)\s+(TRUE|FALSE)\s+(\S+)\s+(TRUE|FALSE)\s+(\d+)\s+(\S+)\s+(.+)$/i
    );
    if (!m) return null;
    cols = [m[1], m[2], m[3], m[4], m[5], m[6], m[7]];
  }
  if (cols.length < 7) return null;
  const domain = cols[0];
  const name = cols[5];
  let value = cols.slice(6).join('\t').trim();
  value = value.replace(/^"|"$/g, '').replace(/\\054/g, ',');
  if (!name || !value) return null;
  if (!/instagram\.com/i.test(domain) && domain !== '.instagram.com') return null;
  return { domain, name, value };
}

/**
 * @returns {{ file: string, cookies: Record<string, string>, names: string[] } | null}
 */
function loadInstagramCookies() {
  const file = resolveIgCookiesPath();
  if (!file) return null;
  if (!fs.existsSync(file)) return null;

  const text = fs.readFileSync(file, 'utf8');
  const cookies = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseNetscapeLine(line);
    if (!parsed) continue;
    cookies[parsed.name] = parsed.value;
  }
  if (!cookies.sessionid) return null;
  return { file, cookies, names: Object.keys(cookies) };
}

function diagnoseInstagramCookies() {
  const file = resolveIgCookiesPath();
  if (!file) {
    return { ok: false, reason: 'YTDLP_IG_COOKIES_FILE não configurado' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `arquivo não existe: ${file}`, file };
  }
  const stat = fs.statSync(file);
  const text = fs.readFileSync(file, 'utf8');
  const hasTabs = text.includes('\t');
  const hasSession = /(?:^|\t|\s)sessionid(?:\t|\s)/m.test(text);
  const loaded = loadInstagramCookies();
  return {
    ok: Boolean(loaded?.cookies?.sessionid),
    file,
    size: stat.size,
    hasTabs,
    hasSessionLine: hasSession,
    parsedNames: loaded?.names || [],
    reason: loaded?.cookies?.sessionid
      ? 'ok'
      : hasSession
        ? 'sessionid na linha mas parse falhou (formato?)'
        : 'sessionid ausente no arquivo',
  };
}

function buildInstagramCookieHeader(cookiesMap = null) {
  const loaded = cookiesMap || loadInstagramCookies()?.cookies;
  if (!loaded) return null;
  const wanted = ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'datr', 'rur'];
  const parts = [];
  for (const name of wanted) {
    if (loaded[name]) parts.push(`${name}=${loaded[name]}`);
  }
  for (const [name, value] of Object.entries(loaded)) {
    if (wanted.includes(name)) continue;
    if (/^(ps_l|ps_n|oo|ig_nrcb|wd)$/i.test(name)) parts.push(`${name}=${value}`);
  }
  return parts.length ? parts.join('; ') : null;
}

function resolveCleanInstagramCookiesFile() {
  const loaded = loadInstagramCookies();
  if (!loaded) return null;

  const raw = fs.readFileSync(loaded.file, 'utf8');
  const needsClean = /"[^\t\n]*"|\\054/.test(raw) || !raw.includes('\t');

  const lines = ['# Netscape HTTP Cookie File', '# sanitized for yt-dlp (ViralizeAI)'];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseNetscapeLine(line);
    if (!parsed) continue;
    // Netscape: domain, includeSubdomains, path, secure, expiry, name, value
    lines.push(
      [parsed.domain, 'TRUE', '/', 'TRUE', '0', parsed.name, parsed.value].join('\t')
    );
  }
  if (lines.length < 3) return null;

  if (!needsClean && raw.includes('\t')) return loaded.file;

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

function instagramApiHeaders(cookieHeader, { mobile = false } = {}) {
  const csrf = loadInstagramCookies()?.cookies?.csrftoken || '';
  const ua = mobile
    ? 'Instagram 192.168.2.4.117 Android (33/13; 420dpi; 1080x2400; Xiaomi; M2101K6G; sweet; qcom; pt_BR; 458229257)'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  return {
    'User-Agent': ua,
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
  DEFAULT_IG_COOKIES,
  resolveIgCookiesPath,
  loadInstagramCookies,
  diagnoseInstagramCookies,
  buildInstagramCookieHeader,
  resolveCleanInstagramCookiesFile,
  shortcodeToMediaId,
  instagramApiHeaders,
};
