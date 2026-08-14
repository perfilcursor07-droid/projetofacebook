const axios = require('axios');
const {
  buildFacebookCookieHeader,
  facebookHtmlHeaders,
} = require('./facebookCookies');

/**
 * Lista posts de uma página do Facebook usando a sessão de YTDLP_FB_COOKIES_FILE.
 *
 * O HTML da página traz os PERMALINKS dos posts, mas não os textos: o feed é
 * carregado por GraphQL depois (uma página de 2,6 MB costuma ter ~13 permalinks
 * e apenas 1 "message"). Por isso o fluxo é em duas etapas — coletar os links na
 * página e abrir cada post individualmente, onde o texto vem renderizado.
 */

/** Quantos posts abrir por scan (cada um custa ~3 MB de HTML). */
const MAX_DETALHES = 12;
const CONCORRENCIA = 3;

function isConfigured() {
  return Boolean(buildFacebookCookieHeader());
}

function desescapar(texto) {
  return String(texto || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');
}

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return String(raw || '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

/** Coleta ocorrências de um regex global junto do índice onde apareceram. */
function coletarComIndice(html, regex, transform = (v) => v) {
  const out = [];
  for (const m of html.matchAll(regex)) {
    const valor = transform(m[1]);
    if (valor) out.push({ valor, indice: m.index ?? 0 });
  }
  return out;
}

/**
 * Formas de permalink de post. Aceita absoluto ou relativo — o HTML mistura os
 * dois. Exige um identificador real (pfbid/numérico) para não capturar páginas
 * de listagem como /<pagina>/photos.
 */
const PADROES_POST = [
  /(?:https:\/\/www\.facebook\.com)?\/[A-Za-z0-9.-]{2,}\/posts\/(?:pfbid[A-Za-z0-9]+|\d{6,})/g,
  /(?:https:\/\/www\.facebook\.com)?\/permalink\.php\?story_fbid=(?:pfbid[A-Za-z0-9]+|\d{6,})&(?:amp;)?id=\d+/g,
  /(?:https:\/\/www\.facebook\.com)?\/story\.php\?story_fbid=(?:pfbid[A-Za-z0-9]+|\d{6,})&(?:amp;)?id=\d+/g,
  /(?:https:\/\/www\.facebook\.com)?\/reel\/\d{6,}/g,
  /(?:https:\/\/www\.facebook\.com)?\/[A-Za-z0-9.-]{2,}\/videos\/(?:[A-Za-z0-9%-]+\/)?\d{6,}/g,
  /(?:https:\/\/www\.facebook\.com)?\/photo\/?\?fbid=\d{6,}/g,
];

/** Segmentos que nunca são nome de página. */
const SEGMENTOS_INVALIDOS = /^(ajax|api|graphql|privacy|policies|help|settings|login|watch|marketplace|groups|events|pages|photo|reel|story\.php|permalink\.php)$/i;

function normalizarUrlPost(bruto) {
  let url = desescapar(bruto).trim();
  if (url.startsWith('/')) url = `https://www.facebook.com${url}`;
  try {
    const u = new URL(url);
    u.hostname = 'www.facebook.com';
    u.protocol = 'https:';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (!/^(story_fbid|id|fbid|v)$/i.test(key)) u.searchParams.delete(key);
    }
    const primeiro = u.pathname.split('/').filter(Boolean)[0] || '';
    if (/\/posts\//i.test(u.pathname) && SEGMENTOS_INVALIDOS.test(primeiro)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * A URL é um permalink de post real (e não perfil, listagem ou tela de login)?
 * Usa cópias sem /g para não mexer no lastIndex dos padrões compartilhados.
 */
function ehUrlDePostValida(url) {
  const alvo = desescapar(url).trim();
  if (!alvo) return false;
  const casa = PADROES_POST.some((re) => new RegExp(re.source, 'i').test(alvo));
  return casa && Boolean(normalizarUrlPost(alvo));
}

/**
 * Extrai os permalinks de posts do HTML da página.
 * @returns {{ urls: string[], sinais: object }}
 */
function extrairUrlsDePosts(html) {
  // O HTML mistura barras escapadas (\/) com normais; normalizar uma vez deixa
  // os padrões simples e evita duplicar cada regex.
  const normalizado = String(html || '').replace(/\\\//g, '/');
  const urls = [];
  const vistos = new Set();
  const porPadrao = {};

  for (const re of PADROES_POST) {
    let achados = 0;
    for (const m of normalizado.matchAll(re)) {
      achados++;
      const url = normalizarUrlPost(m[0]);
      if (!url) continue;
      const chave = url.toLowerCase();
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      urls.push(url);
    }
    porPadrao[re.source.slice(0, 42)] = achados;
  }

  return {
    urls,
    sinais: { tamanhoHtml: normalizado.length, unicos: urls.length, porPadrao },
  };
}

/** Texto, imagem e data de um post já renderizado. */
function extrairDetalhesDoPost(html) {
  const mensagens = coletarComIndice(
    html,
    /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    (v) => {
      const t = unescapeJsonString(v).trim();
      return t.length >= 20 ? t : null;
    }
  ).map((m) => m.valor);
  mensagens.sort((a, b) => b.length - a.length);

  const imagem = (() => {
    for (const re of [
      /"photo_image"\s*:\s*\{[^}]*?"uri"\s*:\s*"(https:[^"]+)"/i,
      /"full_width_image"\s*:\s*\{[^}]*?"uri"\s*:\s*"(https:[^"]+)"/i,
      /"uri"\s*:\s*"(https:[^"]*scontent[^"]+)"/i,
    ]) {
      const m = html.match(re);
      if (!m?.[1]) continue;
      const candidato = desescapar(m[1]);
      if (/rsrc\.php|static\.xx\.fbcdn/i.test(candidato)) continue;
      return candidato;
    }
    return null;
  })();

  const ts = Number(html.match(/"creation_time"\s*:\s*(\d{9,13})/)?.[1]) || 0;
  const publicadoEm = ts ? new Date(ts > 10_000_000_000 ? ts : ts * 1000) : null;

  return {
    texto: mensagens[0] || null,
    imagem,
    publicadoEm: publicadoEm && !Number.isNaN(publicadoEm.getTime()) ? publicadoEm : null,
  };
}

function tituloDoTexto(texto, fallback) {
  const primeiraLinha = String(texto || '')
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .find(Boolean);
  return String(primeiraLinha || fallback || 'Post do Facebook').slice(0, 120);
}

/** GET autenticado; erros de sessão viram exceção com status. */
async function baixarHtmlPagina(pageUrl) {
  const cookie = buildFacebookCookieHeader();
  if (!cookie) {
    const err = new Error('Sessão do Facebook não configurada (YTDLP_FB_COOKIES_FILE).');
    err.status = 503;
    throw err;
  }

  const res = await axios.get(String(pageUrl || '').trim(), {
    timeout: 45000,
    maxRedirects: 5,
    headers: facebookHtmlHeaders(cookie),
    validateStatus: () => true,
  });

  const finalUrl = String(
    res.request?.res?.responseURL || res.request?.res?.responseUrl || pageUrl
  );
  if (/\/login|\/checkpoint/i.test(finalUrl)) {
    const err = new Error(
      'A sessão do Facebook caiu (redirecionou para login/checkpoint). Reexporte YTDLP_FB_COOKIES_FILE.'
    );
    err.status = 401;
    throw err;
  }
  if (res.status >= 400) {
    const err = new Error(`Facebook respondeu HTTP ${res.status} para a página.`);
    err.status = 502;
    throw err;
  }
  return { html: String(res.data || ''), finalUrl, status: res.status };
}

/** Executa tarefas com concorrência limitada, preservando a ordem da entrada. */
async function mapearComLimite(itens, limite, tarefa) {
  const resultados = new Array(itens.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (cursor < itens.length) {
      const indice = cursor++;
      resultados[indice] = await tarefa(itens[indice], indice);
    }
  });
  await Promise.all(workers);
  return resultados;
}

/**
 * Lista posts da página no mesmo formato de scrapeCreatorsFacebook.listarPostsPerfil.
 */
async function listarPostsPerfil(pageUrl, limite = 20) {
  const max = Math.min(40, Math.max(1, Number(limite) || 20));
  const { html } = await baixarHtmlPagina(pageUrl);
  const { urls, sinais } = extrairUrlsDePosts(html);

  const alvos = urls.slice(0, Math.min(max, MAX_DETALHES));
  const detalhes = await mapearComLimite(alvos, CONCORRENCIA, async (url) => {
    try {
      const res = await baixarHtmlPagina(url);
      return { url, ...extrairDetalhesDoPost(res.html) };
    } catch (err) {
      console.warn(`[fb-page] detalhe ${url.slice(0, 70)}: ${err.message}`);
      return { url, texto: null, imagem: null, publicadoEm: null };
    }
  });

  // Item sem texto vira card "conteúdo não disponível" na Biblioteca; descartar
  // é melhor do que poluir a fonte com posts vazios.
  const itens = detalhes
    .filter((d) => d.texto || d.imagem)
    .map((d) => ({
      externalId: d.url,
      mediaType: /\/(reel|videos)\//i.test(d.url) ? 'video' : 'image',
      titulo: tituloDoTexto(d.texto, 'Post do Facebook'),
      url: d.url,
      resumo: d.texto ? d.texto.slice(0, 400) : null,
      thumbnail: d.imagem || null,
      publicadoEm: d.publicadoEm,
    }));

  console.log(
    `[fb-page] ${pageUrl}: ${itens.length} post(s) de ${urls.length} link(s) — abertos=${alvos.length} htmlLen=${sinais.tamanhoHtml}`
  );
  return itens;
}

module.exports = {
  isConfigured,
  listarPostsPerfil,
  baixarHtmlPagina,
  extrairUrlsDePosts,
  extrairDetalhesDoPost,
  ehUrlDePostValida,
};
