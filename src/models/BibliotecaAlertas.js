const db = require('../config/db');

const MAX_KEYWORDS = 40;
const MAX_KEYWORD_LENGTH = 60;
const MAX_SERIALIZED_LENGTH = 500;

function parseKeywords(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\n]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const keyword = String(item || '').trim().replace(/\s+/g, ' ').slice(0, MAX_KEYWORD_LENGTH);
    if (keyword.length < 2) continue;
    const key = stripAccents(keyword).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

function serializeKeywords(raw) {
  const serialized = [];
  let length = 0;
  for (const keyword of parseKeywords(raw)) {
    const extra = keyword.length + (serialized.length ? 2 : 0);
    if (length + extra > MAX_SERIALIZED_LENGTH) break;
    serialized.push(keyword);
    length += extra;
  }
  return serialized.length ? serialized.join(', ') : null;
}

function escapeLike(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normaliza acentos e separadores no próprio SQL para comparar palavras ou frases inteiras.
 * Ex.: "fé" casa com "Fé-em-Deus", mas não com "férias".
 */
function paddedTextExpr(columnSql) {
  let expression = `LOWER(COALESCE(${columnSql}, ''))`;
  const accents = [
    ['á', 'a'], ['à', 'a'], ['â', 'a'], ['ã', 'a'], ['ä', 'a'],
    ['é', 'e'], ['è', 'e'], ['ê', 'e'], ['ë', 'e'],
    ['í', 'i'], ['ì', 'i'], ['î', 'i'], ['ï', 'i'],
    ['ó', 'o'], ['ò', 'o'], ['ô', 'o'], ['õ', 'o'], ['ö', 'o'],
    ['ú', 'u'], ['ù', 'u'], ['û', 'u'], ['ü', 'u'], ['ç', 'c'],
  ];
  for (const [from, to] of accents) {
    expression = `REPLACE(${expression}, '${from}', '${to}')`;
  }
  const separators = [
    "'.'", "','", "':'", "';'", "'!'", 'CHAR(63)', 'CHAR(34)', 'CHAR(39)',
    "'('", "')'", "'['", "']'", "'{'", "'}'", "'-'", "'–'", "'—'", "'/'",
    "'|'", 'CHAR(92)', 'CHAR(10)', 'CHAR(13)', 'CHAR(9)',
  ];
  for (const separator of separators) {
    expression = `REPLACE(${expression}, ${separator}, ' ')`;
  }
  // Compacta espaços repetidos para que frases também funcionem após hífens/quebras de linha.
  for (let i = 0; i < 4; i += 1) {
    expression = `REPLACE(${expression}, '  ', ' ')`;
  }
  return `CONCAT(' ', ${expression}, ' ')`;
}

function keywordLikePattern(keyword) {
  const normalized = stripAccents(keyword).trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length >= 2 ? `% ${escapeLike(normalized)} %` : null;
}

function applyKeywordFilter(query, keywords) {
  const patterns = parseKeywords(keywords).map(keywordLikePattern).filter(Boolean);
  if (!patterns.length) return query;
  const columns = ['a.titulo', 'a.resumo', 'p.titulo', 'p.resumo', 'f.nome'];
  return query.andWhere(function matchAnyKeyword() {
    patterns.forEach((pattern) => {
      this.orWhere(function matchOneKeyword() {
        columns.forEach((column) => {
          this.orWhereRaw(`${paddedTextExpr(column)} LIKE ?`, [pattern]);
        });
      });
    });
  });
}

function baseQuery(userId, { apenasNaoLidos = false, keywords = null } = {}) {
  const query = db('biblioteca_alertas as a')
    .innerJoin('biblioteca_fontes as f', 'f.id', 'a.fonte_id')
    .where('a.user_id', userId);
  if (apenasNaoLidos) query.andWhere('a.lido', false);
  if (parseKeywords(keywords).length) {
    query.leftJoin('biblioteca_posts as p', 'p.id', 'a.post_id');
    applyKeywordFilter(query, keywords);
  }
  return query;
}

const BibliotecaAlertas = {
  table: 'biblioteca_alertas',

  findByUser(userId, { apenasNaoLidos = false, limit = 40, keywords = null } = {}) {
    return baseQuery(userId, { apenasNaoLidos, keywords })
      .orderBy('a.created_at', 'desc')
      .limit(limit)
      .select(
        'a.*',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma',
        'f.url as fonte_url'
      );
  },

  countNaoLidos(userId, keywords = null) {
    return baseQuery(userId, { apenasNaoLidos: true, keywords })
      .countDistinct({ total: 'a.id' })
      .first();
  },

  /** Remove alertas cuja fonte já foi apagada (lixo órfão). */
  limparOrfaos(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .where(function orphan() {
        this.whereNull('fonte_id').orWhereNotExists(function () {
          this.select(db.raw('1'))
            .from('biblioteca_fontes as f')
            .whereRaw('f.id = biblioteca_alertas.fonte_id');
        });
      })
      .del();
  },

  create(data) {
    return db(this.table).insert(data);
  },

  marcarLido(id, userId) {
    return db(this.table).where({ id, user_id: userId }).update({ lido: true, updated_at: db.fn.now() });
  },

  marcarLidoPorPost(postId, userId) {
    return db(this.table)
      .where({ post_id: postId, user_id: userId, lido: false })
      .update({ lido: true, updated_at: db.fn.now() });
  },

  async marcarTodosLidos(userId, keywords = null) {
    const ids = await baseQuery(userId, { apenasNaoLidos: true, keywords }).pluck('a.id');
    if (!ids.length) return 0;
    return db(this.table)
      .where({ user_id: userId, lido: false })
      .whereIn('id', ids)
      .update({ lido: true, updated_at: db.fn.now() });
  },
};

module.exports = BibliotecaAlertas;
module.exports.parseKeywords = parseKeywords;
module.exports.serializeKeywords = serializeKeywords;
module.exports.keywordLikePatterns = (keyword) => {
  const pattern = keywordLikePattern(keyword);
  return pattern ? [pattern] : [];
};
