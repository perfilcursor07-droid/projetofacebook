#!/usr/bin/env node
/**
 * Diagnóstico Instagram no servidor (não imprime sessionid/cookies).
 *
 * Uso (como viralizeai):
 *   cd /home/viralizeai/htdocs/www.viralizeai.online
 *   node scripts/test-ig-cookies.js
 *   node scripts/test-ig-cookies.js "https://www.instagram.com/p/Da3iImZFWdl/"
 */
require('dotenv').config();

const axios = require('axios');
const {
  diagnoseInstagramCookies,
  buildInstagramCookieHeader,
  shortcodeToMediaId,
  instagramApiHeaders,
  loadInstagramCookies,
} = require('../src/services/instagramCookies');
const { extrairPostSocial, normalizarUrlSocial } = require('../src/services/socialPostExtract');

const DEFAULT_URL = 'https://www.instagram.com/p/Da3iImZFWdl/';

async function probeEndpoint(label, url, headers) {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers,
      validateStatus: () => true,
      maxRedirects: 5,
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
    const flags = {
      status: res.status,
      len: body.length,
      hasItems: /"items"\s*:/.test(body),
      hasCaption: /"caption"\s*:\s*\{/.test(body) || /"text"\s*:\s*"/.test(body),
      hasOg: /og:description/i.test(body),
      hasEmbedCaption: /class="Caption"/i.test(body),
      hasLogin: /\/accounts\/login/i.test(body.slice(0, 8000)),
      hasChallenge: /challenge/i.test(body.slice(0, 4000)),
    };
    console.log(`  [${label}]`, flags);
    return flags;
  } catch (err) {
    console.log(`  [${label}] ERROR`, err.message);
    return null;
  }
}

(async () => {
  const url = normalizarUrlSocial(process.argv[2] || DEFAULT_URL);
  console.log('=== Diagnóstico Instagram cookies ===');
  console.log('URL:', url);

  const diag = diagnoseInstagramCookies();
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
    console.log('FAIL: cookies inválidos — exporte de novo o Netscape com sessionid.');
    process.exit(2);
  }

  const cookieHeader = buildInstagramCookieHeader();
  const code = String(url).match(/\/(p|reel|reels|tv)\/([^/?#]+)/i)?.[2];
  const mediaId = shortcodeToMediaId(code);
  const dsUserId = loadInstagramCookies()?.cookies?.ds_user_id;
  const headers = instagramApiHeaders(cookieHeader);

  console.log('IDs:', { code, mediaId, dsUserId: dsUserId ? `${String(dsUserId).slice(0, 4)}…` : null });

  console.log('Probes (status only):');
  await probeEndpoint(
    'media-info',
    `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
    headers
  );
  await probeEndpoint(
    'media-info-i',
    `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
    headers
  );
  if (dsUserId) {
    await probeEndpoint(
      'media-info-user',
      `https://i.instagram.com/api/v1/media/${mediaId}_${dsUserId}/info/`,
      headers
    );
  }
  await probeEndpoint(
    'post-crawler+cookie',
    url,
    {
      ...headers,
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    }
  );
  await probeEndpoint(
    'embed-captioned',
    `https://www.instagram.com/p/${code}/embed/captioned/`,
    {
      ...headers,
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    }
  );
  await probeEndpoint(
    'web-profile',
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram',
    headers
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
    process.exit(0);
  } catch (err) {
    console.log({ ok: false, error: err.message, code: err.code });
    process.exit(1);
  }
})().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
