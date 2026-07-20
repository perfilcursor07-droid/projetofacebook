const axios = require('axios');
const { env } = require('../config/env');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

/** Remove redirect de login e normaliza URL de foto/post do Facebook / Instagram. */
function normalizarUrlSocial(url) {
  let link = String(url || '').trim();
  if (!link) return link;
  try {
    const u = new URL(link);
    // Facebook manda o scraper para /login/?next=...
    if (/\/login/i.test(u.pathname) && u.searchParams.get('next')) {
      const next = u.searchParams.get('next');
      if (next) link = decodeURIComponent(next);
    }
  } catch {
    /* keep */
  }
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('instagram.com')) {
      u.hostname = 'www.instagram.com';
      u.hash = '';
      u.search = '';
      // /p/CODE/ ou /reel/CODE/ — canônico sem utm/igsh
      const m = u.pathname.match(/\/(p|reel|reels|tv)\/([^/?#]+)/i);
      if (m) {
        const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
        return `https://www.instagram.com/${kind}/${m[2]}/`;
      }
      return u.toString();
    }
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'm.facebook.com') {
      u.hostname = 'www.facebook.com';
      u.hash = '';
      // photo/?fbid=X → forma canônica
      const fbid = u.searchParams.get('fbid');
      if (fbid && /\/photo/i.test(u.pathname)) {
        return `https://www.facebook.com/photo/?fbid=${fbid}`;
      }
      return u.toString();
    }
  } catch {
    /* keep */
  }
  return link;
}

function extrairShortcodeIg(url) {
  const m = String(url || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([^/?#]+)/i);
  return m?.[1] || null;
}

/** sessionid etc. de YTDLP_IG_COOKIES_FILE (Netscape). */
async function buildInstagramCookieHeader() {
  const { buildInstagramCookieHeader: build } = require('./instagramCookies');
  return build();
}

function textoGenericoSocial(texto) {
  const t = String(texto || '').trim();
  if (!t) return true;
  if (t.length < 60) return true;
  if (/^(facebook|instagram|log in|sign up)$/i.test(t)) return true;
  if (/faça login|entre no facebook|create an account/i.test(t)) return true;
  return false;
}

function detectarPlataformaSocial(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'fb.watch' || host === 'm.facebook.com') {
      return 'facebook';
    }
    if (host.includes('instagram.com')) return 'instagram';
  } catch {
    /* ignore */
  }
  return null;
}

function isSocialPostUrl(url) {
  const plataforma = detectarPlataformaSocial(url);
  if (!plataforma) return false;
  const u = String(url || '').toLowerCase();
  if (plataforma === 'facebook') {
    return (
      /\/posts\//i.test(u) ||
      /\/permalink\.php/i.test(u) ||
      /story_fbid=/i.test(u) ||
      /\/reel\//i.test(u) ||
      /\/videos\//i.test(u) ||
      /\/share\//i.test(u) ||
      /\/photo\.php/i.test(u) ||
      /\/photo\/?\?/i.test(u) ||
      /\/photo\//i.test(u) ||
      /\/photos\//i.test(u) ||
      /[?&]fbid=/i.test(u) ||
      /pfbid/i.test(u) ||
      /fb\.watch/i.test(u)
    );
  }
  // Instagram: post, reel, tv
  return /instagram\.com\/(p|reel|reels|tv)\//i.test(u);
}

/** Reel / vídeo (não foto) — baixa, transcreve e publica como Reels. */
function isSocialVideoUrl(url) {
  if (!isSocialPostUrl(url)) return false;
  const u = String(url || '').toLowerCase();
  if (/instagram\.com\/(reel|reels|tv)\//i.test(u)) return true;
  if (/\/reel\//i.test(u) || /\/reels\//i.test(u)) return true;
  if (/\/videos\//i.test(u) || /fb\.watch/i.test(u) || /\/watch\/?\?/i.test(u)) return true;
  return false;
}

function decodificarEntidades(texto) {
  if (!texto) return '';
  let t = String(texto);
  t = t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return _;
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  return t.replace(/\s+/g, ' ').trim();
}

/** Tira prefixo "X likes, Y comments - user on date:" e pega a legenda entre aspas. */
function limparLegendaInstagram(raw) {
  let t = decodificarEntidades(String(raw || '').trim());
  if (!t) return null;
  const quoted = t.match(/["“]([\s\S]+?)["”]\s*$/);
  if (quoted?.[1] && quoted[1].trim().length >= 40) {
    return quoted[1].trim();
  }
  const afterColon = t.match(
    /(?:likes?|curtidas?|comments?|coment[aá]rios?)[^.]*?:\s*["“]?([\s\S]+)/i
  );
  if (afterColon?.[1]) {
    const cleaned = afterColon[1].replace(/^["“]|["”]$/g, '').trim();
    if (cleaned.length >= 40) return cleaned;
  }
  return t;
}

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return decodificarEntidades(
      String(raw || '')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    );
  }
}

/**
 * Extrai legenda/imagem do HTML do Instagram (SPA / embed / OG).
 * HTML autenticado no datacenter costuma ter ~600kb sem edge_media clássico.
 */
function extrairDadosDoHtmlInstagram(html, url) {
  if (!html || html.length < 200) return null;

  const signals = {
    len: html.length,
    hasLogin: /\/accounts\/login/i.test(html.slice(0, 8000)),
    hasOgDesc: /og:description/i.test(html),
    hasOgImage: /og:image/i.test(html),
    hasCaptionText: /"caption"\s*:\s*\{[^]{0,400}?"text"\s*:/i.test(html),
    hasXdt: /xdt_shortcode_media/i.test(html),
    hasEdgeCaption: /edge_media_to_caption/i.test(html),
    hasDisplayUrl: /"display_url"\s*:/i.test(html),
    hasClassCaption: /class="Caption"/i.test(html),
  };

  const parsedOg = parseOgFromHtml(html, url);
  let texto = parsedOg.texto;
  let imagem = parsedOg.imagem;
  let veiculo = parsedOg.veiculo;

  const captionRes = [
    /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
    /"caption"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
    /"caption"\s*:\s*\{[^]{0,500}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
    /"xdt_shortcode_media"[\s\S]{0,4000}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
  ];

  for (const re of captionRes) {
    const m = html.match(re);
    if (!m?.[1]) continue;
    let candidate = unescapeJsonString(m[1]);
    candidate = limparLegendaInstagram(candidate) || candidate;
    if (candidate && candidate.length >= 20 && candidate.length > (texto?.length || 0)) {
      texto = candidate;
      break;
    }
  }

  // Embed: <div class="Caption">...</div>
  if ((!texto || texto.length < 40) && signals.hasClassCaption) {
    const cap = html.match(
      /class="Caption"[^>]*>([\s\S]*?)(?:class="CaptionComments"|class="SocialProof"|<\/blockquote>)/i
    );
    if (cap?.[1]) {
      const userMatch = cap[1].match(/CaptionUsername[^>]*>([^<]+)</i);
      if (userMatch?.[1]) veiculo = decodificarEntidades(userMatch[1]).replace(/^@/, '');
      const plain = decodificarEntidades(
        cap[1]
          .replace(/<a[^>]*CaptionUsername[\s\S]*?<\/a>/i, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
      );
      if (plain.length >= 40) texto = plain;
    }
  }

  // Scripts JSON embutidos (Instagram 2024+ data-sjs / application/json)
  if (!texto || texto.length < 40) {
    const scripts = [
      ...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi),
      ...html.matchAll(/<script[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/gi),
    ];
    for (const sm of scripts.slice(0, 40)) {
      const body = sm[1] || '';
      if (body.length < 80 || body.length > 2_000_000) continue;
      if (!/caption|shortcode|display_url|xdt_shortcode/i.test(body)) continue;
      const m =
        body.match(/"caption"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
        body.match(/"caption"\s*:\s*\{[^]{0,800}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/) ||
        body.match(/"text"\s*:\s*"((?:\\.|[^"\\]){50,5000})"/);
      if (!m?.[1]) continue;
      let candidate = unescapeJsonString(m[1]);
      candidate = limparLegendaInstagram(candidate) || candidate;
      if (
        candidate &&
        candidate.length >= 40 &&
        !/^(Log in|Sign up|Instagram|Meta)/i.test(candidate) &&
        candidate.length > (texto?.length || 0)
      ) {
        texto = candidate;
        signals.hasCaptionText = true;
        break;
      }
    }
  }

  if (!imagem) {
    const imgRes = [
      /"display_url"\s*:\s*"(https:[^"]+)"/i,
      /"image_versions2"[\s\S]{0,400}?"url"\s*:\s*"(https:[^"]+)"/i,
    ];
    for (const re of imgRes) {
      const m = html.match(re);
      if (m?.[1] && !/rsrc\.php|static\.cdninstagram/i.test(m[1])) {
        imagem = m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
        break;
      }
    }
    if (!imagem) imagem = parsedOg.imagem;
  }

  if (!veiculo) {
    veiculo =
      html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([a-z0-9._]+)"/i)?.[1] ||
      html.match(/"username"\s*:\s*"([a-z0-9._]+)"/i)?.[1] ||
      parsedOg.veiculo ||
      null;
  }

  if (texto && texto.length >= 40) {
    return {
      url,
      titulo: texto.slice(0, 140),
      texto,
      imagem: imagem || null,
      veiculo,
      metodo: 'ig-html',
      signals,
    };
  }

  return {
    url,
    titulo: parsedOg.titulo || null,
    texto: texto || null,
    imagem: imagem || null,
    veiculo,
    metodo: 'ig-html',
    signals,
    empty: true,
  };
}

function pickMeta(html, prop) {
  const patterns = [
    new RegExp(`property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'),
    new RegExp(`name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`content=["']([^"']+)["'][^>]+name=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodificarEntidades(m[1].replace(/&amp;/gi, '&'));
  }
  return null;
}

function absolutizar(base, maybe) {
  if (!maybe) return null;
  try {
    return new URL(maybe, base).href;
  } catch {
    return /^https?:\/\//i.test(maybe) ? maybe : null;
  }
}

async function fetchHtml(url, userAgent, extraHeaders = {}) {
  const res = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      ...extraHeaders,
    },
  });
  return {
    html: String(res.data || ''),
    finalUrl: res.request?.res?.responseURL || res.request?.res?.responseUrl || url,
  };
}

function parseOgFromHtml(html, finalUrl) {
  let titulo = pickMeta(html, 'og:title') || pickMeta(html, 'twitter:title');
  let resumo = pickMeta(html, 'og:description') || pickMeta(html, 'twitter:description');
  const imagem =
    absolutizar(finalUrl, pickMeta(html, 'og:image')) ||
    absolutizar(finalUrl, pickMeta(html, 'og:image:secure_url')) ||
    absolutizar(finalUrl, pickMeta(html, 'twitter:image'));

  let veiculo = null;
  try {
    const host = new URL(finalUrl).hostname.replace(/^www\./, '');
    // og:title em foto FB costuma ser "Nome da Página" — útil como veículo
    veiculo = titulo && !/^(facebook|instagram)$/i.test(titulo) ? titulo : host;
  } catch {
    veiculo = null;
  }

  // Instagram: limpa legenda do og:description / og:title
  if (/instagram\.com/i.test(finalUrl)) {
    const limpo = limparLegendaInstagram(resumo) || limparLegendaInstagram(titulo);
    if (limpo && limpo.length >= 40) {
      resumo = limpo;
      if (!titulo || /(?:on|no)\s+Instagram:/i.test(titulo) || /instagram photos/i.test(titulo)) {
        titulo = limpo.slice(0, 140);
      }
    }
    const authorFromTitle = String(titulo || '').match(/^(.+?)\s+on Instagram:/i);
    if (authorFromTitle?.[1]) veiculo = authorFromTitle[1].trim();
    const authorFromDesc = String(pickMeta(html, 'og:description') || '').match(
      /-\s*([a-z0-9._]+)\s+(?:on|no)\s+/i
    );
    if (authorFromDesc?.[1]) veiculo = authorFromDesc[1];
  }

  return {
    url: finalUrl,
    titulo: titulo || null,
    texto: resumo || null,
    imagem: imagem || null,
    veiculo,
    metodo: 'og',
  };
}

async function extrairViaOg(url) {
  const cookie =
    /instagram\.com/i.test(url) ? await buildInstagramCookieHeader() : null;
  const extra = cookie ? { Cookie: cookie } : {};

  // Crawler UA primeiro (melhor OG); se falhar imagem/texto, tenta browser UA
  let best = { url, titulo: null, texto: null, imagem: null, veiculo: null, metodo: 'og' };
  for (const ua of [CRAWLER_UA, BROWSER_UA]) {
    try {
      const { html, finalUrl } = await fetchHtml(url, ua, extra);
      const parsed = parseOgFromHtml(html, finalUrl);
      if ((!best.texto || best.texto.length < 40) && parsed.texto) best.texto = parsed.texto;
      if (!best.imagem && parsed.imagem) best.imagem = parsed.imagem;
      if (!best.titulo && parsed.titulo) best.titulo = parsed.titulo;
      if (!best.veiculo && parsed.veiculo) best.veiculo = parsed.veiculo;
      best.url = parsed.url || best.url;
      if (best.texto && best.imagem) break;
    } catch (err) {
      console.warn('[socialPost] og ua:', err.message);
    }
  }
  return best;
}

/**
 * Embed público do Instagram — muitas vezes devolve a legenda mesmo quando o post
 * principal bloqueia IPs de datacenter.
 */
async function extrairViaInstagramEmbed(url) {
  const code = extrairShortcodeIg(url);
  if (!code) return null;

  const cookie = await buildInstagramCookieHeader();
  const extra = cookie ? { Cookie: cookie } : {};
  const candidates = [
    `https://www.instagram.com/p/${code}/embed/captioned/`,
    `https://www.instagram.com/reel/${code}/embed/captioned/`,
    `https://www.instagram.com/p/${code}/embed/`,
  ];

  for (const embedUrl of candidates) {
    for (const ua of [CRAWLER_UA, BROWSER_UA]) {
      try {
        const { html } = await fetchHtml(embedUrl, ua, extra);
        if (!html || html.length < 500) continue;

        let texto = null;
        let veiculo = null;
        let imagem = null;

        const edge = html.match(
          /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/
        );
        if (edge?.[1]) {
          try {
            texto = JSON.parse(`"${edge[1]}"`);
          } catch {
            texto = decodificarEntidades(edge[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
          }
        }

        if (!texto || texto.length < 40) {
          const capBlock = html.match(
            /class="Caption"[^>]*>([\s\S]*?)(?:class="CaptionComments"|class="SocialProof"|<\/blockquote>)/i
          );
          if (capBlock?.[1]) {
            const userMatch = capBlock[1].match(/CaptionUsername[^>]*>([^<]+)</i);
            if (userMatch?.[1]) veiculo = decodificarEntidades(userMatch[1]).replace(/^@/, '');
            texto = decodificarEntidades(
              capBlock[1]
                .replace(/<a[^>]*CaptionUsername[\s\S]*?<\/a>/i, ' ')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
            );
          }
        }

        if (!veiculo) {
          const user = html.match(/instagram\.com\/([a-z0-9._]+)\/?\?utm_source=ig_embed/i);
          if (user?.[1] && !/^(p|reel|reels|tv|explore)$/i.test(user[1])) veiculo = user[1];
        }

        const imgMatch =
          html.match(
            /(https:\/\/[^"'\s]+(?:cdninstagram|fbcdn)[^"'\s]+\.(?:jpg|webp)[^"'\s]*)/i
          ) || html.match(/content=["'](https:\/\/[^"']+scontent[^"']+)["']/i);
        if (imgMatch?.[1] && !/rsrc\.php|static\.cdninstagram/i.test(imgMatch[1])) {
          imagem = imgMatch[1].replace(/&amp;/g, '&');
        }

        texto = limparLegendaInstagram(texto) || texto;
        if (texto && texto.length >= 40) {
          return {
            url,
            titulo: texto.slice(0, 140),
            texto,
            imagem,
            veiculo,
            metodo: 'ig-embed',
          };
        }
      } catch (err) {
        console.warn('[socialPost] ig-embed:', err.message);
      }
    }
  }
  return null;
}

/**
 * Mirrors (ddinstagram etc.) — útil quando o domínio oficial bloqueia o servidor.
 */
async function extrairViaInstagramMirror(url) {
  const code = extrairShortcodeIg(url);
  if (!code) return null;
  const mirrors = [
    `https://www.ddinstagram.com/p/${code}/`,
    `https://ddinstagram.com/p/${code}/`,
  ];
  for (const mirror of mirrors) {
    try {
      const { html, finalUrl } = await fetchHtml(mirror, CRAWLER_UA);
      const parsed = parseOgFromHtml(html, finalUrl || mirror);
      if (parsed.texto && parsed.texto.length >= 40) {
        parsed.url = url;
        parsed.metodo = 'ig-mirror';
        return parsed;
      }
    } catch (err) {
      console.warn('[socialPost] ig-mirror:', err.message);
    }
  }
  return null;
}

/**
 * API web do Instagram com sessionid (melhor caminho para foto /p/ no servidor).
 * yt-dlp costuma devolver HTTP 400 em posts só com imagem.
 */
async function extrairViaInstagramApi(url) {
  const {
    buildInstagramCookieHeader,
    diagnoseInstagramCookies,
    shortcodeToMediaId,
    instagramApiHeaders,
    bootstrapInstagramSession,
  } = require('./instagramCookies');

  const code = extrairShortcodeIg(url);
  if (!code) {
    console.warn('[socialPost] ig-api: shortcode inválido');
    return null;
  }

  let cookieHeader = buildInstagramCookieHeader();
  if (!cookieHeader) {
    const diag = diagnoseInstagramCookies();
    console.warn('[socialPost] ig-api: sem sessionid —', diag.reason, diag.file || '');
    return null;
  }

  // Bootstrap www-claim (sem isso /media/*/info/ costuma 400 no datacenter)
  let wwwClaim = '0';
  try {
    const boot = await bootstrapInstagramSession(axios);
    if (boot?.cookieHeader) cookieHeader = boot.cookieHeader;
    if (boot?.claim) wwwClaim = boot.claim;
    console.warn(
      `[socialPost] ig-api: bootstrap status=${boot?.homeStatus || '?'} claim=${wwwClaim !== '0'} homeLen=${boot?.homeLen || 0}`
    );
  } catch (err) {
    console.warn('[socialPost] ig-api: bootstrap', err.message);
  }

  const mediaId = shortcodeToMediaId(code);
  const dsUserId = require('./instagramCookies').loadInstagramCookies()?.cookies?.ds_user_id;
  const mediaIdWithUser = mediaId && dsUserId ? `${mediaId}_${dsUserId}` : null;
  console.warn(`[socialPost] ig-api: tentando shortcode=${code} mediaId=${mediaId}`);

  const endpoints = [
    mediaId ? `https://www.instagram.com/api/v1/media/${mediaId}/info/` : null,
    mediaId ? `https://i.instagram.com/api/v1/media/${mediaId}/info/` : null,
    mediaIdWithUser ? `https://i.instagram.com/api/v1/media/${mediaIdWithUser}/info/` : null,
    `https://www.instagram.com/graphql/query/?doc_id=10015901848456354&variables=${encodeURIComponent(
      JSON.stringify({
        shortcode: code,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      })
    )}`,
    `https://www.instagram.com/p/${code}/?__a=1&__d=dis`,
    `https://www.instagram.com/reel/${code}/?__a=1&__d=dis`,
  ].filter(Boolean);

  const headerVariants = [
    instagramApiHeaders(cookieHeader, { mobile: false, wwwClaim }),
    instagramApiHeaders(cookieHeader, { mobile: true, wwwClaim }),
  ];

  for (const headers of headerVariants) {
    for (const endpoint of endpoints) {
      try {
        const { data, status } = await axios.get(endpoint, {
          timeout: 25000,
          headers,
          validateStatus: (s) => s >= 200 && s < 500,
        });
        if (status >= 400 || !data) {
          console.warn(`[socialPost] ig-api: ${status} ${endpoint.slice(0, 70)}`);
          continue;
        }

        let media =
          data?.items?.[0] ||
          data?.graphql?.shortcode_media ||
          data?.data?.xdt_shortcode_media ||
          data?.data?.shortcode_media ||
          null;

        if (!media && data && typeof data === 'object') {
          for (const v of Object.values(data)) {
            if (v?.graphql?.shortcode_media) {
              media = v.graphql.shortcode_media;
              break;
            }
            if (v?.items?.[0]) {
              media = v.items[0];
              break;
            }
          }
        }
        if (!media || typeof media !== 'object') continue;

        const textoRaw =
          media.caption?.text ||
          media.edge_media_to_caption?.edges?.[0]?.node?.text ||
          media.accessibility_caption ||
          '';
        let texto = limparLegendaInstagram(textoRaw) || String(textoRaw || '').trim();
        const veiculo =
          media.user?.username || media.owner?.username || media.user?.full_name || null;
        const imagem =
          media.image_versions2?.candidates?.[0]?.url ||
          media.display_url ||
          media.display_resources?.slice?.(-1)?.[0]?.src ||
          media.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
          null;

        if (texto && texto.length >= 40) {
          console.warn(`[socialPost] ig-api: ok (${texto.length} chars) via ${endpoint.slice(0, 60)}`);
          return {
            url,
            titulo: texto.slice(0, 140),
            texto,
            imagem: imagem || null,
            veiculo,
            metodo: 'ig-api',
          };
        }
        if (imagem && texto && texto.length >= 20) {
          return {
            url,
            titulo: texto.slice(0, 140),
            texto,
            imagem,
            veiculo,
            metodo: 'ig-api',
          };
        }
      } catch (err) {
        console.warn('[socialPost] ig-api:', err.response?.status || err.message);
      }
    }
  }

  // HTML: com cookies (claim) + embed público (às vezes funciona sem cookie no crawler UA)
  const htmlAttempts = [
    { ua: CRAWLER_UA, cookie: cookieHeader },
    { ua: BROWSER_UA, cookie: cookieHeader },
    { ua: CRAWLER_UA, cookie: null },
  ];
  for (const attempt of htmlAttempts) {
    try {
      const pages = [
        url,
        `https://www.instagram.com/p/${code}/embed/captioned/`,
        `https://www.instagram.com/p/${code}/embed/`,
      ];
      for (const pageUrl of pages) {
        const extra = {
          'X-IG-App-ID': '936619743392459',
          ...(attempt.cookie ? { Cookie: attempt.cookie } : {}),
          ...(wwwClaim && wwwClaim !== '0' ? { 'X-IG-WWW-Claim': wwwClaim } : {}),
        };
        const { html, finalUrl } = await fetchHtml(pageUrl, attempt.ua, extra);
        const extracted = extrairDadosDoHtmlInstagram(html, finalUrl || url);
        const sig = extracted?.signals
          ? `login=${extracted.signals.hasLogin} og=${extracted.signals.hasOgDesc} captionJson=${extracted.signals.hasCaptionText} xdt=${extracted.signals.hasXdt} embedCap=${extracted.signals.hasClassCaption}`
          : '';
        console.warn(
          `[socialPost] ig-html: cookie=${Boolean(attempt.cookie)} ua=${attempt.ua.slice(0, 18)} url=${pageUrl.slice(-36)} len=${html.length} ${sig}`
        );
        if (extracted && !extracted.empty && extracted.texto && extracted.texto.length >= 40) {
          console.warn(`[socialPost] ig-html: ok (${extracted.texto.length} chars)`);
          return {
            url,
            titulo: extracted.titulo,
            texto: extracted.texto,
            imagem: extracted.imagem,
            veiculo: extracted.veiculo,
            metodo: 'ig-cookie-html',
          };
        }
      }
    } catch (err) {
      console.warn('[socialPost] ig-cookie-html:', err.message);
    }
  }

  console.warn('[socialPost] ig-api: falhou em todos os endpoints');
  return null;
}

/**
 * Jina Reader — texto mais completo de posts públicos.
 * https://r.jina.ai/<url>
 */
async function extrairViaJina(url) {
  const res = await axios.get(`https://r.jina.ai/${url}`, {
    timeout: 60000,
    headers: {
      Accept: 'text/plain',
      'User-Agent': BROWSER_UA,
      'X-Return-Format': 'markdown',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const raw = String(res.data || '');
  const titleMatch = raw.match(/^Title:\s*(.+)$/m);
  const titulo = titleMatch ? titleMatch[1].trim() : null;

  // Pega o bloco de markdown após "Markdown Content:"
  let body = raw;
  const mdIdx = raw.search(/Markdown Content:\s*/i);
  if (mdIdx >= 0) body = raw.slice(mdIdx).replace(/^Markdown Content:\s*/i, '');

  // Remove ruído de login / navegação
  const linhas = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/^\[Log In\]/i.test(l) &&
        !/^#{1,3}\s/i.test(l) &&
        !/^\*+$/.test(l) &&
        !/^!\[/.test(l) &&
        !/^\[.*\]\(https?:\/\/(www\.)?facebook\.com\/(login|stories)/i.test(l)
    );

  // Junta parágrafos “reais” (frases longas)
  const paragrafos = [];
  for (const l of linhas) {
    const clean = l
      .replace(/^>\s*/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim();
    if (clean.length >= 40 && !/^(Log In|Sign Up|Follow|Curtir|Comentar)/i.test(clean)) {
      paragrafos.push(clean);
    }
    if (paragrafos.join(' ').length > 2500) break;
  }

  const texto = paragrafos.slice(0, 6).join('\n\n');
  const imgMatch = raw.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  const imagem = imgMatch?.[1] || null;

  return {
    url,
    titulo,
    texto: texto || null,
    imagem,
    veiculo: titulo || null,
    metodo: 'jina',
  };
}

async function extrairViaYtDlp(url) {
  try {
    // Não gasta yt-dlp em URL de login
    if (/facebook\.com\/login/i.test(url)) return null;
    const importService = require('./importService');
    const meta = await importService.fetchLinkMetadata(url);
    const fs = require('fs');
    const youtubedlPkg = require('youtube-dl-exec');
    const { runYtDlp } = require('./ytDlpAuth');
    let binary = String(process.env.YTDLP_PATH || '').trim();
    if (!binary || !fs.existsSync(binary)) {
      for (const c of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
        if (fs.existsSync(c)) {
          binary = c;
          break;
        }
      }
    }
    const exec = binary ? youtubedlPkg.create(binary) : youtubedlPkg;
    const info = await runYtDlp(exec, url, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      socketTimeout: 45,
      retries: 1,
    });
    const texto = String(info.description || info.title || '').trim();
    const thumb =
      info.thumbnail ||
      (Array.isArray(info.thumbnails)
        ? [...info.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url
        : null);
    return {
      url,
      titulo: info.title || meta.titulo || null,
      texto: texto || null,
      imagem: thumb || meta.thumbnail || null,
      veiculo: info.uploader || info.channel || meta.autor || null,
      metodo: 'yt-dlp',
    };
  } catch (err) {
    console.warn('[socialPost] yt-dlp:', err.message);
    return null;
  }
}

/** oEmbed oficial (app token) — FB e IG; Meta costuma exigir review do oEmbed Read. */
async function extrairViaOembed(url) {
  if (!env.facebook?.appId || !env.facebook?.appSecret) return null;
  const isIg = /instagram\.com/i.test(url);
  const endpoints = isIg
    ? [
        'https://graph.facebook.com/v21.0/instagram_oembed',
        'https://graph.facebook.com/v21.0/oembed_post',
      ]
    : ['https://graph.facebook.com/v21.0/oembed_post'];

  const token = `${env.facebook.appId}|${env.facebook.appSecret}`;
  for (const endpoint of endpoints) {
    try {
      const { data } = await axios.get(endpoint, {
        params: { url, access_token: token, omitscript: true },
        timeout: 20000,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const html = String(data.html || '');
      const author = data.author_name || null;
      let texto = null;
      const bq = html.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i);
      if (bq) {
        texto = decodificarEntidades(
          bq[1]
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
      }
      if (texto) texto = limparLegendaInstagram(texto) || texto;
      const img =
        absolutizar(url, pickMeta(html, 'og:image')) ||
        (html.match(/src=["'](https:\/\/[^"']+(?:fbcdn|scontent|cdninstagram)[^"']+)["']/i) ||
          [])[1] ||
        null;
      if (!texto && !img && !author) continue;
      return {
        url,
        titulo: author ? `Post — ${author}` : null,
        texto: texto && !textoGenericoSocial(texto) ? texto : null,
        imagem: img,
        veiculo: author,
        metodo: 'oembed',
      };
    } catch (err) {
      console.warn('[socialPost] oembed:', err.response?.data?.error?.message || err.message);
    }
  }
  return null;
}

/** mbasic — às vezes passa onde www exige login. */
async function extrairViaMbasic(url) {
  try {
    const u = new URL(normalizarUrlSocial(url));
    if (!u.hostname.includes('facebook.com')) return null;
    u.hostname = 'mbasic.facebook.com';
    const { html, finalUrl } = await fetchHtml(u.toString(), BROWSER_UA);
    if (/\/login/i.test(finalUrl) || /log in|entre no facebook/i.test(html.slice(0, 2000))) {
      return null;
    }
    const parsed = parseOgFromHtml(html, finalUrl);
    // Legenda em mbasic costuma estar em <div class="..."> longos
    if (!parsed.texto || parsed.texto.length < 80) {
      const plain = decodificarEntidades(
        html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|span)>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
      );
      const linhas = plain
        .split(/\n+/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l) => l.length >= 50 && !/^(Log In|Sign Up|Facebook|Menu|Notific)/i.test(l));
      const candidato = linhas.slice(0, 4).join('\n\n');
      if (candidato.length >= 60) parsed.texto = candidato.slice(0, 3500);
    }
    parsed.metodo = 'mbasic';
    return parsed;
  } catch (err) {
    console.warn('[socialPost] mbasic:', err.message);
    return null;
  }
}

function mesclarExtracao(melhor, extra) {
  if (!extra) return melhor;
  const out = { ...melhor };
  const textoAtualConfiavel = ['scrapecreators', 'manual'].includes(out.textoMetodo);
  const textoNovoConfiavel = ['scrapecreators', 'manual'].includes(extra.metodo);
  if (
    extra.texto &&
    (!out.texto ||
      (!textoAtualConfiavel &&
        (textoNovoConfiavel || extra.texto.length > out.texto.length)))
  ) {
    out.texto = extra.texto;
    out.textoMetodo = extra.metodo || null;
  }
  if (!out.imagem && extra.imagem) out.imagem = extra.imagem;
  if (!out.titulo && extra.titulo) out.titulo = extra.titulo;
  if (!out.veiculo && extra.veiculo) out.veiculo = extra.veiculo;
  if (!out.videoUrl && extra.videoUrl) out.videoUrl = extra.videoUrl;
  if (out.isVideo == null && extra.isVideo != null) out.isVideo = extra.isVideo;
  if (!out.publicadoEm && extra.publicadoEm) out.publicadoEm = extra.publicadoEm;
  if (!out.autorUrl && extra.autorUrl) out.autorUrl = extra.autorUrl;
  if (extra.url && !/\/login/i.test(extra.url)) out.url = extra.url;
  if (extra.metodo) {
    out.metodo = out.metodo ? `${out.metodo}+${extra.metodo}` : extra.metodo;
  }
  return out;
}

/**
 * Extrai texto + imagem de post Facebook / Instagram.
 * @param {string} url
 * @param {{ textoManual?: string, imagemManual?: string }} [opts]
 */
async function extrairPostSocial(url, opts = {}) {
  const link = normalizarUrlSocial(url);
  const plataforma = detectarPlataformaSocial(link);
  if (!plataforma) {
    const err = new Error('Link não é de Facebook ou Instagram');
    err.status = 400;
    throw err;
  }

  const textoManual = String(opts.textoManual || '').trim();
  const imagemManual = String(opts.imagemManual || '').trim();

  let melhor = {
    url: link,
    titulo: null,
    texto: null,
    imagem: null,
    veiculo: null,
    metodo: null,
    plataforma,
    isVideo: null,
    videoUrl: null,
    publicadoEm: null,
    autorUrl: null,
  };

  const scrapeCreators = require('./scrapeCreatorsSocial');
  let scrapeCreatorsFalhou = false;

  // 1) ScrapeCreators — provedor principal para posts individuais IG/FB.
  if (scrapeCreators.isConfigured()) {
    try {
      melhor = mesclarExtracao(melhor, await scrapeCreators.extrairPost(link, plataforma));
    } catch (err) {
      scrapeCreatorsFalhou = true;
      console.warn('[socialPost] scrapecreators:', err.message);
    }
  }

  // Legendas curtas vindas da API são confiáveis; nos demais métodos, texto curto pode ser ruído.
  const precisaTexto = () =>
    !melhor.texto ||
    (textoGenericoSocial(melhor.texto) &&
      !['scrapecreators', 'manual'].includes(melhor.textoMetodo));

  // 2) Open Graph e métodos legados complementam somente campos ausentes/incompletos.
  if (precisaTexto() || !melhor.imagem) {
    try {
      melhor = mesclarExtracao(melhor, await extrairViaOg(link));
    } catch (err) {
      console.warn('[socialPost] og:', err.message);
    }
  }

  if (plataforma === 'instagram' && (precisaTexto() || !melhor.imagem)) {
    melhor = mesclarExtracao(melhor, await extrairViaInstagramApi(link));
  }

  if (plataforma === 'instagram' && (precisaTexto() || !melhor.imagem)) {
    melhor = mesclarExtracao(melhor, await extrairViaInstagramEmbed(link));
  }
  if (plataforma === 'instagram' && precisaTexto()) {
    melhor = mesclarExtracao(melhor, await extrairViaInstagramMirror(link));
  }

  if (plataforma === 'facebook' && (precisaTexto() || !melhor.imagem)) {
    melhor = mesclarExtracao(melhor, await extrairViaOembed(link));
  }

  if (precisaTexto() || !melhor.imagem) {
    try {
      melhor = mesclarExtracao(melhor, await extrairViaJina(link));
    } catch (err) {
      console.warn('[socialPost] jina:', err.message);
    }
  }

  if (plataforma === 'facebook' && (precisaTexto() || !melhor.imagem)) {
    melhor = mesclarExtracao(melhor, await extrairViaMbasic(link));
  }

  // yt-dlp — Instagram /p/ (foto) costuma HTTP 400; só tenta reel/tv.
  const igEhVideo = /instagram\.com\/(reel|reels|tv)\//i.test(link);
  if ((precisaTexto() || !melhor.imagem) && (plataforma !== 'instagram' || igEhVideo)) {
    melhor = mesclarExtracao(melhor, await extrairViaYtDlp(link));
  } else if (plataforma === 'instagram' && !igEhVideo && precisaTexto()) {
    console.warn('[socialPost] yt-dlp: pulado (post foto /p/ — use API ou cookies)');
  }

  // Override final: o que o usuário colou sempre prevalece sobre qualquer provedor.
  if (textoManual.length >= 40) {
    melhor.texto = textoManual;
    melhor.textoMetodo = 'manual';
    melhor.metodo = melhor.metodo ? `${melhor.metodo}+manual` : 'manual';
  }
  if (/^https?:\/\//i.test(imagemManual)) {
    melhor.imagem = imagemManual;
    if (!String(melhor.metodo || '').includes('manual')) {
      melhor.metodo = melhor.metodo ? `${melhor.metodo}+manual` : 'manual';
    }
  }

  if (precisaTexto()) {
    const { diagnoseInstagramCookies } = require('./instagramCookies');
    const igDiag = plataforma === 'instagram' ? diagnoseInstagramCookies() : null;
    let mensagem;
    if (scrapeCreators.isConfigured()) {
      mensagem =
        plataforma === 'instagram'
          ? 'Não foi possível obter a legenda deste post pelo provedor automático nem pelos métodos alternativos. O post pode estar privado, restrito ou indisponível. Cole a legenda em “Texto da postagem”.'
          : 'Não foi possível obter a legenda deste post do Facebook pelo provedor automático nem pelos métodos alternativos. O post pode estar privado ou exigir login. Cole a legenda em “Texto da postagem” e, se puder, a URL da imagem.';
    } else {
      mensagem =
        plataforma === 'instagram'
          ? igDiag?.ok
            ? 'O Instagram bloqueou a leitura automática (sessão expirada, checkpoint ou post restrito). Atualize os cookies em YTDLP_IG_COOKIES_FILE ou cole a legenda em “Texto da postagem”.'
            : `Cookies do Instagram inválidos (${igDiag?.reason || 'ausentes'}). Exporte de novo para /home/viralizeai/secrets/instagram-cookies.txt ou cole a legenda em “Texto da postagem”.`
          : 'O Facebook bloqueou a leitura automática deste post (pede login no servidor). Cole a legenda do post no campo “Texto da postagem” (e, se puder, a URL da imagem) e gere de novo.';
    }
    const err = new Error(mensagem);
    err.status = 422;
    err.code = 'SOCIAL_EXTRACT_BLOCKED';
    err.providerFailed = scrapeCreatorsFalhou;
    throw err;
  }

  // Preferir manchete a partir do texto (og:title costuma ser só o nome da Página).
  const firstSentence = String(melhor.texto || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .find((s) => s.length >= 28);
  if (
    firstSentence &&
    (!melhor.titulo ||
      melhor.titulo === melhor.veiculo ||
      melhor.titulo.length < 24 ||
      /^(facebook|instagram)$/i.test(melhor.titulo))
  ) {
    melhor.titulo = firstSentence.slice(0, 140);
  }
  if (!melhor.titulo || /^(facebook|instagram)$/i.test(melhor.titulo)) {
    melhor.titulo = firstSentence
      ? firstSentence.slice(0, 140)
      : String(melhor.texto).slice(0, 120);
  }

  return melhor;
}

/**
 * Converte extração social em formato apurarTopico.
 */
function socialParaTopico(extraido, linkOriginal) {
  const trecho = extraido.texto || '';
  const resumo = trecho.slice(0, 400);
  return {
    link: extraido.url || linkOriginal,
    linkOriginal,
    titulo: extraido.titulo,
    resumo,
    imagemFonte: extraido.imagem || null,
    veiculo: extraido.veiculo || extraido.plataforma || null,
    fonte: extraido.veiculo || extraido.plataforma || null,
    redeSocial: true,
    tipoFonte: 'rede_social',
    contextoApuracao: [
      `Assunto: ${extraido.titulo || ''}`,
      extraido.veiculo ? `Página/perfil: ${extraido.veiculo}` : null,
      `Plataforma: ${extraido.plataforma}`,
      `URL: ${extraido.url || linkOriginal}`,
      extraido.imagem ? `Imagem do post: ${extraido.imagem}` : null,
      trecho ? `Texto original do post (legenda):\n${trecho.slice(0, 3500)}` : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
    fontesApuracao: [
      {
        veiculo: extraido.veiculo || extraido.plataforma || 'Rede social',
        url: extraido.url || linkOriginal,
        titulo: extraido.titulo,
        resumo,
        trecho,
        ehRedeSocial: true,
      },
    ],
    dataReferencia: null,
  };
}

module.exports = {
  detectarPlataformaSocial,
  isSocialPostUrl,
  isSocialVideoUrl,
  normalizarUrlSocial,
  extrairPostSocial,
  socialParaTopico,
};
