const axios = require('axios');
const { env } = require('../config/env');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

/** Remove redirect de login e normaliza URL de foto/post do Facebook. */
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

async function fetchHtml(url, userAgent) {
  const res = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    },
  });
  return {
    html: String(res.data || ''),
    finalUrl: res.request?.res?.responseUrl || url,
  };
}

function parseOgFromHtml(html, finalUrl) {
  const titulo = pickMeta(html, 'og:title') || pickMeta(html, 'twitter:title');
  const resumo = pickMeta(html, 'og:description') || pickMeta(html, 'twitter:description');
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
  // Crawler UA primeiro (melhor OG); se falhar imagem/texto, tenta browser UA
  let best = { url, titulo: null, texto: null, imagem: null, veiculo: null, metodo: 'og' };
  for (const ua of [CRAWLER_UA, BROWSER_UA]) {
    try {
      const { html, finalUrl } = await fetchHtml(url, ua);
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

/** oEmbed oficial (app token) — às vezes devolve HTML com legenda. */
async function extrairViaOembed(url) {
  if (!env.facebook?.appId || !env.facebook?.appSecret) return null;
  try {
    const token = `${env.facebook.appId}|${env.facebook.appSecret}`;
    const { data } = await axios.get('https://graph.facebook.com/v21.0/oembed_post', {
      params: { url, access_token: token, omitscript: true },
      timeout: 20000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(data.html || '');
    const author = data.author_name || null;
    // Extrai texto do blockquote do embed
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
    const img =
      absolutizar(url, pickMeta(html, 'og:image')) ||
      (html.match(/src=["'](https:\/\/[^"']+(?:fbcdn|scontent)[^"']+)["']/i) || [])[1] ||
      null;
    if (!texto && !img && !author) return null;
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
    return null;
  }
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

  // 1) Open Graph
  try {
    melhor = mesclarExtracao(melhor, await extrairViaOg(link));
  } catch (err) {
    console.warn('[socialPost] og:', err.message);
  }

  // 2) oEmbed (app token)
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

  // 5) yt-dlp (não em URL de login)
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
    const err = new Error(
      plataforma === 'instagram'
        ? 'O Instagram bloqueou a leitura automática. Cole a legenda do post no campo “Texto da postagem” e tente de novo.'
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
