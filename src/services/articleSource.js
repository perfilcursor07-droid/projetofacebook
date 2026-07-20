const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function decodificarHtml(texto) {
  if (!texto) return '';
  let t = String(texto);
  // Entidades primeiro (RSS do Google News vem com &lt;a&gt;…&lt;/a&gt;)
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#8211;/gi, '–')
    .replace(/&#8212;/gi, '—')
    .replace(/&#8216;|&#8217;/gi, "'")
    .replace(/&#8220;|&#8221;/gi, '"')
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

function decodificarUrlMeta(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function absolutizarUrl(baseUrl, maybeRelative) {
  const raw = decodificarUrlMeta(maybeRelative);
  if (!raw) return null;
  try {
    const abs = new URL(raw, baseUrl || undefined).href;
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch {
    return null;
  }
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
      if (/^(?:og:image|og:url|twitter:image)$/i.test(propriedade)) {
        return decodificarUrlMeta(m[1]);
      }
      return decodificarHtml(m[1]);
    }
  }
  return null;
}

function imagemPareceLogoOuAvatar(url, className = '') {
  const hay = `${url} ${className}`.toLowerCase();
  return /(?:^|[\s/_-])(?:logo|avatar|icons?|sprite|emoji|favicon|badge)(?:[\s/_.-]|$)|gravatar|wp-smiley|site-logo|cropped-logo|\/ads?\/|banner-sm|[-_]ads?[-_]/i.test(
    hay
  );
}

function attrsImagem(tagOrAttrs) {
  const attrs = String(tagOrAttrs || '');
  const cls = attrs.match(/\bclass=["']([^"']+)["']/i)?.[1] || '';
  const src =
    attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1] ||
    attrs.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ||
    attrs.match(/\bsrcset=["']([^"']+)["']/i)?.[1]?.split(',')[0]?.trim()?.split(/\s+/)[0] ||
    null;
  const w = Number(attrs.match(/\bwidth=["']?(\d+)/i)?.[1] || 0);
  const h = Number(attrs.match(/\bheight=["']?(\d+)/i)?.[1] || 0);
  return { cls, src, w, h };
}

/**
 * Extrai capa editorial: og/twitter → featured WP (1ª do artigo) → JSON-LD → maior <img> útil.
 */
function extrairImagemCapa(html, pageUrl) {
  const candidatosMeta = [
    extrairMeta(html, 'og:image'),
    extrairMeta(html, 'og:image:secure_url'),
    extrairMeta(html, 'twitter:image'),
    extrairMeta(html, 'twitter:image:src'),
  ];
  for (const c of candidatosMeta) {
    const abs = absolutizarUrl(pageUrl, c);
    if (abs && !imagemPareceLogoOuAvatar(abs)) return abs;
  }

  // Recorta o HTML do artigo quando possível (evita thumbs de "relacionados")
  const artigoHtml =
    html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/class=["'][^"']*ast-article-single[^"']*["'][\s\S]{0,25000}/i)?.[0] ||
    html.match(/class=["'][^"']*entry-content[^"']*["'][\s\S]{0,25000}/i)?.[0] ||
    html;

  // WordPress featured / schema microdata — sempre a primeira do artigo
  const featuredRes = [
    /<img[^>]+class=["'][^"']*wp-post-image[^"']*["'][^>]*>/i,
    /<img[^>]+itemprop=["']image["'][^>]*>/i,
    /<img[^>]+class=["'][^"']*(?:featured(?:-image)?|post-thumbnail)[^"']*["'][^>]*>/i,
    /<img[^>]+fetchpriority=["']high["'][^>]*>/i,
  ];
  for (const re of featuredRes) {
    const tag = artigoHtml.match(re)?.[0];
    if (!tag) continue;
    const { cls, src } = attrsImagem(tag);
    const abs = absolutizarUrl(pageUrl, src);
    if (abs && !imagemPareceLogoOuAvatar(abs, cls)) return abs;
  }

  // JSON-LD image
  const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of ldBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data['@graph']) ? data['@graph'] : [])];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const img = node.image || node.thumbnailUrl;
        const raw = Array.isArray(img) ? img[0] : img;
        const url = typeof raw === 'string' ? raw : raw?.url || raw?.contentUrl || null;
        const abs = absolutizarUrl(pageUrl, url);
        if (abs && !imagemPareceLogoOuAvatar(abs)) return abs;
      }
    } catch {
      /* JSON-LD inválido — ignora */
    }
  }

  // Maior <img> candidata dentro do artigo
  let melhor = null;
  for (const m of artigoHtml.matchAll(/<img\b([^>]+)>/gi)) {
    const { cls, src, w, h } = attrsImagem(m[1]);
    const abs = absolutizarUrl(pageUrl, src);
    if (!abs || imagemPareceLogoOuAvatar(abs, cls)) continue;
    if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(abs) && !/\/uploads?\//i.test(abs)) continue;

    let score = w * h;
    if (!score) {
      const srcsetMax = [...String(m[1].match(/\bsrcset=["']([^"']+)["']/i)?.[1] || '').matchAll(/(\d+)w/g)]
        .map((x) => Number(x[1]))
        .sort((a, b) => b - a)[0];
      score = srcsetMax ? srcsetMax * 600 : 1;
    }
    if (w && w < 200 && h && h < 200) continue;
    if (/cropped-|[-_]300x300|avatar|author/i.test(abs + cls)) score *= 0.2;
    if (/wp-post-image|featured|attachment-large|size-large|hero|fetchpriority/i.test(cls + m[1])) {
      score *= 5;
    }
    // Preferir a primeira imagem boa do artigo em empate
    if (!melhor || score > melhor.score) melhor = { url: abs, score };
  }

  return melhor?.url || null;
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

function extrairAutorDoHtml(html) {
  const limpar = (s) =>
    String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^por\s+/i, '')
      .replace(/^by\s+/i, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim()
      .slice(0, 80);

  const pareceNome = (s) => {
    const v = limpar(s);
    if (!v || v.length < 3 || v.length > 70) return false;
    if (/^(redacao|redação|equipe|staff|editor|admin|agencia|agência)$/i.test(v)) return false;
    if (/\d{4}/.test(v)) return false;
    if (/\.(com|br|net|org)\b/i.test(v)) return false;
    // Prefer nomes com 2+ palavras ou nome próprio capitalizado
    return /[\p{L}]{2,}/u.test(v);
  };

  const metaAuthor =
    extrairMeta(html, 'author') ||
    extrairMeta(html, 'article:author') ||
    extrairMeta(html, 'og:article:author') ||
    extrairMeta(html, 'parsely-author') ||
    extrairMeta(html, 'byl');
  if (pareceNome(metaAuthor)) return limpar(metaAuthor);

  // JSON-LD author.name
  const ldBlocks = String(html || '').match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];
  for (const block of ldBlocks) {
    const raw = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const graph = Array.isArray(node?.['@graph']) ? node['@graph'] : [node];
        for (const item of graph) {
          const a = item?.author;
          const name =
            (typeof a === 'string' && a) ||
            a?.name ||
            (Array.isArray(a) && (a[0]?.name || a[0])) ||
            null;
          if (pareceNome(name)) return limpar(name);
        }
      }
    } catch {
      /* ignore json */
    }
  }

  // Byline visível: "Por Abby Trivett" / "By Abby Trivett"
  const byline =
    String(html || '').match(
      /(?:class|id)=["'][^"']*(?:author|byline|escritor|reporter)[^"']*["'][^>]*>[\s\S]{0,200}?Por\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+){0,3})/i
    ) ||
    String(html || '').match(
      />\s*Por\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\-]+){0,3})\s*</i
    ) ||
    String(html || '').match(
      />\s*By\s+([A-Z][\w'’.\-]+(?:\s+[A-Z][\w'’.\-]+){0,3})\s*</i
    );
  if (byline && pareceNome(byline[1])) return limpar(byline[1]);

  return null;
}

async function extrairMetadadosArtigo(url) {
  const urlReal = (await resolverUrlNoticia(url)) || url;
  if (!urlReal) return null;

  try {
    const res = await axios.get(urlReal, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(res.data || '');
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || urlReal;
    const titulo =
      extrairMeta(html, 'og:title') ||
      decodificarHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const resumo = extrairMeta(html, 'og:description') || extrairMeta(html, 'description') || '';
    const imagem = extrairImagemCapa(html, finalUrl);
    const paragrafos = extrairParagrafos(html);
    const autor = extrairAutorDoHtml(html);

    return {
      url: finalUrl,
      titulo: titulo || null,
      resumo: resumo || null,
      imagem: imagem || null,
      trecho: paragrafos.slice(0, 8).join('\n\n'),
      autor: autor || null,
      veiculo: (() => {
        try {
          return new URL(finalUrl).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })(),
    };
  } catch (err) {
    console.warn('extrairMetadadosArtigo:', err.message);
    return {
      url: urlReal,
      titulo: null,
      resumo: null,
      imagem: null,
      trecho: '',
      autor: null,
      veiculo: null,
    };
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
  // Serper free: evita caracteres estranhos e queries muito longas
  const q = String(titulo || '')
    .replace(/[^\p{L}\p{N}\s\-.:]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (q.length < 10) return [];

  let candidates = [];

  if (env.braveSearchApiKey) {
    try {
      const { data } = await axios.get('https://api.search.brave.com/res/v1/news/search', {
        params: { q, count: 8, country: 'BR', search_lang: 'pt' },
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': env.braveSearchApiKey,
        },
        timeout: 15000,
      });
      candidates = (data?.results || []).map((item) => ({
        titulo: item.title,
        url: item.url,
        snippet: item.description || '',
      }));
    } catch (err) {
      console.warn('buscarFontesPorTitulo Brave:', err.response?.data?.message || err.message);
    }
  }

  let ranked = ordenarFontesPorTitulo(titulo, candidates);

  // Evita spam de 400 no Serper free (rate limit / query rejeitada)
  if (!buscarFontesPorTitulo._serperCooldownUntil) {
    buscarFontesPorTitulo._serperCooldownUntil = 0;
  }
  const serperOk = Date.now() >= buscarFontesPorTitulo._serperCooldownUntil;

  if (!ranked.length && env.serperApiKey && serperOk) {
    try {
      const { data } = await axios.post(
        'https://google.serper.dev/search',
        { q, num: 8, gl: 'br', hl: 'pt-br' },
        {
          headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      candidates = (data?.organic || []).map((item) => ({
        titulo: item.title,
        url: item.link,
        snippet: item.snippet || '',
      }));
      ranked = ordenarFontesPorTitulo(titulo, candidates);
    } catch (err) {
      const status = err.response?.status;
      if (status === 400 || status === 429 || status === 402) {
        buscarFontesPorTitulo._serperCooldownUntil = Date.now() + 60_000;
      }
      console.warn(
        'buscarFontesPorTitulo Serper:',
        err.response?.data?.message || err.message
      );
    }
  }

  return ranked;
}

function normalizarUrlChave(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '')
      .split(/[?#]/)[0]
      .replace(/\/$/, '')
      .toLowerCase();
  }
}

function hostDaUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Busca na internet (Brave/Serper) e extrai trechos reais de 1–3 páginas
 * relacionadas ao fato — para complementar a matéria sem inventar.
 */
async function coletarFontesComplementares({ titulo, resumo, linkExcluir = null, max = 3 } = {}) {
  const queryBase = String(titulo || '').trim();
  const queryExtra = String(resumo || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const query = queryBase || queryExtra;
  if (!query || query.length < 12) return [];

  let ranked = await buscarFontesPorTitulo(query);
  if (!ranked.length && queryExtra && queryExtra !== queryBase) {
    const again = await buscarFontesPorTitulo(`${queryBase} ${queryExtra}`.trim().slice(0, 180));
    ranked = again;
  }

  const excluirUrls = new Set();
  const excluirHosts = new Set();
  if (linkExcluir) {
    excluirUrls.add(normalizarUrlChave(linkExcluir));
    const h = hostDaUrl(linkExcluir);
    if (h) excluirHosts.add(h);
  }

  const out = [];
  const vistos = new Set();

  for (const fonte of ranked) {
    if (out.length >= max) break;
    const urlKey = normalizarUrlChave(fonte.url);
    if (!urlKey || vistos.has(urlKey) || excluirUrls.has(urlKey)) continue;

    const host = hostDaUrl(fonte.url);
    if (
      /instagram\.com|facebook\.com|fb\.com|tiktok\.com|twitter\.com|x\.com|youtube\.com|youtu\.be/i.test(
        host
      )
    ) {
      continue;
    }
    // Evita o mesmo site da fonte original (queremos ângulo complementar)
    if (excluirHosts.has(host) && excluirUrls.size) {
      /* ainda permite se for o único candidato bom — não pula aqui */
    }

    vistos.add(urlKey);
    let meta = null;
    try {
      meta = await extrairMetadadosArtigo(fonte.url);
    } catch (err) {
      console.warn('coletarFontesComplementares:', err.message);
    }

    const trecho = String(meta?.trecho || '').trim();
    const resumoMeta = String(meta?.resumo || fonte.snippet || '').trim();
    if (!trecho && resumoMeta.length < 40) continue;

    out.push({
      veiculo: meta?.veiculo || host || 'Web',
      url: meta?.url || fonte.url,
      titulo: meta?.titulo || fonte.titulo || query,
      resumo: resumoMeta.slice(0, 500),
      trecho: trecho.slice(0, 2500) || resumoMeta.slice(0, 800),
      origemBusca: true,
      score: fonte.score || 0,
    });
  }

  return out;
}

function mesclarFontesApuracao(existentes, novas) {
  const out = [];
  const vistos = new Set();
  for (const f of [...(existentes || []), ...(novas || [])]) {
    if (!f) continue;
    const key = normalizarUrlChave(f.url) || `${f.veiculo}|${f.titulo}`.toLowerCase();
    if (vistos.has(key)) continue;
    vistos.add(key);
    out.push(f);
  }
  return out.slice(0, 6);
}

/**
 * Enriquece um tópico com corpo da fonte + busca web complementar.
 */
async function apurarTopico(topico) {
  const base = { ...topico };
  const linkOriginal = base.link || null;
  const ehRedeSocial = Boolean(base.redeSocial || base.tipoFonte === 'rede_social');
  const jaSocial =
    ehRedeSocial && String(base.contextoApuracao || base.resumo || '').length > 40;

  // Post FB/IG já extraído: mantém o texto original e COMPLEMENTA com busca na web.
  if (jaSocial) {
    let fontes = Array.isArray(base.fontesApuracao) ? [...base.fontesApuracao] : [];
    if (!fontes.length && (base.contextoApuracao || base.resumo)) {
      fontes.push({
        veiculo: base.fonte || base.veiculo || 'Rede social',
        url: linkOriginal,
        titulo: base.titulo,
        resumo: base.resumo || '',
        trecho: String(base.contextoApuracao || base.resumo || '').slice(0, 3500),
        ehRedeSocial: true,
      });
    }

    try {
      const complementares = await coletarFontesComplementares({
        titulo: base.titulo,
        resumo: base.resumo || String(base.contextoApuracao || '').slice(0, 160),
        linkExcluir: linkOriginal,
        max: 3,
      });
      fontes = mesclarFontesApuracao(fontes, complementares);
    } catch (err) {
      console.warn('apurarTopico (social) busca web:', err.message);
    }

    // Se a URL original for artigo web (compartilhado na rede), puxa capa + autor
    let imagemFonte = base.imagemFonte || null;
    let autor = base.autor || null;
    let veiculo = base.veiculo || base.fonte || null;
    const linkPareceArtigo =
      linkOriginal &&
      /^https?:\/\//i.test(linkOriginal) &&
      !/(?:instagram|facebook|fb\.watch|tiktok|youtube|youtu\.be)\./i.test(linkOriginal);
    if (linkPareceArtigo && (!imagemFonte || !autor)) {
      try {
        const metaSocial = await extrairMetadadosArtigo(linkOriginal);
        if (metaSocial?.imagem && !imagemFonte) imagemFonte = metaSocial.imagem;
        if (metaSocial?.autor && !autor) autor = metaSocial.autor;
        if (metaSocial?.veiculo) veiculo = metaSocial.veiculo;
      } catch (err) {
        console.warn('apurarTopico (social) meta artigo:', err.message);
      }
    }

    const blocoWeb = fontes
      .filter((f) => f.origemBusca)
      .map(
        (f, i) =>
          `Fonte web ${i + 1} (${f.veiculo}): ${f.titulo || ''}\n${String(f.trecho || f.resumo || '').slice(0, 1200)}`
      )
      .join('\n\n');

    const contexto = [
      String(base.contextoApuracao || '').trim(),
      autor ? `Autor da matéria: ${autor}` : null,
      blocoWeb
        ? `Complemento factual encontrado na internet (use só o que estiver documentado abaixo):\n${blocoWeb}`
        : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      ...base,
      linkOriginal,
      link: base.link || linkOriginal,
      titulo: base.titulo || null,
      resumo: base.resumo || null,
      imagemFonte,
      autor,
      contextoApuracao: contexto || base.contextoApuracao,
      fontesApuracao: fontes,
      dataReferencia: base.data || null,
      veiculo,
      redeSocial: true,
      tipoFonte: 'rede_social',
    };
  }

  let meta = null;

  if (linkOriginal?.includes('news.google.com')) {
    const urlResolvida = await resolverUrlNoticia(linkOriginal);
    if (urlResolvida) {
      meta = await extrairMetadadosArtigo(urlResolvida);
    } else if (base.titulo) {
      const fontes = await buscarFontesPorTitulo(base.titulo);
      const melhorScore = fontes[0]?.score || 0;
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

  // Complementa com outras reportagens sobre o mesmo fato
  try {
    const complementares = await coletarFontesComplementares({
      titulo: meta?.titulo || base.titulo,
      resumo: meta?.resumo || base.resumo,
      linkExcluir: meta?.url || linkOriginal,
      max: fontesApuracao.length ? 2 : 3,
    });
    for (const f of complementares) {
      fontesApuracao.push(f);
    }
  } catch (err) {
    console.warn('apurarTopico busca web:', err.message);
  }

  // Sem link: ainda tenta montar apuração só com busca
  if (!fontesApuracao.length && base.titulo) {
    try {
      const soBusca = await coletarFontesComplementares({
        titulo: base.titulo,
        resumo: base.resumo,
        max: 3,
      });
      fontesApuracao.push(...soBusca);
    } catch (err) {
      console.warn('apurarTopico busca sem link:', err.message);
    }
  }

  const blocoComplementar = fontesApuracao
    .filter((f) => f.origemBusca)
    .map(
      (f, i) =>
        `Fonte complementar ${i + 1} (${f.veiculo}): ${f.titulo || ''}\n${String(f.trecho || f.resumo || '').slice(0, 1200)}`
    )
    .join('\n\n');

  const contextoNovo = [
    `Assunto: ${base.titulo || meta?.titulo || ''}`,
    base.resumo ? `Resumo inicial: ${base.resumo}` : null,
    meta?.trecho ? `Trechos documentados da fonte principal:\n${meta.trecho.slice(0, 3500)}` : null,
    meta?.veiculo ? `Veículo: ${meta.veiculo}` : null,
    meta?.autor ? `Autor da matéria: ${meta.autor}` : null,
    meta?.url ? `URL: ${meta.url}` : null,
    blocoComplementar
      ? `Outras fontes na internet (só use fatos documentados):\n${blocoComplementar}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const contextoBase = String(base.contextoApuracao || '');
  const fontesFinais = fontesApuracao.length
    ? mesclarFontesApuracao(fontesApuracao, base.fontesApuracao)
    : Array.isArray(base.fontesApuracao)
      ? base.fontesApuracao
      : [];

  return {
    ...base,
    titulo: meta?.titulo || base.titulo || null,
    resumo: meta?.resumo || base.resumo || null,
    linkOriginal,
    link: meta?.url || linkOriginal,
    imagemFonte: meta?.imagem || base.imagemFonte || null,
    contextoApuracao: contextoBase.length > contextoNovo.length ? contextoBase : contextoNovo,
    fontesApuracao: fontesFinais,
    dataReferencia: base.data || null,
    veiculo: meta?.veiculo || base.veiculo || base.fonte || null,
    autor: meta?.autor || base.autor || null,
  };
}

module.exports = {
  decodificarHtml,
  apurarTopico,
  extrairMetadadosArtigo,
  extrairImagemCapa,
  resolverUrlNoticia,
  buscarFontesPorTitulo,
  coletarFontesComplementares,
};
