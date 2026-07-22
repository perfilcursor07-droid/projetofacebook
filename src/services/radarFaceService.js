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

function cacheKey(extras) {
  return `radar:v3:${String(extras || '').trim().toLowerCase()}`;
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

function postParaTopico(post, termoTrends, crescimento) {
  const autor = autorTexto(post.autor);
  const hashtags = post.hashtags || apifyFacebook.extrairHashtags(post.texto);
  const publicadoEm = post.publicadoEm ? new Date(post.publicadoEm).toISOString() : null;
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
    hashtags,
    publicadoEm,
    publicadoEmLabel: formatarDataCurta(post.publicadoEm),
    idadeDias: idadeDias(post) != null ? Math.round(idadeDias(post) * 10) / 10 : null,
    calor:
      (post.velocidade || 0) +
      Math.max(0, post.relevancia || 0) +
      Math.max(0, post.recencia || 0) +
      Math.min(50, Number(crescimento) || 0),
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
  const extras = parseTermosUsuario(palavrasExtras);

  const termoPrincipal = extras[0] || trends[0]?.termo || '#gospel';
  const crescimentoPrincipal =
    extras[0] != null ? 999 : Number(trends[0]?.crescimento) || 50;

  const queryApify = apifyFacebook.montarQueryBrasilGospel(termoPrincipal);
  avisos.push(
    `Busca FB recente (até ${MAX_AGE_DAYS} dias): “${queryApify}”. Aceita #hashtags.`
  );

  let posts = [];
  if (apifyFacebook.isConfigured()) {
    try {
      posts = await apifyFacebook.buscarPostsPorTermo(termoPrincipal, {
        limit: MAX_POSTS,
        maxAgeDays: MAX_AGE_DAYS,
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
      hashtags: p.hashtags || apifyFacebook.extrairHashtags(p.texto),
      score: scoreEngajamento(p),
      relevancia: relevanciaBrGospel(p),
      recencia: bonusRecencia(p),
      velocidade: scoreVelocidade(p),
    }))
    .sort(
      (a, b) =>
        b.recencia - a.recencia ||
        b.relevancia - a.relevancia ||
        b.velocidade - a.velocidade ||
        b.score - a.score
    );

  // Preferir posts dos últimos 7 dias (com data conhecida)
  let recentes = ranked.filter((p) => {
    const d = idadeDias(p);
    return d == null || d <= MAX_AGE_DAYS;
  });
  const recentesComData = ranked.filter((p) => {
    const d = idadeDias(p);
    return d != null && d <= MAX_AGE_DAYS;
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
      avisos.push(`Poucos posts ≤${MAX_AGE_DAYS} dias — ampliando para ${MAX_AGE_FALLBACK_DAYS} dias.`);
    } else if (recentes.length) {
      ranked = recentes;
      avisos.push('Alguns posts sem data — ranqueados por engajamento + relevância (podem ser mais antigos).');
    }
  }

  const preferidos = ranked.filter((p) => p.relevancia >= 20);
  if (preferidos.length >= 1) {
    ranked = preferidos;
  } else if (ranked.length) {
    avisos.push(
      'Poucos posts claramente BR/gospel — refine com #gospel, #igreja, pastor, louvor.'
    );
  }

  const topicos = ranked.slice(0, MAX_TOPICOS).map((p) =>
    postParaTopico(p, termoPrincipal, crescimentoPrincipal)
  );

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
