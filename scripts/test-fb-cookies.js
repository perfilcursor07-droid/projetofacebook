#!/usr/bin/env node
/**
 * Diagnóstico Facebook no servidor (não imprime c_user/xs nem valores de cookies).
 *
 * Uso (como viralizeai):
 *   cd /home/viralizeai/htdocs/www.viralizeai.online
 *   node scripts/test-fb-cookies.js
 *   node scripts/test-fb-cookies.js "https://www.facebook.com/share/p/19RfJ2i6bj/"
 */
require('dotenv').config();

const axios = require('axios');
const {
  diagnoseFacebookCookies,
  buildFacebookCookieHeader,
  facebookHtmlHeaders,
  validateFacebookSession,
} = require('../src/services/facebookCookies');
const {
  extrairPostSocial,
  normalizarUrlSocial,
  resolverShareFacebook,
} = require('../src/services/socialPostExtract');

const DEFAULT_URL = 'https://www.facebook.com/facebook';

async function probeEndpoint(label, url, headers) {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers,
      validateStatus: () => true,
      maxRedirects: 5,
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
    const finalUrl = String(
      res.request?.res?.responseURL || res.request?.res?.responseUrl || ''
    );
    console.log(`  [${label}]`, {
      status: res.status,
      len: body.length,
      redirectLogin: /\/login|\/checkpoint/i.test(finalUrl),
      hasMessage: /"message"\s*:\s*\{\s*"text"/.test(body),
      hasOg: /og:description/i.test(body),
      hasLoginWall: /\/login\/\?next|entre no facebook/i.test(body.slice(0, 8000)),
    });
  } catch (err) {
    console.log(`  [${label}] ERROR`, err.message);
  }
}

(async () => {
  const alvo = process.argv[2] || DEFAULT_URL;
  console.log('=== Diagnóstico Facebook cookies ===');

  const diag = diagnoseFacebookCookies();
  console.log('Cookies:', {
    ok: diag.ok,
    reason: diag.reason,
    file: diag.file,
    size: diag.size,
    hasTabs: diag.hasTabs,
    hasSessionLine: diag.hasSessionLine,
    parsedNames: diag.parsedNames,
  });

  if (!diag.ok) {
    console.log(
      'FAIL: exporte os cookies Netscape do Facebook (precisa de c_user e xs) e aponte YTDLP_FB_COOKIES_FILE para o arquivo.'
    );
    process.exit(2);
  }

  const remoteSession = await validateFacebookSession(axios);
  console.log('Sessão remota:', remoteSession);

  const url = await resolverShareFacebook(normalizarUrlSocial(alvo));
  console.log('URL resolvida:', url);

  const cookieHeader = buildFacebookCookieHeader();
  console.log('Probes (status only):');
  await probeEndpoint('post-www+cookie', url, facebookHtmlHeaders(cookieHeader));
  await probeEndpoint('post-www-sem-cookie', url, facebookHtmlHeaders(null));
  await probeEndpoint(
    'post-mbasic+cookie',
    url.replace('www.facebook.com', 'mbasic.facebook.com'),
    facebookHtmlHeaders(cookieHeader)
  );

  console.log('extrairPostSocial:');
  try {
    const r = await extrairPostSocial(url);
    console.log({
      ok: true,
      metodo: r.metodo,
      veiculo: r.veiculo,
      textoLen: r.texto?.length || 0,
      textoPreview: String(r.texto || '').slice(0, 80),
      hasImagem: Boolean(r.imagem),
    });
    process.exit(remoteSession.ok ? 0 : 3);
  } catch (err) {
    console.log({ ok: false, error: err.message, code: err.code });
    process.exit(1);
  }
})().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
