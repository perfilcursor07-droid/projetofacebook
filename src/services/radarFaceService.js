/**
 * Radar Face — Google Trends (BR/gospel) + engajamento FB via Apify.
 *
 * Plano grátis do actor scrapeforge: ~1 run / 24h → fazemos UMA busca Apify
 * com query enriquecida (gospel + Brasil) e ranqueamos posts em PT-BR.
 */
const { buscarTrendsBrasil, pareceGospel } = require('./googleTrendsService');
const apifyFacebook = require('./apifyFacebookService');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TOPICOS = 5;
const MAX_POSTS = 20;

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

/** Prioriza português/Brasil/gospel; penaliza espanhol e off-topic. */
function relevanciaBrGospel(post) {
  const t = stripAccents(post.texto || '');
  const autor = stripAccents(post.autor || '');
  let s = 0;

  if (pareceGospel(t) || pareceGospel(autor)) s += 60;
  if (/\b(brasil|brasileir|sao paulo|rio de janeiro|belo horizonte|brasilia|curitiba|salvador|fortaleza|recife|porto alegre|evangelic|igreja|pastor|louvor|oracao|testemunho|irmao|irmaos)\b/.test(t)) {
    s += 35;
  }
  if (/\b(nao|voce|tambem|pra|pro|gente|hoje|amanha|deus|jesus|cristo|amen|amém)\b/.test(t)) {
    s += 20;
  }
  // Espanhol / LATAM genérico (comum no scrape global)
  if (/\b(el |los |las |una |del |que se |exigio|jugadores|argentin|adaptacion|historia|magia|profecias)\b/.test(t)) {
    s -= 80;
  }
  if (/\b(campana|antiargentina|premier leagu|arturic)\b/.test(t)) {
    s -= 100;
  }

  return s;
}

function tituloDoPost(post, termo) {
  const texto = String(post.texto || '').trim();
  if (!texto) return `Post sobre ${termo}`;
  const primeira = texto.split(/\n/).map((l) => l.trim()).find(Boolean) || texto;
  return primeira.slice(0, 140);
}

function autorTexto(autor) {
  if (autor == null || autor === '') return 'Facebook';
  if (typeof autor === 'object') {
    return String(autor.name || autor.username || autor.title || 'Facebook');
  }
  return String(autor);
}

function cacheKey(extras) {
  return `radar:v2:${String(extras || '').trim().toLowerCase()}`;
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

function postParaTopico(post, termoTrends, crescimento) {
  const autor = autorTexto(post.autor);
  return {
    titulo: tituloDoPost(post, termoTrends),
    resumo: String(post.texto || '').slice(0, 400),
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
    calor: (post.score || 0) + Math.max(0, post.relevancia || 0) + Math.min(50, Number(crescimento) || 0),
  };
}

/**
 * @param {{ palavrasExtras?: string, force?: boolean }} [opts]
 */
async function analisarRadarFace(opts = {}) {
  const palavrasExtras = String(opts.palavrasExtras || '').trim();
  const key = cacheKey(palavrasExtras);
  if (!opts.force) {
    const cached = getCache(key);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const avisos = [];
  if (!apifyFacebook.isConfigured()) {
    avisos.push('APIFY_TOKEN não configurada — configure no .env para medir engajamento no Facebook.');
  }

  const trends = await buscarTrendsBrasil({ limit: 12, onlyGospel: true });

  const extras = palavrasExtras
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 3);

  // Termo principal: extra do usuário OU top Trends gospel
  const termoPrincipal = extras[0] || trends[0]?.termo || 'gospel';
  const crescimentoPrincipal =
    extras[0] != null ? 999 : Number(trends[0]?.crescimento) || 50;

  const queryApify = apifyFacebook.montarQueryBrasilGospel(termoPrincipal);
  avisos.push(`Busca FB: “${queryApify}” (foco Brasil + gospel).`);

  let posts = [];
  if (apifyFacebook.isConfigured()) {
    try {
      // 1 run Apify — plano grátis do actor costuma permitir só 1/dia
      posts = await apifyFacebook.buscarPostsPorTermo(termoPrincipal, {
        limit: MAX_POSTS,
      });
    } catch (err) {
      avisos.push(err.message);
      if (err.status === 402) {
        avisos.push(
          'Limite do plano grátis Apify (costuma ser 1 busca/24h neste actor). Use o cache ou tente amanhã.'
        );
      }
    }
  }

  let ranked = posts
    .map((p) => ({
      ...p,
      score: scoreEngajamento(p),
      relevancia: relevanciaBrGospel(p),
    }))
    .sort(
      (a, b) =>
        b.relevancia - a.relevancia ||
        b.score - a.score
    );

  const preferidos = ranked.filter((p) => p.relevancia >= 20);
  if (preferidos.length >= 1) {
    ranked = preferidos;
  } else if (ranked.length) {
    avisos.push(
      'Poucos posts claramente BR/gospel na amostra — mostrando os melhores disponíveis. Refine os termos (ex.: pastor, igreja, louvor).'
    );
  }

  const topicos = ranked.slice(0, MAX_TOPICOS).map((p) =>
    postParaTopico(p, termoPrincipal, crescimentoPrincipal)
  );

  // Se Apify falhou/zerou, ainda mostra sinais de Trends gospel (sem métricas FB)
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
    avisos,
    apifyConfigured: apifyFacebook.isConfigured(),
    fromCache: false,
    geradoEm: new Date().toISOString(),
  };

  if (topicos.length) setCache(key, payload);
  return payload;
}

module.exports = {
  analisarRadarFace,
  scoreEngajamento,
  relevanciaBrGospel,
  MAX_TEMAS: 1,
  MAX_POSTS_POR_TEMA: MAX_POSTS,
};
