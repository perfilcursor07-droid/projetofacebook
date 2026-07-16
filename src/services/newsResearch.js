const axios = require('axios');
const { apurarTopico, decodificarHtml } = require('./articleSource');
const { env } = require('../config/env');

const USER_AGENT = 'Mozilla/5.0 (compatible; ViralizeAI/1.0)';
const MS_DIA = 24 * 60 * 60 * 1000;

function limparResumo(texto, max = 400) {
  let t = decodificarHtml(texto || '')
    .replace(/news\.google\.com[^\s]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Google News costuma repetir o título no resumo — corta ruído típico
  t = t.replace(/^Exibir\s+/i, '').trim();
  return t.slice(0, max);
}

function limparTitulo(titulo) {
  return decodificarHtml(titulo || '')
    .replace(/\s*[-–—|]\s*[^-|–—]{2,60}$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairVeiculoDoResumoRss(descricaoHtml) {
  const raw = String(descricaoHtml || '');
  const font = raw.match(/<font[^>]*>([\s\S]*?)<\/font>/i)?.[1]
    || raw.match(/&lt;font[^&]*&gt;([\s\S]*?)&lt;\/font&gt;/i)?.[1];
  return font ? decodificarHtml(font).slice(0, 80) : null;
}

function parsearDataPub(dataStr) {
  if (!dataStr) return 0;
  const t = Date.parse(dataStr);
  return Number.isNaN(t) ? 0 : t;
}

function slugId(titulo, link) {
  const base = `${titulo || ''}|${link || ''}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  return `t_${hash.toString(16)}`;
}

function extrairItensRss(xml) {
  const itens = [];
  const blocos = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const bloco of blocos) {
    const titulo = bloco.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
    const link = bloco.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim();
    const descricao = bloco.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]?.trim();
    const data = bloco.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
    const veiculoRss = extrairVeiculoDoResumoRss(descricao);
    if (titulo && link) {
      itens.push({
        titulo: limparTitulo(titulo),
        link: link.trim(),
        resumo: limparResumo(descricao),
        data,
        dataTimestamp: parsearDataPub(data),
        veiculo: veiculoRss || undefined,
      });
    }
  }
  return itens;
}

function normalizarPeriodo(valor) {
  const str = String(valor ?? '24h').toLowerCase().trim();
  if (str === '24h' || str === '24') return { horas: 24, dias: 1 };
  if (str === '3d' || str === '3') return { dias: 3 };
  if (str === '7d' || str === '7') return { dias: 7 };
  if (str === '30d' || str === '1m' || str === '30') return { dias: 30 };
  if (str === '90d' || str === '3m' || str === '90') return { dias: 90 };
  if (str === '180d' || str === '6m' || str === '180') return { dias: 180 };
  const m = str.match(/^(\d+)\s*(d|h|m)?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (m[2] === 'h') return { horas: Math.min(Math.max(n, 1), 24 * 180), dias: Math.ceil(n / 24) };
    if (m[2] === 'm') return { dias: Math.min(Math.max(n * 30, 1), 180) };
    return { dias: Math.min(Math.max(n || 1, 1), 180) };
  }
  return { dias: 1 };
}

/** Operador when: do Google News conforme o período (máx. ~1 ano na query; filtro fino depois). */
function whenParaGoogle(periodo) {
  const cfg = typeof periodo === 'object' ? periodo : normalizarPeriodo(periodo);
  const dias = cfg.horas ? Math.ceil(cfg.horas / 24) : cfg.dias || 1;
  if (dias <= 1) return '1d';
  if (dias <= 3) return '3d';
  if (dias <= 7) return '7d';
  if (dias <= 31) return '1m';
  if (dias <= 180) return '1y';
  return '1y';
}

/** Freshness da Brave News API. */
function freshnessBrave(periodo) {
  const cfg = typeof periodo === 'object' ? periodo : normalizarPeriodo(periodo);
  const dias = cfg.horas ? Math.ceil(cfg.horas / 24) : cfg.dias || 1;
  if (dias <= 1) return 'pd';
  if (dias <= 7) return 'pw';
  if (dias <= 31) return 'pm';
  return 'py';
}

function itemEhRecente(item, periodo) {
  const cfg = typeof periodo === 'object' ? periodo : normalizarPeriodo(periodo);
  const limite = cfg.horas
    ? Date.now() - cfg.horas * 3600000
    : Date.now() - (cfg.dias || 1) * MS_DIA;
  const ts = item.dataTimestamp || parsearDataPub(item.data);
  if (!ts) return Boolean(item.recente || item.emAlta);
  return ts >= limite;
}

function titulosSimilares(a, b) {
  const na = String(a || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const nb = String(b || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (!na.length || !nb.length) return false;
  const setB = new Set(nb);
  const inter = na.filter((w) => setB.has(w)).length;
  return inter >= Math.min(3, Math.ceil(Math.min(na.length, nb.length) * 0.45));
}

function deduplicarTopicos(lista) {
  const out = [];
  for (const item of lista) {
    if (out.some((x) => titulosSimilares(x.titulo, item.titulo) || (x.link && x.link === item.link))) continue;
    out.push(item);
  }
  return out;
}

async function buscarGoogleNewsRss(termo, { when = '1d', hl = 'pt-BR', gl = 'BR', ceid = 'BR:pt-419' } = {}) {
  const q = encodeURIComponent(`${termo}${when ? ` when:${when}` : ''}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, text/xml' },
      timeout: 15000,
    });
    return extrairItensRss(String(data || '')).map((item) => ({
      ...item,
      id: slugId(item.titulo, item.link),
      nicho: termo,
      fonte: when === '1d' ? 'Google News — 24h' : 'Google News',
      veiculo: item.veiculo || 'Google News',
      tipoFonte: 'noticia',
      recente: when === '1d',
      emAlta: false,
    }));
  } catch (err) {
    console.warn('Google News RSS:', err.message);
    return [];
  }
}

async function buscarGoogleNewsEmAlta(termo) {
  const q = encodeURIComponent(`${termo} when:1d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    return extrairItensRss(String(data || ''))
      .slice(0, 8)
      .map((item) => ({
        ...item,
        id: slugId(item.titulo, item.link),
        nicho: termo,
        fonte: 'Google News — em alta',
        veiculo: item.veiculo || 'Google News',
        tipoFonte: 'noticia',
        recente: true,
        emAlta: true,
      }));
  } catch (err) {
    console.warn('Google News em alta:', err.message);
    return [];
  }
}

async function buscarBraveNews(termo, dias = 1) {
  if (!env.braveSearchApiKey) return [];
  try {
    const freshness = freshnessBrave({ dias });
    const { data } = await axios.get('https://api.search.brave.com/res/v1/news/search', {
      params: { q: termo, count: 20, freshness, country: 'BR', search_lang: 'pt' },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': env.braveSearchApiKey,
      },
      timeout: 15000,
    });
    return (data?.results || []).map((r) => ({
      id: slugId(r.title, r.url),
      titulo: limparTitulo(r.title),
      link: r.url,
      resumo: limparResumo(r.description),
      data: r.age || r.page_age || null,
      dataTimestamp: 0,
      nicho: termo,
      fonte: 'Brave News',
      veiculo: r.meta_url?.hostname || 'Brave',
      tipoFonte: 'noticia',
      recente: true,
      emAlta: false,
    }));
  } catch (err) {
    console.warn('Brave News:', err.message);
    return [];
  }
}

async function buscarSerperRedes(termo) {
  if (!env.serperApiKey) return [];
  try {
    const { data } = await axios.post(
      'https://google.serper.dev/search',
      { q: `${termo} site:instagram.com OR site:facebook.com OR site:x.com OR site:tiktok.com OR site:youtube.com`, num: 15, gl: 'br', hl: 'pt-br' },
      {
        headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    return (data?.organic || []).map((r) => ({
      id: slugId(r.title, r.link),
      titulo: limparTitulo(r.title),
      link: r.link,
      resumo: limparResumo(r.snippet),
      data: r.date || null,
      dataTimestamp: parsearDataPub(r.date),
      nicho: termo,
      fonte: 'Serper redes',
      veiculo: (() => {
        try {
          return new URL(r.link).hostname.replace(/^www\./, '');
        } catch {
          return 'Rede social';
        }
      })(),
      tipoFonte: 'rede_social',
      recente: true,
      redeSocial: true,
    }));
  } catch (err) {
    console.warn('Serper redes:', err.message);
    return [];
  }
}

/**
 * Pesquisa assuntos por palavras-chave.
 */
async function pesquisarNichos(palavrasChave, quantidadePorNicho = 8, opcoes = {}) {
  const termos = String(palavrasChave || '')
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 10);

  if (!termos.length) return [];

  const qtd = Math.min(Math.max(Number(quantidadePorNicho) || 8, 1), 20);
  const periodo = normalizarPeriodo(opcoes.periodo || (opcoes.diasRecentes ? `${opcoes.diasRecentes}d` : '24h'));
  const filtrarPeriodo = opcoes.somenteRecentes !== false && opcoes.filtrarPeriodo !== false;
  const incluirRedes = Boolean(opcoes.incluirRedesSociais);
  const somenteRedes = Boolean(opcoes.somenteRedesSociais);
  const when = whenParaGoogle(periodo);

  const lotes = [];
  for (const termo of termos) {
    if (somenteRedes) {
      lotes.push(buscarSerperRedes(termo));
      continue;
    }
    lotes.push(buscarGoogleNewsRss(termo, { when }));
    lotes.push(buscarGoogleNewsEmAlta(termo));
    lotes.push(buscarBraveNews(termo, periodo.dias || 1));
    if (incluirRedes) lotes.push(buscarSerperRedes(termo));
  }

  const resultados = (await Promise.all(lotes)).flat();
  let lista = deduplicarTopicos(resultados);

  if (filtrarPeriodo) {
    lista = lista.filter((i) => itemEhRecente(i, periodo) || i.emAlta);
  }

  lista.sort((a, b) => (b.dataTimestamp || 0) - (a.dataTimestamp || 0) || (b.emAlta ? 1 : 0) - (a.emAlta ? 1 : 0));

  const limite = Math.min(termos.length * qtd, 80);
  const selecionados = lista.slice(0, limite);

  const apurados = [];
  for (const item of selecionados.slice(0, Math.min(limite, 40))) {
    try {
      apurados.push(await apurarTopico(item));
    } catch {
      apurados.push(item);
    }
  }

  if (!apurados.length && !somenteRedes) {
    return termos.map((termo) => ({
      id: slugId(`pauta-${termo}`, termo),
      titulo: `Apuração: o que está em alta sobre ${termo}`,
      resumo: `Pauta editorial sugerida a partir do nicho “${termo}”. Gere a matéria com contexto geral e tom de Página.`,
      link: null,
      nicho: termo,
      fonte: 'Pauta editorial',
      veiculo: 'Editorial',
      tipoFonte: 'editorial',
      recente: true,
      dataTimestamp: Date.now(),
      contextoApuracao: `Nicho: ${termo}. Não há link de notícia recente; escreva uma matéria informativa/autêntica de Página sem inventar fatos específicos.`,
      fontesApuracao: [],
    }));
  }

  return apurados;
}

module.exports = {
  pesquisarNichos,
  buscarGoogleNewsRss,
  buscarGoogleNewsEmAlta,
  buscarBraveNews,
  buscarSerperRedes,
  itemEhRecente,
  titulosSimilares,
  deduplicarTopicos,
  normalizarPeriodo,
  whenParaGoogle,
  freshnessBrave,
};
