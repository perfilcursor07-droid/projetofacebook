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
    shortcodeToMediaId,
    instagramApiHeaders,
  } = require('./instagramCookies');

  const code = extrairShortcodeIg(url);
  const cookieHeader = buildInstagramCookieHeader();
  if (!code || !cookieHeader) return null;

  const mediaId = shortcodeToMediaId(code);
  const headers = instagramApiHeaders(cookieHeader);

  const endpoints = [
    mediaId
      ? `https://www.instagram.com/api/v1/media/${mediaId}/info/`
      : null,
    mediaId ? `https://i.instagram.com/api/v1/media/${mediaId}/info/` : null,
    `https://www.instagram.com/p/${code}/?__a=1&__d=dis`,
    `https://www.instagram.com/reel/${code}/?__a=1&__d=dis`,
  ].filter(Boolean);

  for (const endpoint of endpoints) {
    try {
      const { data, status } = await axios.get(endpoint, {
        timeout: 25000,
        headers,
        validateStatus: (s) => s >= 200 && s < 500,
      });
      if (status >= 400 || !data) continue;

      const item =
        data?.items?.[0] ||
        data?.graphql?.shortcode_media ||
        data?.data?.xdt_shortcode_media ||
        data?.items?.[0] ||
        null;

      // formato __a=1 antigo
      const media =
        item ||
        data?.graphql?.shortcode_media ||
        (typeof data === 'object' ? Object.values(data)?.[0]?.graphql?.shortcode_media : null);

      const node = item || media;
      if (!node || typeof node !== 'object') continue;

      const textoRaw =
        node.caption?.text ||
        node.edge_media_to_caption?.edges?.[0]?.node?.text ||
        node.accessibility_caption ||
        '';
      const texto = limparLegendaInstagram(textoRaw) || String(textoRaw || '').trim();
      const veiculo =
        node.user?.username ||
        node.owner?.username ||
        node.user?.full_name ||
        null;
      const imagem =
        node.image_versions2?.candidates?.[0]?.url ||
        node.display_url ||
        node.display_resources?.slice?.(-1)?.[0]?.src ||
        node.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
        null;

      if (texto && texto.length >= 40) {
        return {
          url,
          titulo: texto.slice(0, 140),
          texto,
          imagem: imagem || null,
          veiculo,
          metodo: 'ig-api',
        };
      }

      // só imagem: ainda útil se o usuário colar texto manual depois — mas para gerar precisa texto
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

  // Última tentativa: HTML autenticado + OG / JSON embutido
  try {
    const { html, finalUrl } = await fetchHtml(url, BROWSER_UA, {
      Cookie: cookieHeader,
      'X-IG-App-ID': '936619743392459',
    });
    const parsed = parseOgFromHtml(html, finalUrl || url);
    if (parsed.texto && parsed.texto.length >= 40) {
      parsed.metodo = 'ig-cookie-html';
      return parsed;
    }

    const captionMatch = html.match(
      /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/
    );
    if (captionMatch?.[1]) {
      let texto;
      try {
        texto = JSON.parse(`"${captionMatch[1]}"`);
      } catch {
        texto = decodificarEntidades(captionMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
      }
      texto = limparLegendaInstagram(texto) || texto;
      if (texto && texto.length >= 40) {
        const img =
          html.match(/"display_url"\s*:\s*"(https:[^"]+)"/)?.[1]?.replace(/\\u0026/g, '&') ||
          parsed.imagem;
        const user = html.match(/"username"\s*:\s*"([a-z0-9._]+)"/i)?.[1];
        return {
          url,
          titulo: texto.slice(0, 140),
          texto,
          imagem: img || null,
          veiculo: user || parsed.veiculo,
          metodo: 'ig-cookie-html',
        };
      }
    }
  } catch (err) {
    console.warn('[socialPost] ig-cookie-html:', err.message);
  }

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
  if (extra.texto && (!out.texto || extra.texto.length > out.texto.length)) {
    out.texto = extra.texto;
  }
  if (!out.imagem && extra.imagem) out.imagem = extra.imagem;
  if (!out.titulo && extra.titulo) out.titulo = extra.titulo;
  if (!out.veiculo && extra.veiculo) out.veiculo = extra.veiculo;
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
  };

  // 1) Open Graph (com cookies IG se configurados)
  try {
    melhor = mesclarExtracao(melhor, await extrairViaOg(link));
  } catch (err) {
    console.warn('[socialPost] og:', err.message);
  }

  // 1a) API Instagram autenticada (prioridade no servidor — fotos /p/)
  if (plataforma === 'instagram' && (textoGenericoSocial(melhor.texto) || !melhor.imagem)) {
    melhor = mesclarExtracao(melhor, await extrairViaInstagramApi(link));
  }

  // 1b) Embed / mirror Instagram
  if (plataforma === 'instagram' && (textoGenericoSocial(melhor.texto) || !melhor.imagem)) {
    melhor = mesclarExtracao(melhor, await extrairViaInstagramEmbed(link));
  }
  if (plataforma === 'instagram' && textoGenericoSocial(melhor.texto)) {
    melhor = mesclarExtracao(melhor, await extrairViaInstagramMirror(link));
  }

  // 2) oEmbed (app token) — Meta exige review; pode falhar com (#10)
  if (textoGenericoSocial(melhor.texto) || !melhor.imagem) {
    melhor = mesclarExtracao(melhor, await extrairViaOembed(link));
  }

  // 3) Jina
  if (textoGenericoSocial(melhor.texto) || !melhor.imagem) {
    try {
      melhor = mesclarExtracao(melhor, await extrairViaJina(link));
    } catch (err) {
      console.warn('[socialPost] jina:', err.message);
    }
  }

  // 4) mbasic
  if (plataforma === 'facebook' && (textoGenericoSocial(melhor.texto) || !melhor.imagem)) {
    melhor = mesclarExtracao(melhor, await extrairViaMbasic(link));
  }

  // 5) yt-dlp (cookies IG via YTDLP_IG_COOKIES_FILE)
  if (textoGenericoSocial(melhor.texto) || !melhor.imagem) {
    melhor = mesclarExtracao(melhor, await extrairViaYtDlp(link));
  }

  // Fallback manual (usuário colou a legenda / URL da imagem)
  if (textoManual.length >= 40) {
    melhor.texto = textoManual;
    melhor.metodo = melhor.metodo ? `${melhor.metodo}+manual` : 'manual';
  }
  if (/^https?:\/\//i.test(imagemManual)) {
    melhor.imagem = imagemManual;
  }

  if (textoGenericoSocial(melhor.texto)) {
    const temCookiesIg = Boolean(String(env.ytDlp?.igCookiesFile || '').trim());
    const err = new Error(
      plataforma === 'instagram'
        ? temCookiesIg
          ? 'O Instagram bloqueou a leitura automática (sessão expirada ou post restrito). Atualize YTDLP_IG_COOKIES_FILE ou cole a legenda em “Texto da postagem”.'
          : 'O Instagram bloqueou a leitura automática neste servidor. Configure cookies Netscape em YTDLP_IG_COOKIES_FILE (conta logada no Instagram), ou cole a legenda em “Texto da postagem”.'
        : 'O Facebook bloqueou a leitura automática deste post (pede login no servidor). Cole a legenda do post no campo “Texto da postagem” (e, se puder, a URL da imagem) e gere de novo.'
    );
    err.status = 422;
    err.code = 'SOCIAL_EXTRACT_BLOCKED';
    throw err;
  }

  // Preferir manchete a partir do texto (og:title costuma ser só o nome da Página)
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
