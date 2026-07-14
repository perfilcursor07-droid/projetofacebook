const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (compatible; ClipadorAI/1.0; +http://localhost:3000)';

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
    if (m?.[1]) return decodificarHtml(m[1]);
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

/**
 * Enriquece um tópico com corpo da fonte.
 */
async function apurarTopico(topico) {
  const base = { ...topico };
  const linkOriginal = base.link || null;
  let meta = null;

  if (linkOriginal) {
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
