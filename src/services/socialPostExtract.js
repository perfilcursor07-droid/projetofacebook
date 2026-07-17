const axios = require('axios');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

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
    const importService = require('./importService');
    const meta = await importService.fetchLinkMetadata(url);
    // fetchLinkMetadata não devolve description — chamar yt-dlp direto
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

/**
 * Extrai texto + imagem de post Facebook / Instagram.
 */
async function extrairPostSocial(url) {
  const link = String(url || '').trim();
  const plataforma = detectarPlataformaSocial(link);
  if (!plataforma) {
    const err = new Error('Link não é de Facebook ou Instagram');
    err.status = 400;
    throw err;
  }

  let melhor = {
    url: link,
    titulo: null,
    texto: null,
    imagem: null,
    veiculo: null,
    metodo: null,
    plataforma,
  };

  // 1) Open Graph (rápido, funciona em muitos posts públicos)
  try {
    const og = await extrairViaOg(link);
    melhor = { ...melhor, ...og, plataforma };
  } catch (err) {
    console.warn('[socialPost] og:', err.message);
  }

  // 2) Jina — texto completo quando OG veio truncado ou vazio
  const textoCurto = !melhor.texto || melhor.texto.length < 120 || /\.\.\.$/.test(melhor.texto);
  if (textoCurto || !melhor.imagem) {
    try {
      const jina = await extrairViaJina(link);
      if (jina.texto && (!melhor.texto || jina.texto.length > melhor.texto.length)) {
        melhor.texto = jina.texto;
        melhor.metodo = melhor.metodo ? `${melhor.metodo}+jina` : 'jina';
      }
      if (!melhor.imagem && jina.imagem) melhor.imagem = jina.imagem;
      if (!melhor.titulo && jina.titulo) melhor.titulo = jina.titulo;
      if (!melhor.veiculo && jina.veiculo) melhor.veiculo = jina.veiculo;
    } catch (err) {
      console.warn('[socialPost] jina:', err.message);
    }
  }

  // 3) yt-dlp (útil com cookies no servidor)
  if (!melhor.texto || !melhor.imagem) {
    const ytdlp = await extrairViaYtDlp(link);
    if (ytdlp) {
      if (ytdlp.texto && (!melhor.texto || ytdlp.texto.length > melhor.texto.length)) {
        melhor.texto = ytdlp.texto;
      }
      if (!melhor.imagem && ytdlp.imagem) melhor.imagem = ytdlp.imagem;
      if (!melhor.titulo && ytdlp.titulo) melhor.titulo = ytdlp.titulo;
      if (!melhor.veiculo && ytdlp.veiculo) melhor.veiculo = ytdlp.veiculo;
      melhor.metodo = melhor.metodo ? `${melhor.metodo}+yt-dlp` : 'yt-dlp';
    }
  }

  if (!melhor.texto && !melhor.titulo) {
    const err = new Error(
      plataforma === 'instagram'
        ? 'Não foi possível ler este post do Instagram (pode ser privado ou exigir login). Tente outro link público.'
        : 'Não foi possível ler este post do Facebook (pode ser privado ou restringido). Tente outro link público.'
    );
    err.status = 422;
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
  if (!melhor.titulo) {
    melhor.titulo = `Post — ${melhor.veiculo || plataforma}`;
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
  extrairPostSocial,
  socialParaTopico,
};
