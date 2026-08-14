const axios = require('axios');
const {
  buildFacebookCookieHeader,
  facebookHtmlHeaders,
} = require('./facebookCookies');

/**
 * Lista posts de uma página do Facebook usando a sessão de YTDLP_FB_COOKIES_FILE.
 * Alternativa gratuita ao ScrapeCreators/Serper: o HTML autenticado já traz os
 * permalinks e as mensagens no JSON embutido do feed.
 */

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

/** Valor mais próximo do índice de referência, dentro de uma janela de caracteres. */
function maisProximo(lista, indice, janela = 6000) {
  let melhor = null;
  let menorDistancia = Infinity;
  for (const item of lista) {
    const distancia = Math.abs(item.indice - indice);
    if (distancia < menorDistancia && distancia <= janela) {
      menorDistancia = distancia;
      melhor = item.valor;
    }
  }
  return melhor;
}

function ehUrlDePost(url) {
  const u = String(url || '');
  if (!/facebook\.com/i.test(u)) return false;
  return (
    /\/posts\//i.test(u) ||
    /permalink\.php/i.test(u) ||
    /story_fbid=/i.test(u) ||
    /\/videos\//i.test(u) ||
    /\/reel\//i.test(u) ||
    /\/photo/i.test(u)
  );
}

/** Remove rastreadores (__cft__, __tn__, rdid) que quebram a deduplicação. */
function limparUrlPost(url) {
  try {
    const u = new URL(desescapar(url));
    u.hostname = 'www.facebook.com';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (!/^(story_fbid|id|v|fbid)$/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return desescapar(url);
  }
}

function tituloDoTexto(texto, fallback) {
  const primeiraLinha = String(texto || '')
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .find(Boolean);
  return String(primeiraLinha || fallback || 'Post do Facebook').slice(0, 120);
}

function normalizarData(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Baixa o HTML autenticado da página.
 * @returns {Promise<{ html: string, finalUrl: string, status: number }>}
 */
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

/**
 * Extrai posts do HTML autenticado. Exportado para o script de diagnóstico.
 * @returns {{ itens: Array, sinais: object }}
 */
function extrairPostsDoHtml(html, limite = 20) {
  const urls = coletarComIndice(
    html,
    /"(?:wwwURL|url|permalink_url)"\s*:\s*"(https:[^"]*facebook\.com[^"]*)"/g,
    (v) => {
      const limpo = desescapar(v);
      return ehUrlDePost(limpo) ? limpo : null;
    }
  );

  const mensagens = coletarComIndice(
    html,
    /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    (v) => {
      const t = unescapeJsonString(v).trim();
      return t.length >= 20 ? t : null;
    }
  );

  const datas = coletarComIndice(
    html,
    /"creation_time"\s*:\s*(\d{9,13})/g,
    (v) => Number(v) || null
  );

  const imagens = coletarComIndice(
    html,
    /"uri"\s*:\s*"(https:[^"]*scontent[^"]+)"/g,
    (v) => {
      const limpo = desescapar(v);
      return /rsrc\.php|static\.xx\.fbcdn/i.test(limpo) ? null : limpo;
    }
  );

  const sinais = {
    urlsEncontradas: urls.length,
    mensagens: mensagens.length,
    datas: datas.length,
    imagens: imagens.length,
    tamanhoHtml: html.length,
  };

  const itens = [];
  const vistos = new Set();
  for (const { valor, indice } of urls) {
    const url = limparUrlPost(valor);
    const chave = url.split(/[?#]/)[0].toLowerCase() + (url.match(/story_fbid=[^&]+/i)?.[0] || '');
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    const texto = maisProximo(mensagens, indice);
    const timestamp = maisProximo(datas, indice, 4000);
    const thumbnail = maisProximo(imagens, indice, 4000);
    const isVideo = /\/(reel|videos)\//i.test(url);

    itens.push({
      externalId: url,
      mediaType: isVideo ? 'video' : 'image',
      titulo: tituloDoTexto(texto, 'Post do Facebook'),
      url,
      resumo: texto ? texto.slice(0, 400) : null,
      thumbnail: thumbnail || null,
      publicadoEm: normalizarData(timestamp),
    });
    if (itens.length >= limite) break;
  }

  return { itens, sinais };
}

/**
 * Lista posts da página no mesmo formato de scrapeCreatorsFacebook.listarPostsPerfil.
 */
async function listarPostsPerfil(pageUrl, limite = 20) {
  const max = Math.min(40, Math.max(1, Number(limite) || 20));
  const { html } = await baixarHtmlPagina(pageUrl);
  const { itens, sinais } = extrairPostsDoHtml(html, max);
  console.log(
    `[fb-page] ${pageUrl}: ${itens.length} post(s) — urls=${sinais.urlsEncontradas} msgs=${sinais.mensagens} len=${sinais.tamanhoHtml}`
  );
  return itens;
}

module.exports = {
  isConfigured,
  listarPostsPerfil,
  baixarHtmlPagina,
  extrairPostsDoHtml,
};
