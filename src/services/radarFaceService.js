/**
 * Radar Face — Google Trends (BR/gospel) + engajamento FB via Apify.
 */
const { buscarTrendsBrasil } = require('./googleTrendsService');
const apifyFacebook = require('./apifyFacebookService');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TEMAS = 3;
const MAX_POSTS_POR_TEMA = 8;

/** Cache em memória por usuário/chave (economiza créditos do plano grátis). */
const cache = new Map();

function scoreEngajamento(post) {
  const likes = Number(post.likes) || 0;
  const comments = Number(post.comments) || 0;
  const shares = Number(post.shares) || 0;
  return likes + comments * 2 + shares * 3;
}

function tituloDoPost(post, termo) {
  const texto = String(post.texto || '').trim();
  if (!texto) return `Post sobre ${termo}`;
  const primeira = texto.split(/\n/).map((l) => l.trim()).find(Boolean) || texto;
  return primeira.slice(0, 140);
}

function cacheKey(extras) {
  return `radar:${String(extras || '').trim().toLowerCase()}`;
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

  let trends = await buscarTrendsBrasil({ limit: 12, onlyGospel: true });

  // Palavras extras do usuário entram no topo
  const extras = palavrasExtras
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 5);
  for (const extra of extras.reverse()) {
    trends = [{ termo: extra, crescimento: 999 }, ...trends.filter((t) => t.termo.toLowerCase() !== extra.toLowerCase())];
  }

  const temas = trends.slice(0, MAX_TEMAS);
  const topicos = [];
  let totalPosts = 0;

  for (const tema of temas) {
    let posts = [];
    if (apifyFacebook.isConfigured()) {
      try {
        posts = await apifyFacebook.buscarPostsPorTermo(tema.termo, {
          limit: MAX_POSTS_POR_TEMA,
        });
        totalPosts += posts.length;
      } catch (err) {
        avisos.push(`${tema.termo}: ${err.message}`);
        if (err.status === 402) {
          avisos.push('Créditos Apify insuficientes — use o cache ou aguarde o reset do plano grátis.');
          break;
        }
      }
    }

    const ranked = posts
      .map((p) => ({ ...p, score: scoreEngajamento(p) }))
      .sort((a, b) => b.score - a.score);

    const top = ranked[0] || null;
    const titulo = top ? tituloDoPost(top, tema.termo) : `Assunto em alta: ${tema.termo}`;
    const resumo = top?.texto
      ? String(top.texto).slice(0, 400)
      : `Tema em alta no Google Trends (BR): ${tema.termo}. Sem posts FB medidos nesta rodada.`;

    topicos.push({
      titulo,
      resumo,
      link: top?.url || null,
      fonte: top?.autor || 'Facebook / Google Trends',
      veiculo: top?.autor || 'Facebook',
      tipoFonte: top?.url ? 'rede_social' : 'trend',
      redeSocial: Boolean(top?.url),
      emAlta: true,
      emAltaAgora: true,
      termoTrends: tema.termo,
      crescimentoTrends: tema.crescimento,
      likes: top?.likes || 0,
      comments: top?.comments || 0,
      shares: top?.shares || 0,
      scoreEngajamento: top?.score || 0,
      calor: (top?.score || 0) + Math.min(50, Number(tema.crescimento) || 0),
      postsAmostra: ranked.slice(0, 3).map((p) => ({
        url: p.url,
        likes: p.likes,
        comments: p.comments,
        shares: p.shares,
        score: p.score,
        trecho: String(p.texto || '').slice(0, 160),
      })),
    });
  }

  topicos.sort((a, b) => b.calor - a.calor || b.scoreEngajamento - a.scoreEngajamento);
  topicos.forEach((t, idx) => {
    t.posicao = idx + 1;
  });

  const payload = {
    topicos,
    totalTemas: temas.length,
    totalPosts,
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
  MAX_TEMAS,
  MAX_POSTS_POR_TEMA,
};
