/**
 * Radar Face — Google Trends (BR/gospel) + engajamento FB via Apify.
 *
 * Prioriza posts recentes (últimos 7 dias) e aceita #hashtags.
 * Plano grátis scrapeforge: ~1 run / 24h → uma busca Apify por análise.
 */
const { buscarTrendsBrasil, pareceGospel } = require('./googleTrendsService');
const apifyFacebook = require('./apifyFacebookService');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TOPICOS = 5;
const MAX_POSTS = 20;
const MAX_AGE_DAYS = 7;
const MAX_AGE_FALLBACK_DAYS = 14;

/** Cache em memória (economiza créditos / limite 1 run/dia). */
const cache = new Map();

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function scoreEngajamento(post) {
  const likes = Number(post.likes) || 0;
  const comments = Number(post.comments) || 0;
  const shares = Number(post.shares) || 0;
  return likes + comments * 2 + shares * 3;
}

/** Idade em dias; null se sem data. */
function idadeDias(post) {
  if (!post.publicadoEm) return null;
  const ms = Date.now() - new Date(post.publicadoEm).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, ms / 86400000);
}

/**
 * Bônus forte para posts novos — evita “matéria antiga” com milhares de likes acumulados.
 */
function bonusRecencia(post) {
  const days = idadeDias(post);
  if (days == null) return -15;
  if (days <= 1) return 100;
  if (days <= 2) return 70;
  if (days <= 3) return 45;
  if (days <= 7) return 20;
  if (days <= 14) return -40;
  return -120;
}

/** Engajamento por dia (posts velhos com muitos likes caem no ranking). */
function scoreVelocidade(post) {
  const eng = scoreEngajamento(post);
  const days = idadeDias(post);
  if (days == null) return eng * 0.35;
  const denom = Math.max(0.35, days);
  return eng / denom;
}

/** Prioriza português/Brasil/gospel; penaliza espanhol e off-topic. */
function relevanciaBrGospel(post) {
  const t = stripAccents(post.texto || '');
  const autor = stripAccents(post.autor || '');
  let s = 0;

  if (pareceGospel(t) || pareceGospel(autor)) s += 60;
  if (
    /\b(brasil|brasileir|sao paulo|rio de janeiro|belo horizonte|brasilia|curitiba|salvador|fortaleza|recife|porto alegre|evangelic|igreja|pastor|louvor|oracao|testemunho|irmao|irmaos)\b/.test(
      t
    )
  ) {
    s += 35;
  }
  if (/\b(nao|voce|tambem|pra|pro|gente|hoje|amanha|deus|jesus|cristo|amen)\b/.test(t)) {
    s += 20;
  }
  if ((post.hashtags || []).some((h) => pareceGospel(h))) s += 25;

  if (/\b(el |los |las |una |del |que se |exigio|jugadores|argentin|adaptacion|historia|magia|profecias)\b/.test(t)) {
    s -= 80;
  }
  if (/\b(campana|antiargentina|premier leagu|arturic)\b/.test(t)) {
    s -= 100;
  }

  return s;
}

function tituloDoPost(post, termo) {
  const texto = apifyFacebook.textoPostUtil(post.texto) || String(post.texto || '').trim();
  if (texto) {
    const primeira = texto.split(/\n/).map((l) => l.trim()).find(Boolean) || texto;
    return primeira.slice(0, 140);
  }
  if (post.url) {
    return apifyFacebook.rotuloPostPorUrl(post.url, post.autor || 'Facebook');
  }
  return `Post sobre ${termo}`;
}

function autorTexto(autor) {
  if (autor == null || autor === '') return 'Facebook';
  if (typeof autor === 'object') {
    return String(autor.name || autor.username || autor.title || 'Facebook');
  }
  return String(autor);
}

function formatarDataCurta(d) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return null;
  }
}

function cacheKey(extras, url) {
  return `radar:v8-page:${String(extras || '').trim().toLowerCase()}|${String(url || '').trim().toLowerCase()}`;
}

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function setCache(key, payload) {
  cache.set(key, { at: Date.now(), payload });
}

function parseTermosUsuario(palavrasExtras) {
  return String(palavrasExtras || '')
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter((t) => {
      if (!t) return false;
      if (t.startsWith('#')) return t.length >= 2;
      return t.length >= 3;
    })
    .slice(0, 5);
}

/** URL de página/perfil FB (não é post/reel/foto). */
function isFacebookPageUrl(url) {
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) return false;
  try {
    const { isSocialPostUrl, detectarPlataformaSocial } = require('./socialPostExtract');
    if (detectarPlataformaSocial(link) !== 'facebook') return false;
    if (isSocialPostUrl(link)) return false;
    const u = new URL(link);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (/^\/(watch|marketplace|groups|events|gaming|reel|reels|stories)(\/|$)/i.test(path)) {
      return false;
    }
    // /NomeDaPagina ou /pages/... ou profile.php?id=
    if (/profile\.php/i.test(path) && u.searchParams.get('id')) return true;
    if (/^\/pages\//i.test(path)) return true;
    if (/^\/people\//i.test(path)) return true;
    if (/^\/[A-Za-z0-9.\-_]+$/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function extrairHandlePagina(url) {
  try {
    const u = new URL(String(url || '').trim());
    const id = u.searchParams.get('id');
    if (id) return id;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    if (/^pages$/i.test(parts[0]) && parts[1]) {
      // /pages/Name/123 or /pages/category/Name
      return parts[parts.length - 1].replace(/[^\w.\-]/g, '') || parts[1];
    }
    if (/^people$/i.test(parts[0]) && parts[1]) return parts[1];
    const skip = new Set(['pg', 'public']);
    const handle = parts.find((p) => !skip.has(p.toLowerCase()));
    return handle ? decodeURIComponent(handle) : null;
  } catch {
    return null;
  }
}

async function metaLeveDaUrl(url) {
  try {
    const axios = require('axios');
    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent':
          'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        Accept: 'text/html',
      },
      maxRedirects: 3,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(data || '');
    const ogTitle =
      html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i)?.[1] ||
      '';
    const ogDesc =
      html.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/content=["']([^"']+)["']\s+property=["']og:description["']/i)?.[1] ||
      '';
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
    const decode = (s) =>
      String(s || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    return {
      titulo: decode(ogTitle || title).slice(0, 160),
      descricao: decode(ogDesc).slice(0, 400),
    };
  } catch {
    return { titulo: '', descricao: '' };
  }
}

/**
 * A partir de um link de post OU página, monta termos de busca para o radar.
 */
async function resolverTermosDoLink(url) {
  const link = String(url || '').trim();
  const avisos = [];
  const { isSocialPostUrl, normalizarUrlSocial, extrairPostSocial } = require('./socialPostExtract');
  const deepseek = require('./deepseekService');
  const normalizado = normalizarUrlSocial(link);

  if (isSocialPostUrl(normalizado)) {
    avisos.push('Link de postagem detectado — a IA lê a legenda e busca o que está em alta no mesmo tema.');
    let social = null;
    try {
      social = await extrairPostSocial(normalizado, {});
    } catch (err) {
      avisos.push(`Não deu para ler o post automaticamente (${err.message}). Usando o link como pista.`);
    }
    const texto = String(social?.texto || '').trim();
    const pagina = String(social?.veiculo || social?.autor || '').trim();
    const hashtags = apifyFacebook.extrairHashtags(texto);

    if (texto.length >= 40 && envTemDeepseek()) {
      try {
        const extraido = await deepseek.extrairTermosRadar({
          texto,
          pagina,
          url: normalizado,
        });
        const termos = [
          ...(extraido.termos || []),
          ...hashtags.slice(0, 2),
        ].filter(Boolean);
        return {
          tipo: 'post',
          termos: uniqTermos(termos).slice(0, 5),
          tema: extraido.tema || tituloCurto(texto),
          resumo: extraido.resumo || texto.slice(0, 180),
          fonteUrl: normalizado,
          avisos,
        };
      } catch (err) {
        avisos.push(`IA de termos: ${err.message}`);
      }
    }

    const fallback = uniqTermos([
      ...hashtags,
      ...keywordsHeuristico(texto),
      pagina,
    ]).slice(0, 5);
    if (!fallback.length) {
      const err = new Error(
        'Não consegui extrair o tema deste post. Cole a legenda em “Termos” ou tente outro link.'
      );
      err.status = 422;
      throw err;
    }
    return {
      tipo: 'post',
      termos: fallback,
      tema: tituloCurto(texto) || fallback[0],
      resumo: texto.slice(0, 180) || '',
      fonteUrl: normalizado,
      avisos,
    };
  }

  if (isFacebookPageUrl(normalizado)) {
    const handle = extrairHandlePagina(normalizado);
    avisos.push(
      `Link de página detectado (${handle || 'FB'}) — vamos listar os posts DESSA página e ranquear os que mais engajam.`
    );
    const meta = await metaLeveDaUrl(normalizado);
    const paginaNome = meta.titulo || handle || 'Página Facebook';
    const textoBase = [paginaNome, meta.descricao, handle].filter(Boolean).join('\n');

    if (envTemDeepseek()) {
      try {
        const extraido = await deepseek.extrairTermosRadar({
          texto: textoBase,
          pagina: paginaNome,
          url: normalizado,
        });
        const termos = uniqTermos([
          ...(extraido.termos || []),
          handle && !/^\d+$/.test(handle) ? handle.replace(/[.\-_]/g, ' ') : null,
        ]).slice(0, 5);
        return {
          tipo: 'pagina',
          termos,
          tema: extraido.tema || paginaNome,
          paginaNome,
          handle: handle || null,
          resumo: extraido.resumo || meta.descricao || `Posts no tema de ${paginaNome}`,
          fonteUrl: normalizado,
          avisos,
        };
      } catch (err) {
        avisos.push(`IA de termos: ${err.message}`);
      }
    }

    const termos = uniqTermos([
      handle && !/^\d+$/.test(handle) ? handle.replace(/[.\-_]/g, ' ') : null,
      ...keywordsHeuristico(meta.descricao || meta.titulo),
      '#gospel',
    ]).slice(0, 5);
    return {
      tipo: 'pagina',
      termos,
      tema: paginaNome,
      paginaNome,
      handle: handle || null,
      resumo: meta.descricao || `Tema da página ${paginaNome}`,
      fonteUrl: normalizado,
      avisos,
    };
  }

  // Notícia / outro link: usa título OG + IA
  avisos.push('Link detectado — extraindo tema para buscar o que está em alta.');
  const meta = await metaLeveDaUrl(normalizado);
  const texto = [meta.titulo, meta.descricao].filter(Boolean).join('\n');
  if (!texto) {
    const err = new Error(
      'Não reconheci este link. Use um post do Facebook, o link da página, ou preencha os termos manualmente.'
    );
    err.status = 422;
    throw err;
  }
  if (envTemDeepseek()) {
    try {
      const extraido = await deepseek.extrairTermosRadar({
        texto,
        url: normalizado,
      });
      return {
        tipo: 'link',
        termos: uniqTermos(extraido.termos || [extraido.tema]).slice(0, 5),
        tema: extraido.tema || meta.titulo,
        resumo: extraido.resumo || meta.descricao,
        fonteUrl: normalizado,
        avisos,
      };
    } catch (err) {
      avisos.push(`IA de termos: ${err.message}`);
    }
  }
  return {
    tipo: 'link',
    termos: uniqTermos([meta.titulo, ...keywordsHeuristico(texto)]).slice(0, 5),
    tema: meta.titulo,
    resumo: meta.descricao,
    fonteUrl: normalizado,
    avisos,
  };
}

function envTemDeepseek() {
  try {
    const { env } = require('../config/env');
    return Boolean(env.deepseekApiKey);
  } catch {
    return false;
  }
}

function uniqTermos(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function tituloCurto(texto) {
  const linha = String(texto || '')
    .split(/\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return linha ? linha.slice(0, 120) : '';
}

function keywordsHeuristico(texto) {
  const stop = new Set([
    'para', 'com', 'sobre', 'essa', 'esse', 'esta', 'este', 'pela', 'pelo', 'uma', 'uns',
    'mais', 'menos', 'quando', 'onde', 'como', 'também', 'tambem', 'ainda', 'depois',
    'antes', 'hoje', 'ontem', 'agora', 'muito', 'muita', 'facebook', 'instagram', 'https',
  ]);
  return String(texto || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^\p{L}\p{N}#\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => {
      if (w.startsWith('#') && w.length >= 3) return true;
      return w.length > 3 && !stop.has(w.toLowerCase());
    })
    .slice(0, 8);
}

function postParaTopico(post, termoTrends, crescimento) {
  const autor = autorTexto(post.autor);
  const hashtags = post.hashtags || apifyFacebook.extrairHashtags(post.texto);
  const publicadoEm = post.publicadoEm ? new Date(post.publicadoEm).toISOString() : null;
  const textoUtil = apifyFacebook.textoPostUtil(post.texto);
  const indiceWeb = post.indiceWeb ?? (post.viaWeb ? apifyFacebook.qualidadeIndiceWeb(post) : 0);
  const calor = post.viaWeb
    ? indiceWeb + Math.min(20, Number(crescimento) || 0)
    : (post.velocidade || 0) +
      Math.max(0, post.relevancia || 0) +
      Math.max(0, post.recencia || 0) +
      Math.min(50, Number(crescimento) || 0);
  return {
    titulo: tituloDoPost(post, termoTrends),
    resumo: (textoUtil || String(post.texto || '')).slice(0, 400),
    link: post.url || null,
    fonte: autor,
    veiculo: autor,
    tipoFonte: post.url ? 'rede_social' : 'trend',
    redeSocial: Boolean(post.url),
    emAlta: true,
    emAltaAgora: true,
    termoTrends,
    crescimentoTrends: crescimento,
    likes: post.likes || 0,
    comments: post.comments || 0,
    shares: post.shares || 0,
    scoreEngajamento: post.score || 0,
    relevancia: post.relevancia || 0,
    hashtags,
    publicadoEm,
    publicadoEmLabel: formatarDataCurta(post.publicadoEm),
    idadeDias: idadeDias(post) != null ? Math.round(idadeDias(post) * 10) / 10 : null,
    viaWeb: Boolean(post.viaWeb),
    calor,
  };
}

/**
 * @param {{ palavrasExtras?: string, force?: boolean, url?: string }} [opts]
 */
async function analisarRadarFace(opts = {}) {
  const palavrasExtras = String(opts.palavrasExtras || '').trim();
  const url = String(opts.url || opts.link || '').trim();
  const key = cacheKey(palavrasExtras, url);
  if (!opts.force) {
    const cached = getCache(key);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const avisos = [];
  let origemLink = null;

  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      const err = new Error('Informe um link válido (http ou https)');
      err.status = 400;
      throw err;
    }
    origemLink = await resolverTermosDoLink(url);
    avisos.push(...(origemLink.avisos || []));
  }

  if (!apifyFacebook.isConfigured()) {
    avisos.push('APIFY_TOKEN não configurada — configure no .env para medir engajamento no Facebook.');
  }

  const trends = await buscarTrendsBrasil({
    limit: 12,
    onlyGospel: origemLink?.tipo !== 'pagina',
  });
  const extrasManuais = parseTermosUsuario(palavrasExtras);
  const extrasLink = origemLink?.tipo === 'pagina' ? [] : origemLink?.termos || [];
  const extras = uniqTermos([...extrasManuais, ...extrasLink]).slice(0, 5);

  const modoPagina = origemLink?.tipo === 'pagina' && origemLink?.fonteUrl;
  const termoPrincipal = modoPagina
    ? origemLink.tema || extrasManuais[0] || 'página'
    : extras[0] || origemLink?.tema || trends[0]?.termo || '#gospel';
  const crescimentoPrincipal =
    extras[0] != null || origemLink ? 999 : Number(trends[0]?.crescimento) || 50;

  let queryApify = modoPagina
    ? `página: ${origemLink.fonteUrl}`
    : apifyFacebook.montarQueryBrasilGospel(termoPrincipal);

  if (modoPagina) {
    avisos.push(
      `Lendo posts DA PÁGINA (não busca genérica no Feed): ${origemLink.fonteUrl}`
    );
  } else {
    avisos.push(
      `Busca FB recente (até ${MAX_AGE_DAYS} dias): “${queryApify}”. Aceita #hashtags.`
    );
  }
  if (origemLink?.tema) {
    avisos.push(`Tema do link: ${origemLink.tema}`);
  }

  let posts = [];
  try {
    if (modoPagina) {
      // Web (Brave/Serper) primeiro — páginas que o Apify marca como “private”
      // ainda costumam ter posts no índice de busca; não gasta o free tier.
      const pageResult = await apifyFacebook.buscarPostsDaPagina(origemLink.fonteUrl, {
        limit: Math.max(MAX_POSTS, 15),
        maxAgeDays: Math.max(MAX_AGE_DAYS, 14),
        aliases: [origemLink.paginaNome, origemLink.handle, origemLink.tema].filter(Boolean),
      });
      posts = pageResult.posts || [];
      const fonteColeta = pageResult.fonte || 'none';
      avisos.push(
        `${posts.length} post(s) coletados da página${pageResult.handle ? ` (@${pageResult.handle})` : ''} via ${fonteColeta}.`
      );
      if (fonteColeta === 'web-index') {
        avisos.push(
          'Apify tratou a página como privada/indisponível — usamos links indexados no Google/Brave (sem curtidas reais). Abra os posts e rode o Radar no link do post para engajamento.'
        );
      }
      if (!posts.length) {
        if (pageResult.searchRaw > 0) {
          avisos.push(
            `Apify search achou ${pageResult.searchRaw} post(s) mencionando o termo, mas nenhum era DESSA página (author/url ≠ @${pageResult.handle}).`
          );
        }
        if (pageResult.apifyLimited) {
          avisos.push(
            'Limite Apify free tier (1 run/24h no page-scraper). Sem posts no índice web — confira Brave/Serper ou tente amanhã.'
          );
        } else {
          avisos.push(
            pageResult.privateSkipped
              ? 'Apify: página privada/sem posts públicos scrapeáveis. Sem resultados no índice web (Brave/Serper). Confira BRAVE_SEARCH_API_KEY / SERPER_API_KEY ou tente outra página pública.'
              : 'Nenhum post encontrado nessa página. Confira se a URL está correta e se a página publica conteúdo aberto.'
          );
        }
      }
    } else if (apifyFacebook.isConfigured()) {
      posts = await apifyFacebook.buscarPostsPorTermo(termoPrincipal, {
        limit: MAX_POSTS,
        maxAgeDays: MAX_AGE_DAYS,
      });
      if (posts.length < 5 && extras[1]) {
        try {
          const mais = await apifyFacebook.buscarPostsPorTermo(extras[1], {
            limit: 10,
            maxAgeDays: MAX_AGE_DAYS,
          });
          const visto = new Set(posts.map((p) => p.url).filter(Boolean));
          for (const p of mais) {
            if (p.url && visto.has(p.url)) continue;
            if (p.url) visto.add(p.url);
            posts.push(p);
          }
        } catch (err2) {
          avisos.push(`2ª busca: ${err2.message}`);
        }
      }
    }
  } catch (err) {
    avisos.push(err.message);
    if (err.status === 402) {
      avisos.push(
        'Limite do plano grátis Apify (costuma ser 1 busca/24h neste actor). Use o cache ou tente amanhã.'
      );
    }
  }

  // Exclui o próprio post de origem do ranking (só para link de POST, não página)
  if (origemLink?.tipo === 'post' && origemLink?.fonteUrl) {
    const origemKey = origemLink.fonteUrl.toLowerCase().replace(/\/$/, '');
    posts = posts.filter((p) => {
      const u = String(p.url || '')
        .toLowerCase()
        .replace(/\/$/, '');
      return !u || u !== origemKey;
    });
  }

  // Remove lixo do índice web (mensagem genérica do Facebook, links inválidos)
  posts = posts.filter((p) => {
    if (!p.url || !apifyFacebook.urlFbParecePost(p.url)) return false;
    if (p.viaWeb && !apifyFacebook.textoPostUtil(p.texto)) {
      const rotulo = apifyFacebook.rotuloPostPorUrl(p.url, p.autor);
      p.texto = rotulo;
      p.indiceWeb = apifyFacebook.qualidadeIndiceWeb(p);
    }
    return Boolean(p.texto);
  });

  let ranked = posts
    .map((p) => ({
      ...p,
      hashtags: p.hashtags || apifyFacebook.extrairHashtags(p.texto),
      score: scoreEngajamento(p),
      // Em modo página: não força filtro gospel (página pode ser economia, política, etc.)
      relevancia: modoPagina ? 50 : relevanciaBrGospel(p),
      recencia: p.viaWeb ? apifyFacebook.qualidadeIndiceWeb(p) : bonusRecencia(p),
      velocidade: scoreVelocidade(p),
      indiceWeb: p.indiceWeb ?? (p.viaWeb ? apifyFacebook.qualidadeIndiceWeb(p) : 0),
    }))
    .sort((a, b) => {
      if (modoPagina && (a.viaWeb || b.viaWeb)) {
        return (
          (b.indiceWeb || 0) - (a.indiceWeb || 0) ||
          b.score - a.score ||
          b.recencia - a.recencia
        );
      }
      return (
        b.recencia - a.recencia ||
        b.velocidade - a.velocidade ||
        b.score - a.score ||
        b.relevancia - a.relevancia
      );
    });

  const ageLimit = modoPagina ? Math.max(MAX_AGE_DAYS, 14) : MAX_AGE_DAYS;
  let recentes = ranked.filter((p) => {
    const d = idadeDias(p);
    return d == null || d <= ageLimit;
  });
  const recentesComData = ranked.filter((p) => {
    const d = idadeDias(p);
    return d != null && d <= ageLimit;
  });

  if (recentesComData.length >= 1) {
    ranked = recentesComData;
  } else {
    const ate14 = ranked.filter((p) => {
      const d = idadeDias(p);
      return d != null && d <= MAX_AGE_FALLBACK_DAYS;
    });
    if (ate14.length) {
      ranked = ate14;
      avisos.push(`Poucos posts ≤${ageLimit} dias — ampliando para ${MAX_AGE_FALLBACK_DAYS} dias.`);
    } else if (recentes.length) {
      ranked = recentes;
      avisos.push('Alguns posts sem data — ranqueados por engajamento (podem ser mais antigos).');
    }
  }

  if (!modoPagina) {
    const preferidos = ranked.filter((p) => p.relevancia >= 20);
    if (preferidos.length >= 1) {
      ranked = preferidos;
    } else if (ranked.length) {
      avisos.push(
        'Poucos posts claramente BR/gospel — refine com #gospel, #igreja, pastor, louvor.'
      );
    }
  }

  const topicos = [];
  const vistosTop = new Set();
  for (const p of ranked) {
    if (topicos.length >= MAX_TOPICOS) break;
    const top = postParaTopico(p, termoPrincipal, crescimentoPrincipal);
    const dedupe = top.link ? apifyFacebook.chaveDedupeFbUrl(top.link) : top.titulo.toLowerCase();
    if (vistosTop.has(dedupe)) continue;
    vistosTop.add(dedupe);
    topicos.push(top);
  }

  // Se veio de um link de post, inclui a origem como primeiro card (referência)
  if (origemLink?.tipo === 'post' && origemLink.fonteUrl) {
    topicos.unshift({
      titulo: origemLink.tema || 'Post de referência',
      resumo: origemLink.resumo || 'Post usado como base do radar.',
      link: origemLink.fonteUrl,
      fonte: 'Post de origem',
      veiculo: 'Referência',
      tipoFonte: 'rede_social',
      redeSocial: true,
      emAlta: true,
      emAltaAgora: true,
      termoTrends: termoPrincipal,
      crescimentoTrends: crescimentoPrincipal,
      likes: 0,
      comments: 0,
      shares: 0,
      scoreEngajamento: 0,
      relevancia: 100,
      hashtags: [],
      publicadoEm: null,
      publicadoEmLabel: null,
      idadeDias: null,
      calor: 999,
      origemRadar: true,
    });
    while (topicos.length > MAX_TOPICOS + 1) topicos.pop();
  }

  if (!topicos.length && trends.length) {
    for (const tema of trends.slice(0, 3)) {
      topicos.push({
        titulo: `Assunto em alta: ${tema.termo}`,
        resumo: `Tema em alta no Google Trends (BR/gospel): ${tema.termo}. Sem posts FB medidos nesta rodada.`,
        link: null,
        fonte: 'Google Trends BR',
        veiculo: 'Google Trends',
        tipoFonte: 'trend',
        redeSocial: false,
        emAlta: true,
        emAltaAgora: true,
        termoTrends: tema.termo,
        crescimentoTrends: tema.crescimento,
        likes: 0,
        comments: 0,
        shares: 0,
        scoreEngajamento: 0,
        relevancia: 0,
        hashtags: [],
        publicadoEm: null,
        publicadoEmLabel: null,
        idadeDias: null,
        calor: Math.min(50, Number(tema.crescimento) || 0),
      });
    }
  }

  topicos.forEach((t, idx) => {
    t.posicao = idx + 1;
  });

  const payload = {
    topicos,
    totalTemas: 1,
    totalPosts: posts.length,
    queryApify,
    maxAgeDays: MAX_AGE_DAYS,
    avisos,
    apifyConfigured: apifyFacebook.isConfigured(),
    fromCache: false,
    geradoEm: new Date().toISOString(),
    origemLink: origemLink
      ? {
          tipo: origemLink.tipo,
          tema: origemLink.tema,
          termos: origemLink.termos,
          url: origemLink.fonteUrl,
        }
      : null,
  };

  if (topicos.length) setCache(key, payload);
  return payload;
}

module.exports = {
  analisarRadarFace,
  scoreEngajamento,
  relevanciaBrGospel,
  isFacebookPageUrl,
  resolverTermosDoLink,
  MAX_TEMAS: 1,
  MAX_POSTS_POR_TEMA: MAX_POSTS,
};
