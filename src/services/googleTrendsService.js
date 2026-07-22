/**
 * Google Trends (Brasil) — rising/daily para o Radar Face.
 * Usa google-trends-api (sem custo de API paga).
 */
const googleTrends = require('google-trends-api');

const SEEDS_GOSPEL = [
  'gospel',
  'pastor',
  'igreja',
  'fé',
  'louvor',
  'evangélico',
  'bíblia',
  'culto',
];

const PALAVRAS_GOSPEL = [
  'gospel',
  'pastor',
  'pastora',
  'igreja',
  'fé',
  'louvor',
  'evangélico',
  'evangelico',
  'bíblia',
  'biblia',
  'culto',
  'deus',
  'jesus',
  'cristo',
  'oração',
  'oracao',
  'testemunho',
  'missão',
  'missao',
  'assembleia',
  'presbiteriana',
  'quadrilateral',
  'quadrangular',
  'iurd',
  'universal',
];

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pareceGospel(termo) {
  const t = stripAccents(termo);
  return PALAVRAS_GOSPEL.some((p) => t.includes(stripAccents(p)));
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pushTermo(map, termo, crescimento) {
  const key = String(termo || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  if (key.length < 2) return;
  const prev = map.get(key.toLowerCase());
  const score = Number(crescimento) || 0;
  if (!prev || score > prev.crescimento) {
    map.set(key.toLowerCase(), { termo: key, crescimento: score });
  }
}

async function coletarDailyBr(map) {
  try {
    const raw = await googleTrends.dailyTrends({ geo: 'BR', trendDate: new Date() });
    const data = parseJsonSafe(raw);
    const days = data?.default?.trendingSearchesDays || [];
    for (const day of days) {
      for (const item of day.trendingSearches || []) {
        const title = item?.title?.query || item?.title || '';
        const traffic = String(item?.formattedTraffic || item?.traffic || '0').replace(/[^\d]/g, '');
        pushTermo(map, title, Number(traffic) || 1);
        for (const related of item?.relatedQueries || []) {
          pushTermo(map, related?.query || related, 1);
        }
      }
    }
  } catch (err) {
    console.warn('[google-trends] dailyTrends:', err.message);
  }
}

async function coletarRelatedSeed(map, seed) {
  try {
    const raw = await googleTrends.relatedQueries({
      keyword: seed,
      geo: 'BR',
      hl: 'pt-BR',
    });
    const data = parseJsonSafe(raw);
    const ranked = data?.default?.rankedList || [];
    for (const block of ranked) {
      for (const row of block.rankedKeyword || []) {
        const query = row?.query || row?.topic?.title || '';
        const value = Number(row?.value) || 0;
        pushTermo(map, query, value);
      }
    }
  } catch (err) {
    console.warn(`[google-trends] relatedQueries(${seed}):`, err.message);
  }
}

/**
 * @param {{ limit?: number, onlyGospel?: boolean }} [opts]
 * @returns {Promise<Array<{ termo: string, crescimento: number }>>}
 */
async function buscarTrendsBrasil(opts = {}) {
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 12));
  const onlyGospel = opts.onlyGospel !== false;
  const map = new Map();

  await coletarDailyBr(map);

  // Seeds gospel: related queries (mais estável para o nicho)
  for (const seed of SEEDS_GOSPEL.slice(0, 5)) {
    await coletarRelatedSeed(map, seed);
  }

  let lista = [...map.values()];
  if (onlyGospel) {
    const filtrados = lista.filter((t) => pareceGospel(t.termo));
    // Se o filtro zerar (Trends genéricos sem palavra gospel), mantém seeds + top daily
    if (filtrados.length >= 3) {
      lista = filtrados;
    } else {
      for (const seed of SEEDS_GOSPEL) {
        pushTermo(map, seed, 50);
      }
      lista = [...map.values()].filter(
        (t) => pareceGospel(t.termo) || SEEDS_GOSPEL.includes(t.termo.toLowerCase())
      );
    }
  }

  return lista
    .sort((a, b) => b.crescimento - a.crescimento || a.termo.localeCompare(b.termo, 'pt-BR'))
    .slice(0, limit);
}

module.exports = {
  buscarTrendsBrasil,
  pareceGospel,
  SEEDS_GOSPEL,
};
