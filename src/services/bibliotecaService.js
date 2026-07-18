const crypto = require('crypto');
const BibliotecaFontes = require('../models/BibliotecaFontes');
const BibliotecaPosts = require('../models/BibliotecaPosts');
const BibliotecaAlertas = require('../models/BibliotecaAlertas');
const BibliotecaAutopilot = require('../models/BibliotecaAutopilot');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const Videos = require('../models/Videos');
const importService = require('./importService');
const materiaIaService = require('./materiaIaService');
const {
  resumirAlertaBiblioteca,
  ranquearPostsViralFacebook,
  assertDeepseek,
} = require('./deepseekService');
const { env } = require('../config/env');
const axios = require('axios');

/** external_id é VARCHAR(191); URLs do Google News passam disso → hash estável. */
function stableExternalId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.length <= 180) return s;
  return `h:${crypto.createHash('sha256').update(s).digest('hex')}`;
}

const directPublishingPosts = new Set();

function clampAutopilotInterval(minutos) {
  return Math.min(1440, Math.max(5, Number(minutos) || 30));
}

function clampAutopilotPosts(n) {
  return Math.min(5, Math.max(1, Number(n) || 1));
}

function nextAutopilotRun(intervaloMinutos) {
  return new Date(Date.now() + clampAutopilotInterval(intervaloMinutos) * 60 * 1000);
}

function normalizeUrl(raw) {
  const u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    const err = new Error('Informe uma URL válida (http/https)');
    err.status = 400;
    throw err;
  }
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    const err = new Error('URL inválida');
    err.status = 400;
    throw err;
  }
}

function detectarPlataforma(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'fb.watch') return 'facebook';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('tiktok.com')) return 'tiktok';
    // site de notícias / portal (não rede social)
    if (host && !host.includes('google.') && !host.includes('bing.')) return 'site';
  } catch {
    /* ignore */
  }
  return 'outro';
}

function extrairHandle(url, plataforma) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (plataforma === 'youtube') {
      const at = parts.find((p) => p.startsWith('@'));
      if (at) return at;
      if (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') return parts[1] || null;
      return parts[0] || null;
    }
    if (plataforma === 'instagram' || plataforma === 'tiktok') {
      return (parts[0] || '').replace(/^@/, '') || null;
    }
    if (plataforma === 'facebook') {
      return parts[0] || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function nomePadrao(plataforma, handle, url) {
  if (handle) return handle.startsWith('@') ? handle : `@${handle}`;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return plataforma;
  }
}

async function resolvePage(userId, facebookPageId) {
  if (!facebookPageId) return null;
  const page = await FacebookPages.findById(facebookPageId);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || page.facebook_account_id !== account.id) return null;
  return page;
}

function nextRun(intervaloMinutos) {
  const mins = Math.min(Math.max(Number(intervaloMinutos) || 60, 15), 24 * 60);
  return new Date(Date.now() + mins * 60_000);
}

const SCAN_LIMIT = 10;

function dataPublicacaoValida(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dedupeItens(itens) {
  const seen = new Set();
  const unicos = [];
  for (const item of itens) {
    if (!item?.url) continue;
    const key = String(item.externalId || item.url)
      .split('?')[0]
      .toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unicos.push({
      ...item,
      publicadoEm: dataPublicacaoValida(item.publicadoEm),
      ordemOriginal: unicos.length,
    });
  }

  return unicos
    .sort((a, b) => {
      const dataA = a.publicadoEm?.getTime() || 0;
      const dataB = b.publicadoEm?.getTime() || 0;
      return dataB - dataA || a.ordemOriginal - b.ordemOriginal;
    })
    .slice(0, SCAN_LIMIT)
    .map(({ ordemOriginal, ...item }) => item);
}

function normalizarTipoMidia(item) {
  const explicit = String(item?.mediaType || item?.media_type || '').toLowerCase();
  if (['video', 'reel'].includes(explicit)) return 'video';
  if (explicit === 'image') return 'image';
  if (/instagram\.com\/(reel|reels|tv)\//i.test(String(item?.url || ''))) return 'video';
  return 'post';
}

/**
 * Lista itens recentes de um canal/perfil/site.
 */
async function coletarItensFonte(fonte) {
  const plataforma = fonte.plataforma;
  const url = fonte.url;
  const erros = [];

  if (plataforma === 'youtube' || plataforma === 'tiktok') {
    try {
      return dedupeItens(await coletarViaYtDlp(url, plataforma));
    } catch (err) {
      console.warn('[biblioteca] yt-dlp:', err.message);
      erros.push(err.message);
    }
  }

  if (plataforma === 'instagram') {
    const collected = [];
    // 1) API do Instagram (usada apenas quando Bright Data não está configurada)
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarInstagramWebApi(fonte)));
      } catch (err) {
        console.warn('[biblioteca] ig api:', err.message);
        erros.push(`api: ${err.message}`);
      }
    }
    // 2) HTML / espelhos
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarInstagramHtml(fonte)));
      } catch (err) {
        console.warn('[biblioteca] ig html:', err.message);
        erros.push(`html: ${err.message}`);
      }
    }
    // 3) yt-dlp com cookies do Instagram (não usa cookies do YouTube)
    if (collected.length < 3) {
      try {
        collected.push(...(await coletarViaYtDlp(url, 'instagram')));
      } catch (err) {
        console.warn('[biblioteca] ig yt-dlp:', err.message);
        erros.push(`yt-dlp: ${err.message}`);
      }
    }
    // 4) buscas (podem falhar por crédito)
    if (collected.length < SCAN_LIMIT) {
      collected.push(...(await coletarViaSerper(fonte)));
    }
    if (collected.length < 3) {
      collected.push(...(await coletarViaBraveWeb(fonte)));
    }
    const itens = dedupeItens(collected);
    if (!itens.length) {
      const err = new Error(
        [
          'Não foi possível listar posts do Instagram.',
          erros[0] || '',
          'Valide a sessão no servidor com: node scripts/test-ig-cookies.js. Se aparecer login_required ou challenge, reexporte os cookies Netscape de uma sessão ativa do Instagram.',
        ]
          .filter(Boolean)
          .join(' ')
      );
      err.status = 422;
      throw err;
    }
    return itens;
  }

  if (plataforma === 'facebook') {
    const collected = [];
    collected.push(...(await coletarViaSerper(fonte)));
    if (collected.length < 3) collected.push(...(await coletarViaBraveWeb(fonte)));
    const itens = dedupeItens(collected);
    if (!itens.length) {
      const err = new Error(
        'Não foi possível listar posts do Facebook. Confira SERPER_API_KEY / BRAVE_SEARCH_API_KEY no .env.'
      );
      err.status = 422;
      throw err;
    }
    return itens;
  }

  if (plataforma === 'site' || plataforma === 'outro') {
    return coletarViaSite(fonte);
  }

  return [];
}

async function coletarViaYtDlp(profileUrl, plataforma) {
  const fs = require('fs');
  const { execSync } = require('child_process');
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
  if (!binary) {
    try {
      binary = execSync('which yt-dlp 2>/dev/null || where yt-dlp 2>nul', { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0];
    } catch {
      binary = null;
    }
  }
  const exec = binary ? youtubedlPkg.create(binary) : youtubedlPkg;
  const run = (u, flags) => runYtDlp(exec, u, flags, { platform: plataforma });

  let target = String(profileUrl || '').replace(/\/$/, '');
  if (plataforma === 'youtube' && !/\/(videos|streams|shorts)/i.test(target)) {
    if (/youtube\.com\/@/i.test(target)) target = `${target}/videos`;
  }
  if (plataforma === 'instagram') {
    target = target.replace(/\/(reels|tagged|followers|following)\/?$/i, '');
  }

  const data = await run(target, {
    dumpSingleJson: true,
    flatPlaylist: true,
    playlistEnd: SCAN_LIMIT,
    noWarnings: true,
    skipDownload: true,
  });

  const entries = Array.isArray(data.entries) ? data.entries : data.id ? [data] : [];
  return entries
    .map((e) => {
      const id = e.id || e.url || null;
      let link =
        e.webpage_url ||
        e.url ||
        (plataforma === 'youtube' && id ? `https://www.youtube.com/watch?v=${id}` : null);
      if (plataforma === 'instagram' && id && !/^https?:/i.test(String(link || ''))) {
        link = `https://www.instagram.com/p/${id}/`;
      }
      if (plataforma === 'instagram' && link && /instagram\.com\/(p|reel)\//i.test(link) === false && id) {
        link = `https://www.instagram.com/p/${id}/`;
      }
      if (!link) return null;
      return {
        externalId: String(id || link),
        mediaType:
          plataforma === 'instagram' &&
          ((e.vcodec && e.vcodec !== 'none') || /instagram\.com\/(reel|reels|tv)\//i.test(String(link)))
            ? 'video'
            : 'post',
        titulo: e.title || e.description?.slice(0, 80) || 'Publicação',
        url: link,
        resumo: e.description ? String(e.description).slice(0, 400) : null,
        thumbnail: e.thumbnail || (Array.isArray(e.thumbnails) ? e.thumbnails.at(-1)?.url : null) || null,
        publicadoEm: e.timestamp
          ? new Date(e.timestamp * 1000)
          : e.upload_date
            ? new Date(
                `${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}T12:00:00Z`
              )
            : null,
      };
    })
    .filter(Boolean);
}

async function coletarViaSerper(fonte) {
  if (!env.serperApiKey) return [];
  const handle = String(fonte.handle || extrairHandle(fonte.url, fonte.plataforma) || '')
    .replace(/^@/, '')
    .trim();
  let q;
  if (fonte.plataforma === 'instagram' && handle) {
    q = `site:instagram.com/${handle} (inurl:/p/ OR inurl:/reel/)`;
  } else if (fonte.plataforma === 'facebook' && handle) {
    q = `site:facebook.com/${handle}`;
  } else if (fonte.plataforma === 'site') {
    try {
      const host = new URL(fonte.url).hostname.replace(/^www\./, '');
      q = `site:${host}`;
    } catch {
      return [];
    }
  } else {
    q = fonte.nome ? String(fonte.nome) : fonte.url;
  }

  try {
    const { data } = await axios.post(
      'https://google.serper.dev/search',
      { q, num: SCAN_LIMIT, gl: 'br', hl: 'pt-br' },
      {
        headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );
    return (data?.organic || [])
      .filter((r) => r.link)
      .map((r) => ({
        externalId: r.link,
        titulo: r.title || 'Publicação',
        url: r.link,
        resumo: r.snippet || null,
        thumbnail: null,
        publicadoEm: r.date ? new Date(r.date) : null,
      }));
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    console.warn('[biblioteca] serper:', detail);
    return [];
  }
}

async function coletarViaBraveWeb(fonte) {
  if (!env.braveSearchApiKey) return [];
  const handle = String(fonte.handle || extrairHandle(fonte.url, fonte.plataforma) || '')
    .replace(/^@/, '')
    .trim();
  let q;
  if (fonte.plataforma === 'instagram' && handle) {
    q = `site:instagram.com/${handle}`;
  } else if (fonte.plataforma === 'facebook' && handle) {
    q = `site:facebook.com/${handle}`;
  } else if (fonte.plataforma === 'site') {
    try {
      q = `site:${new URL(fonte.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return [];
    }
  } else {
    return [];
  }

  try {
    const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q, count: SCAN_LIMIT, country: 'BR', search_lang: 'pt' },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': env.braveSearchApiKey,
      },
      timeout: 15_000,
    });
    const results = data?.web?.results || [];
    return results
      .filter((r) => r.url)
      .map((r) => ({
        externalId: r.url,
        titulo: r.title || 'Publicação',
        url: r.url,
        resumo: r.description || null,
        thumbnail: r.thumbnail?.src || null,
        publicadoEm: r.age ? null : null,
      }));
  } catch (err) {
    console.warn('[biblioteca] brave web:', err.message);
    return [];
  }
}

/** API autenticada do Instagram: resolve o usuário e lista o feed recente. */
async function coletarInstagramAuthenticatedApi(handle) {
  const {
    buildInstagramCookieHeader,
    bootstrapInstagramSession,
    instagramApiHeaders,
    instagramFailureReason,
    validateInstagramSession,
  } = require('./instagramCookies');

  const configuredCookies = buildInstagramCookieHeader();
  if (!configuredCookies) return [];

  const boot = await bootstrapInstagramSession(axios);
  const cookieHeader = boot?.cookieHeader || configuredCookies;
  const webHeaders = instagramApiHeaders(cookieHeader, {
    mobile: false,
    wwwClaim: boot?.claim || '0',
  });
  const mobileHeaders = instagramApiHeaders(cookieHeader, {
    mobile: true,
    wwwClaim: boot?.claim || '0',
  });
  const attempts = [];
  let user = null;

  const searchAttempts = [
    {
      label: 'topsearch-web',
      url: 'https://www.instagram.com/web/search/topsearch/',
      params: { query: handle },
      headers: webHeaders,
      users(data) {
        return (Array.isArray(data?.users) ? data.users : []).map((entry) => entry?.user || entry);
      },
    },
    {
      label: 'users-search-web',
      url: 'https://www.instagram.com/api/v1/users/search/',
      params: { q: handle, count: 10 },
      headers: webHeaders,
      users(data) {
        return Array.isArray(data?.users) ? data.users : [];
      },
    },
    {
      label: 'users-search-mobile',
      url: 'https://i.instagram.com/api/v1/users/search/',
      params: { q: handle, count: 10 },
      headers: mobileHeaders,
      users(data) {
        return Array.isArray(data?.users) ? data.users : [];
      },
    },
  ];

  for (const attempt of searchAttempts) {
    try {
      const response = await axios.get(attempt.url, {
        params: attempt.params,
        headers: attempt.headers,
        timeout: 20000,
        validateStatus: () => true,
      });
      if (response.status >= 400) {
        attempts.push(`${attempt.label}: ${instagramFailureReason(response.data, response.status)}`);
        continue;
      }
      const users = attempt.users(response.data);
      user = users.find(
        (item) => String(item?.username || '').toLowerCase() === handle.toLowerCase()
      );
      if (user?.pk || user?.id) break;
      attempts.push(`${attempt.label}: usuário não retornado`);
    } catch (err) {
      attempts.push(`${attempt.label}: ${instagramFailureReason(err.response?.data, err.response?.status || 0)}`);
    }
  }

  const userId = user?.pk || user?.id;
  if (!userId) {
    const session = await validateInstagramSession(axios, boot);
    if (!session.ok) {
      throw new Error(`sessão do Instagram rejeitada: ${session.reason}`);
    }
    throw new Error(`usuário @${handle} não encontrado (${attempts.slice(0, 2).join('; ')})`);
  }

  const feedAttempts = [
    {
      label: 'feed-web',
      url: `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(String(userId))}/`,
      headers: webHeaders,
    },
    {
      label: 'feed-mobile',
      url: `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(String(userId))}/`,
      headers: mobileHeaders,
    },
  ];
  let items = [];
  for (const attempt of feedAttempts) {
    try {
      const response = await axios.get(attempt.url, {
        params: { count: SCAN_LIMIT },
        headers: {
          ...attempt.headers,
          Referer: `https://www.instagram.com/${handle}/`,
        },
        timeout: 20000,
        validateStatus: () => true,
      });
      if (response.status >= 400) {
        attempts.push(`${attempt.label}: ${instagramFailureReason(response.data, response.status)}`);
        continue;
      }
      items = Array.isArray(response.data?.items) ? response.data.items : [];
      if (items.length) break;
      attempts.push(`${attempt.label}: feed vazio`);
    } catch (err) {
      attempts.push(`${attempt.label}: ${instagramFailureReason(err.response?.data, err.response?.status || 0)}`);
    }
  }

  if (!items.length) {
    const session = await validateInstagramSession(axios, boot);
    if (!session.ok) {
      throw new Error(`sessão do Instagram rejeitada: ${session.reason}`);
    }
    throw new Error(`feed autenticado indisponível (${attempts.slice(-2).join('; ')})`);
  }

  return items
    .map((item) => {
      const shortcode = item?.code;
      if (!shortcode) return null;
      const caption = item.caption?.text || null;
      const isReel = item.product_type === 'clips' || Number(item.media_type) === 2;
      const thumbnail =
        item.image_versions2?.candidates?.[0]?.url ||
        item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
        null;
      return {
        externalId: String(shortcode),
        mediaType: isReel ? 'video' : 'image',
        titulo: String(caption || `Post @${handle}`).slice(0, 120),
        url: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`,
        resumo: caption ? String(caption).slice(0, 400) : null,
        thumbnail,
        publicadoEm: item.taken_at ? new Date(Number(item.taken_at) * 1000) : null,
      };
    })
    .filter(Boolean)
    .slice(0, SCAN_LIMIT);
}

/** API do Instagram (sessão autenticada quando disponível, pública como fallback). */
async function coletarInstagramWebApi(fonte) {
  const handle = String(fonte.handle || extrairHandle(fonte.url, 'instagram') || '')
    .replace(/^@/, '')
    .trim();
  if (!handle) return [];

  let authenticatedError = null;
  try {
    const authenticatedItems = await coletarInstagramAuthenticatedApi(handle);
    if (authenticatedItems.length) return authenticatedItems;
  } catch (err) {
    authenticatedError = err;
    console.warn('[biblioteca] ig api autenticada:', err.message);
  }

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '129477',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `https://www.instagram.com/${handle}/`,
    Origin: 'https://www.instagram.com',
  };

  const cookieHeader = await buildInstagramCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const urls = [
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
  ];

  let user = null;
  let lastErr = null;
  for (const apiUrl of urls) {
    try {
      const { data } = await axios.get(apiUrl, {
        headers,
        timeout: 20000,
        validateStatus: (s) => s >= 200 && s < 500,
      });
      if (data?.data?.user) {
        user = data.data.user;
        break;
      }
      if (data?.user) {
        user = data.user;
        break;
      }
      lastErr = new Error(data?.message || `HTTP sem user (${apiUrl})`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!user) {
    const details = [authenticatedError?.message, lastErr?.message].filter(Boolean);
    if (details.length) throw new Error(details.join('; '));
    return [];
  }

  const edges =
    user.edge_owner_to_timeline_media?.edges ||
    user.edge_felix_video_timeline?.edges ||
    [];

  const items = [];
  for (const edge of edges) {
    const n = edge?.node;
    if (!n) continue;
    const shortcode = n.shortcode || n.code;
    if (!shortcode) continue;
    const isReel = n.product_type === 'clips' || n.is_video;
    const pathPart = isReel && !n.edge_sidecar_to_children ? 'reel' : 'p';
    const caption =
      n.edge_media_to_caption?.edges?.[0]?.node?.text ||
      n.caption?.text ||
      null;
    items.push({
      externalId: String(shortcode),
      mediaType: isReel ? 'video' : 'image',
      titulo: String(caption || `Post @${handle}`).slice(0, 120),
      url: `https://www.instagram.com/${pathPart}/${shortcode}/`,
      resumo: caption ? String(caption).slice(0, 400) : null,
      thumbnail: n.thumbnail_src || n.display_url || n.thumbnail_url || null,
      publicadoEm: n.taken_at_timestamp
        ? new Date(n.taken_at_timestamp * 1000)
        : n.taken_at
          ? new Date(Number(n.taken_at) * 1000)
          : null,
    });
  }
  return items.slice(0, SCAN_LIMIT);
}

/** Lê sessionid/csrftoken de YTDLP_IG_COOKIES_FILE (Netscape) se existir. */
async function buildInstagramCookieHeader() {
  const { buildInstagramCookieHeader: build } = require('./instagramCookies');
  return build();
}

/** Tenta ler o JSON embutido da página pública do perfil Instagram. */
async function coletarInstagramHtml(fonte) {
  const handle = String(fonte.handle || extrairHandle(fonte.url, 'instagram') || '')
    .replace(/^@/, '')
    .trim();
  if (!handle) return [];

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  };
  const cookieHeader = await buildInstagramCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const candidates = [
    `https://www.instagram.com/${handle}/`,
    `https://www.ddinstagram.com/${handle}/`,
    `https://imginn.com/${handle}/`,
  ];

  let raw = '';
  for (const profileUrl of candidates) {
    try {
      const { data: html, status } = await axios.get(profileUrl, {
        timeout: 20000,
        headers,
        validateStatus: (s) => s >= 200 && s < 500,
        maxRedirects: 5,
      });
      if (status >= 400 || !html) continue;
      raw = String(html || '');
      if (raw.length > 500) break;
    } catch (err) {
      console.warn('[biblioteca] ig fetch', profileUrl, err.message);
    }
  }
  if (!raw) return [];

  const edges = [];

  // window._sharedData (legado)
  const shared = raw.match(/window\._sharedData\s*=\s*(\{.+?\});<\/script>/s);
  if (shared) {
    try {
      const json = JSON.parse(shared[1]);
      const media =
        json?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges || [];
      for (const edge of media) {
        const n = edge.node;
        if (!n?.shortcode) continue;
        edges.push({
          externalId: n.shortcode,
          titulo: (n.edge_media_to_caption?.edges?.[0]?.node?.text || 'Post Instagram').slice(0, 120),
          url: `https://www.instagram.com/p/${n.shortcode}/`,
          resumo: n.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 400) || null,
          thumbnail: n.thumbnail_src || n.display_url || null,
          publicadoEm: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000) : null,
        });
      }
    } catch {
      /* ignore parse */
    }
  }

  // JSON embutido moderno: "shortcode":"XXXX"
  if (!edges.length) {
    const codes = [
      ...raw.matchAll(/"shortcode"\s*:\s*"([A-Za-z0-9_-]+)"/g),
      ...raw.matchAll(/\/p\/([A-Za-z0-9_-]+)\//g),
      ...raw.matchAll(/\/reel\/([A-Za-z0-9_-]+)\//g),
    ].map((m) => m[1]);
    const unique = [...new Set(codes)].slice(0, SCAN_LIMIT);
    for (const code of unique) {
      const isReel = new RegExp(`/reel/${code}/`).test(raw);
      edges.push({
        externalId: code,
        titulo: `Post @${handle}`,
        url: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`,
        resumo: null,
        thumbnail: null,
        publicadoEm: null,
      });
    }
  }

  return edges.slice(0, SCAN_LIMIT);
}

/**
 * Site / portal: RSS + busca site:domínio (últimas notícias).
 */
async function coletarViaSite(fonte) {
  const collected = [];
  const erros = [];

  try {
    collected.push(...(await coletarViaRss(fonte.url)));
  } catch (err) {
    erros.push(`rss: ${err.message}`);
  }

  if (collected.length < SCAN_LIMIT) {
    try {
      collected.push(...(await coletarSiteGoogleNews(fonte.url)));
    } catch (err) {
      erros.push(`gnews: ${err.message}`);
    }
  }

  if (collected.length < SCAN_LIMIT) {
    collected.push(...(await coletarViaSerper({ ...fonte, plataforma: 'site' })));
  }

  if (collected.length < 3) {
    collected.push(...(await coletarViaBraveWeb({ ...fonte, plataforma: 'site' })));
  }

  if (collected.length < 3) {
    try {
      collected.push(...(await coletarLinksHomepage(fonte.url)));
    } catch (err) {
      erros.push(`home: ${err.message}`);
    }
  }

  const itens = dedupeItens(collected);
  if (!itens.length) {
    const err = new Error(
      `Não encontrei notícias neste site. ${erros[0] || 'Tente a URL da home ou do feed RSS.'}`
    );
    err.status = 422;
    throw err;
  }
  return itens;
}

async function coletarViaRss(pageUrl) {
  const feeds = await descobrirFeedsRss(pageUrl);
  const itens = [];
  for (const feed of feeds.slice(0, 3)) {
    try {
      const { data } = await axios.get(feed, {
        timeout: 15000,
        headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const xml = String(data || '');
      const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
      for (const block of blocks.slice(0, SCAN_LIMIT)) {
        const titulo = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1];
        const link =
          (block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] ||
          (block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) || [])[1];
        const desc = (block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) ||
          block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) ||
          [])[1];
        const pub = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
          block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
          [])[1];
        const cleanTitle = String(titulo || '')
          .replace(/<[^>]+>/g, '')
          .trim();
        const cleanLink = String(link || '').trim();
        if (!cleanLink || !/^https?:/i.test(cleanLink)) continue;
        itens.push({
          externalId: cleanLink,
          titulo: cleanTitle || 'Notícia',
          url: cleanLink,
          resumo: desc
            ? String(desc)
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 400)
            : null,
          thumbnail: null,
          publicadoEm: pub ? new Date(pub) : null,
        });
      }
      if (itens.length >= SCAN_LIMIT) break;
    } catch (err) {
      console.warn('[biblioteca] rss feed:', err.message);
    }
  }
  return itens;
}

async function descobrirFeedsRss(pageUrl) {
  const feeds = new Set();
  try {
    const base = new URL(pageUrl);
    const candidates = [
      new URL('/feed', base).href,
      new URL('/rss', base).href,
      new URL('/feed/', base).href,
      new URL('/rss.xml', base).href,
      new URL('/atom.xml', base).href,
      new URL('/index.xml', base).href,
    ];
    candidates.forEach((f) => feeds.add(f));

    const { data: html } = await axios.get(pageUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0; +https://www.viralizeai.online)',
        Accept: 'text/html',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const links = String(html || '').matchAll(
      /<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/gi
    );
    for (const m of links) {
      const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
      if (href) {
        try {
          feeds.add(new URL(href, pageUrl).href);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    console.warn('[biblioteca] descobrir rss:', err.message);
  }
  return [...feeds];
}

async function coletarSiteGoogleNews(pageUrl) {
  let host;
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return [];
  }
  const q = encodeURIComponent(`site:${host} when:1d`);
  const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  const { data } = await axios.get(rssUrl, {
    timeout: 15000,
    headers: { Accept: 'application/rss+xml, text/xml' },
  });
  const xml = String(data || '');
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return blocks.slice(0, SCAN_LIMIT).map((block) => {
    const titulo = (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
      block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
      [])[1];
    const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1];
    const desc = (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
      block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
      [])[1];
    const pub = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1];
    return {
      externalId: String(link || '').trim(),
      titulo: String(titulo || 'Notícia')
        .replace(/<[^>]+>/g, '')
        .trim(),
      url: String(link || '').trim(),
      resumo: desc
        ? String(desc)
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 400)
        : null,
      thumbnail: null,
      publicadoEm: pub ? new Date(pub) : null,
    };
  }).filter((i) => i.url && /^https?:/i.test(i.url));
}

async function coletarLinksHomepage(pageUrl) {
  const { data: html } = await axios.get(pageUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0)',
      Accept: 'text/html',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const base = new URL(pageUrl);
  const hrefs = [...String(html || '').matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const itens = [];
  const seen = new Set();
  for (const m of hrefs) {
    let href;
    try {
      href = new URL(m[1], pageUrl).href;
    } catch {
      continue;
    }
    if (href.split('#')[0] === pageUrl.replace(/\/$/, '')) continue;
    if (!href.includes(base.hostname)) continue;
    if (/\.(jpg|png|gif|css|js|pdf|zip)(\?|$)/i.test(href)) continue;
    if (!/\/\d{4}\/|\/noticia|\/news|\/materia|\/post|\/article|\.html?$/i.test(href) && href.split('/').filter(Boolean).length < 4) {
      continue;
    }
    const key = href.split('?')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const titulo = String(m[2] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (titulo.length < 18) continue;
    itens.push({
      externalId: href,
      titulo: titulo.slice(0, 200),
      url: href,
      resumo: null,
      thumbnail: null,
      publicadoEm: null,
    });
    if (itens.length >= SCAN_LIMIT) break;
  }
  return itens;
}

async function criarFonte({
  userId,
  url,
  nome,
  notas,
  monitorar = false,
  intervaloMinutos = 60,
  facebookPageId = null,
}) {
  const normalized = normalizeUrl(url);
  const plataforma = detectarPlataforma(normalized);
  const handle = extrairHandle(normalized, plataforma);
  const displayName = String(nome || nomePadrao(plataforma, handle, normalized)).trim().slice(0, 200);

  if (facebookPageId) {
    const page = await resolvePage(userId, facebookPageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  let avatar = null;
  if (plataforma === 'youtube' || plataforma === 'tiktok') {
    try {
      const meta = await importService.fetchLinkMetadata(normalized);
      avatar = meta.thumbnail || null;
      if (!nome && meta.autor) {
        // keep displayName unless user passed nome
      }
    } catch {
      /* ignore preview */
    }
  }

  try {
    const [id] = await BibliotecaFontes.create({
      user_id: userId,
      plataforma,
      nome: displayName,
      url: normalized.slice(0, 500),
      handle,
      avatar_url: avatar,
      notas: notas ? String(notas).slice(0, 2000) : null,
      monitorar: Boolean(monitorar),
      intervalo_minutos: Math.min(Math.max(Number(intervaloMinutos) || 60, 15), 24 * 60),
      facebook_page_id: facebookPageId || null,
      proxima_execucao: monitorar ? new Date() : null,
    });
    return BibliotecaFontes.findById(id);
  } catch (err) {
    if (String(err.message || '').includes('Duplicate') || err.code === 'ER_DUP_ENTRY') {
      const e = new Error('Esta URL já está na sua biblioteca');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function atualizarFonte(userId, fonteId, patch = {}) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }

  const data = {};
  if (patch.nome != null) data.nome = String(patch.nome).trim().slice(0, 200);
  if (patch.notas != null) data.notas = String(patch.notas).slice(0, 2000);
  if (patch.monitorar != null) {
    data.monitorar = Boolean(patch.monitorar);
    if (data.monitorar && !fonte.monitorar) data.proxima_execucao = new Date();
  }
  if (patch.intervaloMinutos != null || patch.intervalo_minutos != null) {
    data.intervalo_minutos = Math.min(
      Math.max(Number(patch.intervaloMinutos ?? patch.intervalo_minutos) || 60, 15),
      24 * 60
    );
  }
  if (patch.facebookPageId != null || patch.facebook_page_id != null) {
    const pageId = patch.facebookPageId ?? patch.facebook_page_id;
    if (pageId) {
      const page = await resolvePage(userId, pageId);
      if (!page) {
        const err = new Error('Página do Facebook inválida');
        err.status = 400;
        throw err;
      }
      data.facebook_page_id = pageId;
    } else {
      data.facebook_page_id = null;
    }
  }

  await BibliotecaFontes.update(fonteId, data);
  return BibliotecaFontes.findById(fonteId);
}

async function registrarItensNovos(fonte, itens, { gerarResumoIa = true } = {}) {
  const novos = [];
  for (const item of itens) {
    const url = String(item.url || '').trim();
    if (!url) continue;
    const externalId = stableExternalId(item.externalId || url);
    const exists = await BibliotecaPosts.findByExternal(fonte.id, externalId);
    if (exists) continue;

    // também evita URL duplicada sem external_id estável
    const byUrl = await BibliotecaPosts.findByFonte(fonte.id, 50);
    if (byUrl.some((p) => p.url === url)) continue;

    const [postId] = await BibliotecaPosts.create({
      fonte_id: fonte.id,
      user_id: fonte.user_id,
      external_id: externalId,
      titulo: String(item.titulo || 'Sem título').slice(0, 500),
      url,
      resumo: item.resumo ? String(item.resumo).slice(0, 2000) : null,
      thumbnail: item.thumbnail ? String(item.thumbnail).slice(0, 1000) : null,
      media_type: normalizarTipoMidia(item),
      publicado_em: item.publicadoEm || null,
      status: 'novo',
    });

    let alertaTitulo = `${fonte.nome}: ${item.titulo || 'novo conteúdo'}`.slice(0, 300);
    let alertaResumo = item.resumo || `Novo conteúdo em ${fonte.plataforma}: ${item.url}`;

    if (gerarResumoIa && env.deepseekApiKey) {
      try {
        const ia = await resumirAlertaBiblioteca({
          plataforma: fonte.plataforma,
          nomeFonte: fonte.nome,
          titulo: item.titulo,
          url: item.url,
          snippet: item.resumo,
        });
        alertaTitulo = ia.titulo.slice(0, 300);
        alertaResumo = ia.resumo || alertaResumo;
        await BibliotecaPosts.update(postId, { resumo: alertaResumo });
      } catch (err) {
        console.warn('[biblioteca] resumo IA:', err.message);
      }
    }

    await BibliotecaAlertas.create({
      user_id: fonte.user_id,
      fonte_id: fonte.id,
      post_id: postId,
      titulo: alertaTitulo,
      resumo: alertaResumo,
      lido: false,
    });

    novos.push(await BibliotecaPosts.findById(postId));
  }
  return novos;
}

async function salvarItensFonte(fonte, itens, { silentFirst = false } = {}) {
  const jaTemPosts = (await BibliotecaPosts.findByFonte(fonte.id, 1)).length > 0;
  const lote = dedupeItens(itens).slice(0, SCAN_LIMIT);

  // Primeira varredura automática: cria uma base sem inundar os alertas.
  if (!jaTemPosts && silentFirst) {
    let salvos = 0;
    for (const item of lote) {
      const url = String(item.url || '').trim();
      if (!url) continue;
      const externalId = stableExternalId(item.externalId || url);
      const exists = await BibliotecaPosts.findByExternal(fonte.id, externalId);
      if (exists) continue;
      await BibliotecaPosts.create({
        fonte_id: fonte.id,
        user_id: fonte.user_id,
        external_id: externalId,
        titulo: String(item.titulo || 'Sem título').slice(0, 500),
        url,
        resumo: item.resumo ? String(item.resumo).slice(0, 2000) : null,
        thumbnail: item.thumbnail ? String(item.thumbnail).slice(0, 1000) : null,
        media_type: normalizarTipoMidia(item),
        publicado_em: item.publicadoEm || null,
        status: 'visto',
      });
      salvos += 1;
    }
    await BibliotecaFontes.update(fonte.id, {
      ultimo_scan: new Date(),
      proxima_execucao: nextRun(fonte.intervalo_minutos),
      ultimo_erro: null,
      ultimo_external_id: lote[0]
        ? stableExternalId(lote[0].externalId || lote[0].url)
        : fonte.ultimo_external_id,
      total_detectados: Number(fonte.total_detectados || 0) + salvos,
    });
    return { novos: [], itens: lote.length, salvos };
  }

  const novos = await registrarItensNovos(fonte, lote, { gerarResumoIa: true });
  await BibliotecaFontes.update(fonte.id, {
    ultimo_scan: new Date(),
    proxima_execucao: nextRun(fonte.intervalo_minutos),
    ultimo_erro: null,
    ultimo_external_id: lote[0]
      ? stableExternalId(lote[0].externalId || lote[0].url)
      : fonte.ultimo_external_id,
    total_detectados: Number(fonte.total_detectados || 0) + novos.length,
  });
  return { novos, itens: lote.length };
}

const BRIGHTDATA_TRIGGER_STALE_MS = 5 * 60_000;
const BRIGHTDATA_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;
let brightDataTickRunning = false;

function scrapeAgeMs(fonte) {
  const requestedAt = fonte?.scrape_requested_at
    ? new Date(fonte.scrape_requested_at).getTime()
    : 0;
  return requestedAt ? Math.max(0, Date.now() - requestedAt) : Infinity;
}

function scrapePendente(fonte) {
  return ['triggering', 'pending'].includes(String(fonte?.scrape_status || ''));
}

async function iniciarBrightDataScan(fonte, { silentFirst = false } = {}) {
  const brightdata = require('./brightdataInstagram');
  let atual = await BibliotecaFontes.findById(fonte.id);

  if (scrapePendente(atual)) {
    const staleTrigger =
      atual.scrape_status === 'triggering' &&
      scrapeAgeMs(atual) > BRIGHTDATA_TRIGGER_STALE_MS;

    if (!staleTrigger) {
      // Um clique manual transforma uma baseline automática pendente em scan visível.
      if (!silentFirst && atual.scrape_silent_first) {
        await BibliotecaFontes.update(atual.id, { scrape_silent_first: false });
      }
      return {
        pending: true,
        itens: 0,
        novos: [],
        message: 'Escaneando em segundo plano. Os posts aparecerão automaticamente.',
      };
    }

    await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
      scrape_snapshot_id: null,
      scrape_status: 'failed',
      scrape_error: 'Disparo Bright Data interrompido antes de salvar o snapshot',
      scrape_silent_first: false,
    });
  }

  const claimed = await BibliotecaFontes.tryStartScrape(fonte.id, { silentFirst });
  if (!claimed) {
    return {
      pending: true,
      itens: 0,
      novos: [],
      message: 'Já existe um escaneamento em segundo plano.',
    };
  }

  try {
    const handle = atual.handle || extrairHandle(atual.url, 'instagram');
    const result = await brightdata.dispararColeta(handle, SCAN_LIMIT);

    if (result.posts) {
      const salvo = await salvarItensFonte(atual, result.posts, { silentFirst });
      await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
        scrape_snapshot_id: null,
        scrape_status: null,
        scrape_requested_at: null,
        scrape_error: null,
        scrape_silent_first: false,
      });
      return { ...salvo, pending: false };
    }

    const snapshotSaved = await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
      scrape_snapshot_id: result.snapshotId,
      scrape_status: 'pending',
      scrape_error: null,
      proxima_execucao: nextRun(atual.intervalo_minutos),
    });
    if (!snapshotSaved) {
      throw new Error('O estado da fonte mudou durante o disparo Bright Data');
    }
    console.log(`[brightdata-ig] snapshot ${result.snapshotId} iniciado para @${handle}`);
    return {
      pending: true,
      itens: 0,
      novos: [],
      message: 'Escaneando em segundo plano. Os posts aparecerão automaticamente.',
    };
  } catch (err) {
    await BibliotecaFontes.updateScrapeIfStatus(atual.id, 'triggering', {
      scrape_snapshot_id: null,
      scrape_status: 'failed',
      scrape_error: String(err.message || err).slice(0, 1000),
      scrape_silent_first: false,
      ultimo_erro: String(err.message || err).slice(0, 1000),
      ultimo_scan: new Date(),
      proxima_execucao: nextRun(atual.intervalo_minutos),
    });
    err.status = err.status || 502;
    throw err;
  }
}

async function escanearFonte(fonte, { silentFirst = false } = {}) {
  const brightdata = require('./brightdataInstagram');
  if (fonte.plataforma === 'instagram' && brightdata.isConfigured()) {
    return iniciarBrightDataScan(fonte, { silentFirst });
  }

  const itens = await coletarItensFonte(fonte);
  return salvarItensFonte(fonte, itens, { silentFirst });
}

async function escanearAgora(userId, fonteId) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }
  try {
    // Scan manual: salva até 10 posts como novos (para gerar matéria na hora)
    return await escanearFonte(fonte, { silentFirst: false });
  } catch (err) {
    await BibliotecaFontes.update(fonte.id, {
      ultimo_erro: String(err.message || err).slice(0, 1000),
      proxima_execucao: nextRun(fonte.intervalo_minutos),
      ultimo_scan: new Date(),
    });
    throw err;
  }
}

/**
 * Gera matéria texto (ai_matters) a partir de um post da biblioteca.
 */
async function gerarTextoDePost({
  userId,
  postId,
  facebookPageId,
  tipoPublicacao = 'texto',
  publicarAgora = false,
}) {
  assertDeepseek();
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const pageId = facebookPageId || fonte?.facebook_page_id;
  if (pageId) {
    const page = await resolvePage(userId, pageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  const topico = {
    titulo: post.titulo,
    link: post.url,
    resumo: post.resumo,
    nicho: fonte?.nome || fonte?.plataforma || 'rede social',
    fonte: fonte?.nome,
    veiculo: fonte?.plataforma,
    imagemFonte: post.thumbnail,
    redeSocial: true,
    tipoFonte: 'rede_social',
  };

  const gerado = await materiaIaService.gerarCompleto({
    userId,
    facebookPageId: pageId || null,
    topico,
    tipoPublicacao,
    status: publicarAgora ? 'publicado' : 'rascunho',
  });

  await BibliotecaPosts.update(post.id, {
    status: 'gerado_texto',
    matter_id: gerado.matter?.id || null,
  });

  return gerado;
}

/**
 * Enfileira importação de vídeo do post na Fila ou no pipeline de Reel.
 */
async function gerarVideoDePost({ userId, postId, facebookPageId = null }) {
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }

  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const instagramVideo =
    fonte?.plataforma === 'instagram' &&
    (post.media_type === 'video' || /instagram\.com\/(reel|reels|tv)\//i.test(String(post.url)));

  if (instagramVideo) {
    const result = await materiaIaService.gerarDeLink({
      userId,
      url: post.url,
      facebookPageId: facebookPageId || fonte?.facebook_page_id || null,
      tipoPublicacao: 'reel',
      status: 'rascunho',
    });
    await BibliotecaPosts.update(post.id, {
      status: 'gerado_video',
      matter_id: result.matter?.id || null,
      video_id: result.video?.id || null,
    });
    return result;
  }

  if (fonte && !['youtube', 'tiktok'].includes(fonte.plataforma)) {
    const err = new Error('Este item não foi identificado como vídeo. Escaneie a fonte novamente e tente em um Reel.');
    err.status = 422;
    throw err;
  }

  const existing = await Videos.findByUrl(userId, post.url);
  if (existing) {
    await BibliotecaPosts.update(post.id, { status: 'gerado_video', video_id: existing.id });
    return { video: existing, created: false, queued: existing.status === 'pendente' };
  }

  let meta = {};
  try {
    meta = await importService.fetchLinkMetadata(post.url);
  } catch {
    meta = { titulo: post.titulo, thumbnail: post.thumbnail };
  }

  const [id] = await Videos.create({
    user_id: userId,
    origem: 'link',
    termo_busca: `biblioteca:${fonte?.nome || 'fonte'}`.slice(0, 255),
    titulo: meta.titulo || post.titulo || post.url.slice(0, 120),
    url_original: post.url,
    thumbnail: meta.thumbnail || post.thumbnail || null,
    duracao: meta.duracao || null,
    autor: meta.autor || fonte?.nome || null,
    autor_url: meta.autorUrl || fonte?.url || null,
    status: 'pendente',
    metadata: { extractor: meta.extractor, biblioteca_post_id: post.id, fonte_id: fonte?.id },
  });

  const video = await Videos.findById(id);
  importService.queueLinkImport(video);
  await BibliotecaPosts.update(post.id, { status: 'gerado_video', video_id: id });

  return { video, created: true, queued: true };
}

/** Gera e publica imediatamente, ou autoriza o Reel a publicar assim que ficar pronto. */
async function executarPublicacaoDireta({ userId, postId, facebookPageId }) {
  const pageId = Number(facebookPageId || 0);
  if (!pageId) {
    const err = new Error('Selecione a Página do Facebook antes de publicar');
    err.status = 400;
    throw err;
  }
  const page = await resolvePage(userId, pageId);
  if (!page) {
    const err = new Error('Página do Facebook inválida');
    err.status = 400;
    throw err;
  }

  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const isInstagramVideo =
    fonte?.plataforma === 'instagram' &&
    (post.media_type === 'video' ||
      /instagram\.com\/(reel|reels|tv)\//i.test(String(post.url || '')));

  // Requisição repetida após publicação: responde sem criar matéria/publicação duplicada.
  if (post.matter_id) {
    const AiMatters = require('../models/AiMatters');
    const existingMatter = await AiMatters.findById(post.matter_id);
    if (existingMatter?.status === 'publicado') {
      return {
        modo: existingMatter.tipo_publicacao === 'reel' ? 'reel' : 'foto',
        published: true,
        alreadyPublished: true,
        queued: false,
        matterId: existingMatter.id,
        message: 'Este conteúdo já foi publicado.',
      };
    }
  }

  if (isInstagramVideo) {
    const result = await gerarVideoDePost({
      userId,
      postId: post.id,
      facebookPageId: page.id,
    });
    if (!result.video?.id || !result.matter?.id) {
      const err = new Error('Não foi possível vincular o vídeo e a matéria do Reel');
      err.status = 422;
      throw err;
    }

    const reelPublisher = require('./bibliotecaReelAutopilotService');
    await reelPublisher.habilitarPublicacaoQuandoPronto({
      videoId: result.video.id,
      matterId: result.matter.id,
      bibliotecaPostId: post.id,
      facebookPageId: page.id,
      origem: 'manual',
    });
    const ready = await reelPublisher.publicarSePronto({
      videoId: result.video.id,
      clipId: result.clip?.id || null,
      matterId: result.matter.id,
    });

    return {
      modo: 'reel',
      published: Boolean(ready.published),
      alreadyPublished: Boolean(ready.alreadyPublished),
      queued: !ready.published,
      matterId: result.matter.id,
      message: ready.published
        ? 'Reel publicado no Facebook.'
        : 'Reel em processamento. Ele será publicado automaticamente quando a transcrição, a matéria e a capa ficarem prontas.',
    };
  }

  const gerado = await gerarTextoDePost({
    userId,
    postId: post.id,
    facebookPageId: page.id,
    tipoPublicacao: 'foto',
    publicarAgora: true,
  });
  const published = Boolean(
    gerado.publication || gerado.fbPostUrl || gerado.matter?.status === 'publicado'
  );
  return {
    modo: 'foto',
    published,
    queued: false,
    matterId: gerado.matter?.id || null,
    fbPostUrl: gerado.fbPostUrl || null,
    avisos: gerado.avisos || [],
    message: published
      ? 'Conteúdo publicado no Facebook.'
      : 'A matéria foi preparada, mas não foi publicada. Verifique os avisos da imagem/capa.',
  };
}

async function publicarPostDireto(options) {
  const key = `${Number(options?.userId || 0)}:${Number(options?.postId || 0)}`;
  if (directPublishingPosts.has(key)) {
    const err = new Error('Este conteúdo já está sendo preparado para publicação');
    err.status = 409;
    throw err;
  }
  directPublishingPosts.add(key);
  try {
    return await executarPublicacaoDireta(options);
  } finally {
    directPublishingPosts.delete(key);
  }
}

async function tickBrightDataSnapshots() {
  if (brightDataTickRunning) return;
  brightDataTickRunning = true;

  try {
    const brightdata = require('./brightdataInstagram');
    if (!brightdata.isConfigured()) return;

    const fontes = await BibliotecaFontes.findPendingScrapes(20);
    for (const fonte of fontes) {
      const age = scrapeAgeMs(fonte);
      const staleTrigger =
        fonte.scrape_status === 'triggering' && age > BRIGHTDATA_TRIGGER_STALE_MS;

      if (staleTrigger) {
        const message = 'Disparo Bright Data interrompido antes de salvar o snapshot';
        await BibliotecaFontes.updateScrapeIfStatus(fonte.id, 'triggering', {
          scrape_snapshot_id: null,
          scrape_status: 'failed',
          scrape_error: message,
          scrape_silent_first: false,
          ultimo_erro: message,
          ultimo_scan: new Date(),
          proxima_execucao: nextRun(fonte.intervalo_minutos),
        });
        continue;
      }

      if (fonte.scrape_status !== 'pending' || !fonte.scrape_snapshot_id) continue;
      const snapshotId = fonte.scrape_snapshot_id;

      try {
        const handle = fonte.handle || extrairHandle(fonte.url, 'instagram');
        // Faz uma consulta final antes de expirar, evitando abandonar resultado tardio.
        const result = await brightdata.obterResultado(snapshotId, handle);
        if (result.status === 'pending') {
          if (age > BRIGHTDATA_SNAPSHOT_MAX_AGE_MS) {
            const message = 'Snapshot Bright Data não concluiu em 30 minutos';
            await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
              scrape_snapshot_id: null,
              scrape_status: 'failed',
              scrape_error: message,
              scrape_silent_first: false,
              ultimo_erro: message,
              ultimo_scan: new Date(),
              proxima_execucao: nextRun(fonte.intervalo_minutos),
            });
          } else if (result.error) {
            await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
              scrape_error: String(result.error).slice(0, 1000),
            });
          }
          continue;
        }

        if (result.status === 'failed') {
          throw new Error(`Snapshot Bright Data falhou: ${result.error}`);
        }

        const salvo = await salvarItensFonte(fonte, result.posts, {
          silentFirst: Boolean(fonte.scrape_silent_first),
        });
        const completed = await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
          scrape_snapshot_id: null,
          scrape_status: null,
          scrape_requested_at: null,
          scrape_error: null,
          scrape_silent_first: false,
        });
        if (completed) {
          console.log(
            `[brightdata-ig] @${handle}: ${salvo.itens} post(s), ${salvo.novos?.length || salvo.salvos || 0} novo(s) salvos`
          );
        }
      } catch (err) {
        console.error(`[brightdata-ig] fonte #${fonte.id}:`, err.message);
        await BibliotecaFontes.updateScrapeIfCurrent(fonte.id, snapshotId, {
          scrape_snapshot_id: null,
          scrape_status: 'failed',
          scrape_error: String(err.message || err).slice(0, 1000),
          scrape_silent_first: false,
          ultimo_erro: String(err.message || err).slice(0, 1000),
          ultimo_scan: new Date(),
          proxima_execucao: nextRun(fonte.intervalo_minutos),
        });
      }
    }
  } finally {
    brightDataTickRunning = false;
  }
}

async function tickFontes() {
  const due = await BibliotecaFontes.findDue();
  for (const fonte of due) {
    try {
      await escanearFonte(fonte, { silentFirst: true });
    } catch (err) {
      console.error(`[biblioteca] fonte #${fonte.id}:`, err.message);
      await BibliotecaFontes.update(fonte.id, {
        ultimo_erro: String(err.message || err).slice(0, 1000),
        proxima_execucao: nextRun(fonte.intervalo_minutos),
        ultimo_scan: new Date(),
      });
    }
  }
}

async function salvarRankingViral(userId, ranking) {
  await BibliotecaPosts.clearViralRanking(userId);
  const analyzedAt = new Date();
  for (const item of ranking || []) {
    await BibliotecaPosts.saveViralRanking(item.id, {
      score: item.score,
      reason: item.motivo,
      analyzedAt,
    });
  }
}

async function listarMelhoresParaPublicar(userId, limit = 5) {
  return BibliotecaPosts.findMelhoresPublicacao(userId, limit);
}

async function analisarMelhoresParaPublicar(userId, limit = 5) {
  assertDeepseek();
  const candidatos = await BibliotecaPosts.findCandidatosAutopilot(userId, 30);
  if (!candidatos.length) {
    await BibliotecaPosts.clearViralRanking(userId);
    return [];
  }

  const ranking = await ranquearPostsViralFacebook(
    candidatos.map((post) => ({
      id: post.id,
      titulo: post.titulo,
      resumo: post.resumo,
      fonte: post.fonte_nome,
      plataforma: post.fonte_plataforma,
      tipo_midia: post.media_type,
    })),
    Math.min(5, Math.max(1, Number(limit) || 5))
  );
  await salvarRankingViral(userId, ranking);
  return listarMelhoresParaPublicar(userId, limit);
}

async function dashboardUsuario(userId) {
  await BibliotecaAlertas.limparOrfaos(userId).catch(() => 0);
  const [fontes, postsPorFonte, alertas, countRow, autopilot, melhores] = await Promise.all([
    BibliotecaFontes.findByUser(userId),
    BibliotecaPosts.countsByUser(userId),
    BibliotecaAlertas.findByUser(userId, { limit: 50 }),
    BibliotecaAlertas.countNaoLidos(userId),
    obterAutopilot(userId),
    listarMelhoresParaPublicar(userId, 5),
  ]);
  const fontesComContagem = (fontes || []).map((f) => ({
    ...f,
    posts_count: Number(postsPorFonte[Number(f.id)] || 0),
  }));
  return {
    fontes: fontesComContagem,
    alertas,
    alertasNaoLidos: Number(countRow?.total || 0),
    autopilot,
    melhores,
  };
}

async function detalheFonte(userId, fonteId) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }
  const [posts, countRow] = await Promise.all([
    BibliotecaPosts.findByFonte(fonte.id, 80),
    BibliotecaPosts.countByFonte(fonte.id),
  ]);
  return {
    fonte: { ...fonte, posts_count: Number(countRow?.total || 0) },
    posts,
  };
}

async function obterAutopilot(userId) {
  let row = await BibliotecaAutopilot.findByUser(userId);
  if (!row) {
    const [id] = await BibliotecaAutopilot.create({
      user_id: userId,
      facebook_page_id: null,
      ativo: false,
      intervalo_minutos: 30,
      posts_por_ciclo: 1,
      tipo_publicacao: 'foto',
      proxima_execucao: null,
      total_publicados: 0,
    });
    row = await BibliotecaAutopilot.findById(id);
  }
  return row;
}

async function salvarAutopilot(userId, body = {}) {
  const atual = await obterAutopilot(userId);
  const ativo =
    body.ativo === true || body.ativo === '1' || body.ativo === 'on' || body.ativo === 1;
  const intervalo = clampAutopilotInterval(body.intervalo_minutos ?? body.intervaloMinutos ?? atual.intervalo_minutos);
  const postsPorCiclo = clampAutopilotPosts(body.posts_por_ciclo ?? body.postsPorCiclo ?? atual.posts_por_ciclo);

  let facebookPageId = body.facebook_page_id ?? body.facebookPageId;
  if (facebookPageId === '' || facebookPageId === undefined) {
    facebookPageId = atual.facebook_page_id;
  } else if (facebookPageId == null) {
    facebookPageId = null;
  } else {
    facebookPageId = Number(facebookPageId);
  }

  if (ativo) {
    if (!facebookPageId) {
      const err = new Error('Selecione uma Página do Facebook para ativar o piloto automático');
      err.status = 400;
      throw err;
    }
    const page = await resolvePage(userId, facebookPageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
    facebookPageId = page.id;
  }

  const patch = {
    ativo: Boolean(ativo),
    facebook_page_id: facebookPageId || null,
    intervalo_minutos: intervalo,
    posts_por_ciclo: postsPorCiclo,
    tipo_publicacao: 'foto',
    ultimo_erro: null,
  };

  // Ao ativar (ou reativar), agenda o próximo ciclo em breve
  if (ativo) {
    const wasOff = !atual.ativo;
    if (wasOff || !atual.proxima_execucao) {
      patch.proxima_execucao = new Date(Date.now() + 60_000);
    }
  } else {
    patch.proxima_execucao = null;
  }

  await BibliotecaAutopilot.update(atual.id, patch);
  return obterAutopilot(userId);
}

/**
 * Gera e publica uma matéria a partir de um post (piloto — foto + Minha marca).
 */
async function publicarPostAutopilot({ userId, post, facebookPageId }) {
  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const instagramVideo =
    fonte?.plataforma === 'instagram' &&
    (post.media_type === 'video' || /instagram\.com\/(reel|reels|tv)\//i.test(String(post.url)));

  if (instagramVideo) {
    const reel = await materiaIaService.gerarDeLink({
      userId,
      url: post.url,
      facebookPageId,
      tipoPublicacao: 'reel',
      status: 'rascunho',
    });
    if (!reel.video?.id || !reel.matter?.id) {
      throw new Error('O pipeline do Reel não retornou vídeo e matéria vinculados');
    }

    const reelAutopilot = require('./bibliotecaReelAutopilotService');
    await reelAutopilot.habilitarPublicacaoAutomatica({
      videoId: reel.video.id,
      matterId: reel.matter.id,
      bibliotecaPostId: post.id,
      facebookPageId,
    });
    const ready = await reelAutopilot.publicarSePronto({
      videoId: reel.video.id,
      clipId: reel.clip?.id || null,
      matterId: reel.matter.id,
    });
    return {
      gerado: reel,
      publicado: Boolean(ready.published),
      enfileirado: !ready.published,
      contabilizado: Boolean(ready.published),
    };
  }

  const topico = {
    titulo: post.titulo,
    link: post.url,
    resumo: post.resumo,
    nicho: fonte?.nome || fonte?.plataforma || 'rede social',
    fonte: fonte?.nome,
    veiculo: fonte?.plataforma,
    imagemFonte: post.thumbnail,
    redeSocial: true,
    tipoFonte: 'rede_social',
  };

  const gerado = await materiaIaService.gerarCompleto({
    userId,
    facebookPageId,
    topico,
    tipoPublicacao: 'foto',
    status: 'publicado',
  });

  await BibliotecaPosts.update(post.id, {
    status: 'gerado_texto',
    matter_id: gerado.matter?.id || null,
  });

  const publicado = Boolean(gerado.publication || gerado.fbPostUrl || gerado.matter?.status === 'publicado');
  return { gerado, publicado, enfileirado: false };
}

async function tickAutopilot() {
  const due = await BibliotecaAutopilot.findDue();
  for (const cfg of due) {
    try {
      if (!cfg.facebook_page_id) {
        await BibliotecaAutopilot.update(cfg.id, {
          ativo: false,
          ultimo_erro: 'Piloto desativado: página do Facebook não configurada',
          proxima_execucao: null,
        });
        continue;
      }

      const page = await resolvePage(cfg.user_id, cfg.facebook_page_id);
      if (!page) {
        await BibliotecaAutopilot.update(cfg.id, {
          ativo: false,
          ultimo_erro: 'Piloto desativado: página do Facebook inválida',
          proxima_execucao: null,
        });
        continue;
      }

      // Retoma Reels cujo processamento terminou após um reinício ou entre ciclos.
      const qtd = clampAutopilotPosts(cfg.posts_por_ciclo);
      const proxima = nextAutopilotRun(cfg.intervalo_minutos);
      const reelAutopilot = require('./bibliotecaReelAutopilotService');
      const retomados = await reelAutopilot.publicarPendentesDoUsuario(cfg.user_id, qtd);

      if (retomados >= qtd) {
        await BibliotecaAutopilot.update(cfg.id, {
          ultimo_tick: new Date(),
          proxima_execucao: proxima,
          ultimo_erro: null,
        });
        continue;
      }

      assertDeepseek();

      const candidatos = await BibliotecaPosts.findCandidatosAutopilot(cfg.user_id, 30);

      if (!candidatos.length) {
        await BibliotecaAutopilot.update(cfg.id, {
          ultimo_tick: new Date(),
          proxima_execucao: proxima,
          ultimo_erro: null,
        });
        continue;
      }

      const ranking = await ranquearPostsViralFacebook(
        candidatos.map((p) => ({
          id: p.id,
          titulo: p.titulo,
          resumo: p.resumo,
          fonte: p.fonte_nome,
          plataforma: p.fonte_plataforma,
          tipo_midia: p.media_type,
        })),
        qtd
      );
      await salvarRankingViral(cfg.user_id, ranking);

      const byId = new Map(candidatos.map((p) => [Number(p.id), p]));
      let processados = retomados;
      let publicadosNaoContabilizados = 0;
      const erros = [];

      // Ordem do ranking + fallback se algum candidato falhar.
      const filaIds = ranking.map((r) => r.id);
      for (const c of candidatos) {
        if (!filaIds.includes(Number(c.id))) filaIds.push(Number(c.id));
      }

      for (const postId of filaIds) {
        if (processados >= qtd) break;
        const post = byId.get(Number(postId));
        if (!post) continue;
        try {
          const result = await publicarPostAutopilot({
            userId: cfg.user_id,
            post,
            facebookPageId: page.id,
          });
          processados += 1;
          if (result.publicado && !result.contabilizado) {
            publicadosNaoContabilizados += 1;
          } else if (!result.publicado && !result.enfileirado) {
            // Gerou rascunho (ex.: sem arte); ocupa a vaga, mas exige revisão.
            erros.push(`#${post.id}: gerado sem publicação (verifique imagem/arte)`);
          }
        } catch (err) {
          erros.push(`#${post.id}: ${err.message}`);
          try {
            await BibliotecaPosts.update(post.id, { status: 'visto' });
          } catch {
            /* ignore */
          }
        }
      }

      if (publicadosNaoContabilizados) {
        await BibliotecaAutopilot.incrementPublishedByUser(
          cfg.user_id,
          publicadosNaoContabilizados
        );
      }
      await BibliotecaAutopilot.update(cfg.id, {
        ultimo_tick: new Date(),
        proxima_execucao: proxima,
        ultimo_erro: erros.length ? erros.slice(0, 3).join(' | ').slice(0, 1000) : null,
      });
    } catch (err) {
      console.error(`[biblioteca-autopilot] user #${cfg.user_id}:`, err.message);
      await BibliotecaAutopilot.update(cfg.id, {
        ultimo_erro: String(err.message || err).slice(0, 1000),
        proxima_execucao: nextAutopilotRun(cfg.intervalo_minutos),
      });
    }
  }
}

module.exports = {
  detectarPlataforma,
  criarFonte,
  atualizarFonte,
  escanearAgora,
  gerarTextoDePost,
  gerarVideoDePost,
  publicarPostDireto,
  tickBrightDataSnapshots,
  tickFontes,
  tickAutopilot,
  dashboardUsuario,
  detalheFonte,
  listarMelhoresParaPublicar,
  analisarMelhoresParaPublicar,
  obterAutopilot,
  salvarAutopilot,
  resolvePage,
};
