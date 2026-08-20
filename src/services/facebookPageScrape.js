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
const MAX_DETALHES = Math.min(40, Math.max(1, Number(process.env.FB_PAGE_MAX_POSTS) || 40));
const CONCORRENCIA = Math.min(6, Math.max(1, Number(process.env.FB_PAGE_CONCORRENCIA) || 3));

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

function idDoPostNaUrl(url) {
  const alvo = String(url || '');
  return (
    alvo.match(/story_fbid=(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    alvo.match(/\/posts\/(pfbid[A-Za-z0-9]+|\d{6,})/i)?.[1] ||
    alvo.match(/[?&]fbid=(\d{6,})/i)?.[1] ||
    alvo.match(/\/(?:reel|videos)\/(\d{6,})/i)?.[1] ||
    null
  );
}

function indicesDaAncora(html, idPost) {
  if (!idPost) return [];
  const out = [];
  let indice = String(html || '').indexOf(idPost);
  while (indice !== -1 && out.length < 250) {
    out.push(indice);
    indice = String(html).indexOf(idPost, indice + 1);
  }
  return out;
}

function candidatoMaisPerto(candidatos, ancoras) {
  if (!candidatos.length) return null;
  if (!ancoras.length) return candidatos.length === 1 ? candidatos[0] : null;
  let melhor = null;
  let distancia = Infinity;
  for (const candidato of candidatos) {
    for (const ancora of ancoras) {
      const atual = Math.abs(candidato.indice - ancora);
      if (atual < distancia) {
        distancia = atual;
        melhor = candidato;
      }
    }
  }
  return melhor;
}

/** Texto, imagem e data ancorados no identificador do post aberto. */
function extrairDetalhesDoPost(html, urlAlvo = null) {
  const mensagensComIndice = coletarComIndice(
    html,
    /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    (v) => {
      const t = unescapeJsonString(v).trim();
      return t.length >= 20 ? t : null;
    }
  );
  const mensagens = mensagensComIndice.map((m) => m.valor);
  mensagens.sort((a, b) => b.length - a.length);

  let texto = mensagens[0] || null;
  const idPost = idDoPostNaUrl(urlAlvo);
  const ancoras = indicesDaAncora(html, idPost);
  if (urlAlvo) {
    // O HTML inclui posts recomendados. Esta função já seleciona a mensagem
    // mais próxima do pfbid/fbid pedido e rejeita resultados ambíguos.
    const { escolherMensagemDoPost } = require('./socialPostExtract');
    texto =
      candidatoMaisPerto(mensagensComIndice, ancoras)?.valor ||
      escolherMensagemDoPost(html, urlAlvo).texto ||
      null;
  }

  const imagem = (() => {
    const candidatos = [];
    for (const re of [
      /"photo_image"\s*:\s*\{[^}]*?"uri"\s*:\s*"(https:[^"]+)"/gi,
      /"full_width_image"\s*:\s*\{[^}]*?"uri"\s*:\s*"(https:[^"]+)"/gi,
      /"uri"\s*:\s*"(https:[^"]*scontent[^"]+)"/gi,
    ]) {
      for (const m of String(html || '').matchAll(re)) {
        const url = desescapar(m[1]);
        if (/rsrc\.php|static\.xx\.fbcdn/i.test(url)) continue;
        candidatos.push({ valor: url, indice: m.index ?? 0 });
      }
    }
    return candidatoMaisPerto(candidatos, ancoras)?.valor || null;
  })();

  const tempos = coletarComIndice(
    html,
    /"creation_time"\s*:\s*(\d{9,13})/g,
    (valor) => Number(valor) || null
  );
  const ts = Number(candidatoMaisPerto(tempos, ancoras)?.valor) || 0;
  const publicadoEm = ts ? new Date(ts > 10_000_000_000 ? ts : ts * 1000) : null;

  return {
    texto,
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

/**
 * Variantes da mesma página que costumam renderizar conjuntos diferentes de
 * permalinks. Unir as três aumenta bastante a colheita por scan.
 */
function variantesDaPagina(pageUrl) {
  const out = [];
  try {
    const u = new URL(pageUrl);
    if (/profile\.php/i.test(u.pathname)) {
      const id = u.searchParams.get('id');
      if (id) {
        out.push(`https://www.facebook.com/profile.php?id=${id}&sk=timeline`);
        out.push(`https://www.facebook.com/profile.php?id=${id}&sk=photos`);
        out.push(`https://www.facebook.com/profile.php?id=${id}&sk=videos`);
      }
    } else {
      const base = `https://www.facebook.com${u.pathname.replace(/\/+$/, '')}`;
      out.push(`${base}/posts`);
      out.push(`${base}/?sk=timeline`);
      out.push(`${base}/photos`);
      out.push(`${base}/reels`);
      out.push(`${base}/videos`);
    }
  } catch {
    /* a URL original ainda será tentada */
  }
  out.push(String(pageUrl).trim());
  return [...new Set(out)];
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

  // Etapa 1: colher permalinks de todas as variantes da página.
  const variantes = variantesDaPagina(pageUrl);
  const urls = [];
  const vistos = new Set();
  let htmlTotal = 0;
  const porVariante = {};

  const paginas = await mapearComLimite(variantes, 2, async (variante) => {
    try {
      const { html } = await baixarHtmlPagina(variante);
      const encontrados = extrairUrlsDePosts(html).urls;
      return { variante, encontrados, htmlLen: html.length };
    } catch (err) {
      // Variante indisponível não invalida o scan; a principal já basta.
      console.warn(`[fb-page] variante ${variante.slice(-40)}: ${err.message}`);
      return { variante, encontrados: [], htmlLen: 0 };
    }
  });

  // Junta na ordem de prioridade definida acima. Antes, duas requisições
  // concorrentes disputavam quem inseria primeiro e fotos de cabeçalho podiam
  // ocupar o limite antes dos posts reais.
  for (const pagina of paginas) {
    htmlTotal += pagina.htmlLen;
    porVariante[pagina.variante.replace('https://www.facebook.com', '')] = pagina.encontrados.length;
    for (const url of pagina.encontrados) {
      const chave = url.toLowerCase();
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      urls.push(url);
    }
  }

  if (!urls.length) {
    console.log(`[fb-page] ${pageUrl}: nenhum permalink — variantes=${JSON.stringify(porVariante)}`);
    return [];
  }

  const alvos = urls.slice(0, Math.min(max, MAX_DETALHES));
  const detalhes = await mapearComLimite(alvos, CONCORRENCIA, async (url) => {
    try {
      const res = await baixarHtmlPagina(url);
      return { url, ...extrairDetalhesDoPost(res.html, url) };
    } catch (err) {
      console.warn(`[fb-page] detalhe ${url.slice(0, 70)}: ${err.message}`);
      return { url, texto: null, imagem: null, publicadoEm: null };
    }
  });

  // Para criar matéria, foto de perfil/capa sem legenda não é pauta.
  const itensOrdenados = detalhes
    .filter((d) => d.texto && d.texto.trim().length >= 20)
    .map((d) => ({
      externalId: d.url,
      mediaType: /\/(reel|videos)\//i.test(d.url) ? 'video' : 'image',
      titulo: tituloDoTexto(d.texto, 'Post do Facebook'),
      url: d.url,
      texto: d.texto || null,
      resumo: d.texto ? d.texto.slice(0, 400) : null,
      thumbnail: d.imagem || null,
      publicadoEm: d.publicadoEm,
    }))
    .sort((a, b) => {
      const da = a.publicadoEm instanceof Date ? a.publicadoEm.getTime() : 0;
      const db = b.publicadoEm instanceof Date ? b.publicadoEm.getTime() : 0;
      return db - da;
    });

  const limiteRecente = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const itensRecentes = itensOrdenados.filter(
    (item) => item.publicadoEm instanceof Date && item.publicadoEm.getTime() >= limiteRecente
  );
  // Se pelo menos uma data confiável veio do Facebook, elimina cabeçalho,
  // capa e posts antigos. Sem data alguma, mantém o fallback para não zerar.
  const itens = itensRecentes.length ? itensRecentes : itensOrdenados;

  console.log(
    `[fb-page] ${pageUrl}: ${itens.length} post(s) de ${urls.length} link(s) — abertos=${alvos.length} variantes=${JSON.stringify(porVariante)} htmlLen=${htmlTotal}`
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
  variantesDaPagina,
};
