const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (compatible; ViralizeAI/1.0; +http://localhost:3000)';

function decodificarHtml(texto) {
  if (!texto) return '';
  let t = String(texto);
  // Entidades primeiro (RSS do Google News vem com &lt;a&gt;…&lt;/a&gt;)
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  t = t
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

function extrairMeta(html, propriedade) {
  const padroes = [
    new RegExp(`<meta[^>]+property=["']${propriedade}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${propriedade}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${propriedade}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${propriedade}["']`, 'i'),
  ];
  for (const re of padroes) {
    const m = html.match(re);
    if (m?.[1]) {
      // URLs de metadados não podem passar por decodificarHtml(), que remove links.
      if (/^(?:og:image|og:url)$/i.test(propriedade)) {
        return String(m[1])
          .replace(/&amp;/gi, '&')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .trim();
      }
      return decodificarHtml(m[1]);
    }
  }
  return null;
}

function urlValida(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (lower.includes('news.google.com')) return false;
  if (lower.includes('googleusercontent.com') || lower.includes('gstatic.com')) return false;
  return /^https?:\/\//i.test(url);
}

async function resolverUrlNoticia(url) {
  if (!url) return null;
  if (!url.includes('news.google.com')) return urlValida(url) ? url : null;

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const html = String(res.data || '');
    const finalUrl = res.request?.res?.responseUrl || res.config?.url;
    if (urlValida(finalUrl) && !String(finalUrl).includes('news.google.com')) return finalUrl;

    const canonical =
      html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
    if (urlValida(canonical)) return canonical;
  } catch (err) {
    console.warn('resolverUrlNoticia:', err.message);
  }
  return null;
}

function extrairParagrafos(html) {
  const blocos = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
  const textos = [];
  for (const bloco of blocos) {
    const t = decodificarHtml(bloco);
    if (t.length >= 40) textos.push(t);
    if (textos.join(' ').length > 4500) break;
  }
  return textos;
}

async function extrairMetadadosArtigo(url) {
  const urlReal = (await resolverUrlNoticia(url)) || url;
  if (!urlReal) return null;

  try {
    const res = await axios.get(urlReal, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(res.data || '');
    const titulo = extrairMeta(html, 'og:title') || decodificarHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const resumo = extrairMeta(html, 'og:description') || extrairMeta(html, 'description') || '';
    const imagem = extrairMeta(html, 'og:image');
    const paragrafos = extrairParagrafos(html);

    return {
      url: urlReal,
      titulo: titulo || null,
      resumo: resumo || null,
      imagem: imagem && /^https?:\/\//i.test(imagem) ? imagem : null,
      trecho: paragrafos.slice(0, 8).join('\n\n'),
      veiculo: (() => {
        try {
          return new URL(urlReal).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })(),
    };
  } catch (err) {
    console.warn('extrairMetadadosArtigo:', err.message);
    return { url: urlReal, titulo: null, resumo: null, imagem: null, trecho: '', veiculo: null };
  }
}

function tokensTitulo(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function pontuarTitulo(reference, candidate) {
  const expected = new Set(tokensTitulo(reference));
  const actual = new Set(tokensTitulo(candidate));
  if (!expected.size || !actual.size) return 0;
  let common = 0;
  for (const word of expected) if (actual.has(word)) common += 1;
  if (common < Math.min(3, expected.size)) return 0;
  return common / expected.size;
}

function ordenarFontesPorTitulo(titulo, candidates) {
  return candidates
    .map((item) => ({ ...item, score: pontuarTitulo(titulo, item.titulo) }))
    .filter((item) => item.score >= 0.45 && urlValida(item.url))
    .sort((a, b) => b.score - a.score)
    .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    .slice(0, 5);
}

async function buscarFontesPorTitulo(titulo) {
  const { env } = require('../config/env');
  let candidates = [];

  if (env.braveSearchApiKey) {
    try {
      const { data } = await axios.get('https://api.search.brave.com/res/v1/news/search', {
        params: { q: titulo, count: 8 },
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': env.braveSearchApiKey,
        },
        timeout: 15000,
      });
      candidates = (data?.results || []).map((item) => ({
        titulo: item.title,
        url: item.url,
      }));
    } catch (err) {
      console.warn('buscarFontesPorTitulo Brave:', err.message);
    }
  }

  let ranked = ordenarFontesPorTitulo(titulo, candidates);
  if (!ranked.length && env.serperApiKey) {
    try {
      const { data } = await axios.post(
        'https://google.serper.dev/search',
        { q: titulo, num: 8, gl: 'br', hl: 'pt-br' },
        {
          headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      candidates = (data?.organic || []).map((item) => ({
        titulo: item.title,
        url: item.link,
      }));
      ranked = ordenarFontesPorTitulo(titulo, candidates);
    } catch (err) {
      console.warn('buscarFontesPorTitulo Serper:', err.message);
    }
  }

  return ranked;
}

/**
 * Enriquece um tópico com corpo da fonte.
 */
async function apurarTopico(topico) {
  const base = { ...topico };
  const linkOriginal = base.link || null;
  let meta = null;

  if (linkOriginal?.includes('news.google.com')) {
    const urlResolvida = await resolverUrlNoticia(linkOriginal);
    if (urlResolvida) {
      meta = await extrairMetadadosArtigo(urlResolvida);
    } else if (base.titulo) {
      const fontes = await buscarFontesPorTitulo(base.titulo);
      const melhorScore = fontes[0]?.score || 0;
      // Só considera alternativas quase tão aderentes quanto o melhor resultado;
      // uma imagem disponível não pode compensar uma notícia de outro assunto.
      for (const fonte of fontes.filter((item) => item.score >= melhorScore - 0.15)) {
        const candidate = await extrairMetadadosArtigo(fonte.url);
        if (!meta) meta = candidate;
        if (candidate?.imagem) {
          meta = candidate;
          break;
        }
      }
    }
  } else if (linkOriginal) {
    meta = await extrairMetadadosArtigo(linkOriginal);
  }

  const fontesApuracao = [];
  if (meta?.trecho || meta?.resumo) {
    fontesApuracao.push({
      veiculo: meta.veiculo || base.fonte || 'Fonte',
      url: meta.url || linkOriginal,
      titulo: meta.titulo || base.titulo,
      resumo: meta.resumo || base.resumo || '',
      trecho: meta.trecho || '',
      ehRedeSocial: Boolean(base.redeSocial),
    });
  }

  const contextoPartes = [
    `Assunto: ${base.titulo || ''}`,
    base.resumo ? `Resumo inicial: ${base.resumo}` : null,
    meta?.trecho ? `Trechos documentados da fonte:\n${meta.trecho.slice(0, 3500)}` : null,
    meta?.veiculo ? `Veículo: ${meta.veiculo}` : null,
    meta?.url ? `URL: ${meta.url}` : null,
  ].filter(Boolean);

  return {
    ...base,
    linkOriginal,
    link: meta?.url || linkOriginal,
    imagemFonte: meta?.imagem || base.imagemFonte || null,
    contextoApuracao: contextoPartes.join('\n\n'),
    fontesApuracao,
    dataReferencia: base.data || null,
    veiculo: meta?.veiculo || base.veiculo || base.fonte || null,
  };
}

module.exports = {
  decodificarHtml,
  apurarTopico,
  extrairMetadadosArtigo,
  resolverUrlNoticia,
};
