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

function keywordLikePattern(keyword) {
  const normalized = stripAccents(keyword).trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length >= 2 ? `% ${escapeLike(normalized)} %` : null;
}

function baseQuery(userId, { apenasNaoLidos = false, apenasLidos = false } = {}) {
  const query = db('biblioteca_alertas as a')
    .innerJoin('biblioteca_fontes as f', 'f.id', 'a.fonte_id')
    .where('a.user_id', userId);
  if (apenasNaoLidos) query.andWhere('a.lido', false);
  if (apenasLidos) query.andWhere('a.lido', true);
  return query;
}

/** Filtra alertas em memória (evita REPLACE/LIKE pesado no MySQL). */
function filterByKeywords(rows, keywords) {
  const patterns = parseKeywords(keywords)
    .map((k) => stripAccents(k).trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((k) => k.length >= 2);
  if (!patterns.length) return Array.isArray(rows) ? rows : [];
  return (rows || []).filter((row) => {
    const raw = [row.titulo, row.resumo, row.fonte_nome, row.post_titulo, row.post_resumo]
      .filter(Boolean)
      .join(' ');
    const text = ` ${stripAccents(raw)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()} `;
    return patterns.some((p) => text.includes(` ${p} `));
  });
}

const BibliotecaAlertas = {
  table: 'biblioteca_alertas',

  findByUser(userId, { apenasNaoLidos = false, apenasLidos = false, limit = 40, keywords = null } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 40));
    // Com palavras-chave: busca pool maior sem filtro SQL e filtra em JS (muito mais rápido).
    const poolLimit = parseKeywords(keywords).length ? Math.min(500, Math.max(lim * 4, 200)) : lim;
    return baseQuery(userId, { apenasNaoLidos, apenasLidos })
      .leftJoin('biblioteca_posts as p', 'p.id', 'a.post_id')
      .orderBy('a.created_at', 'desc')
      .limit(poolLimit)
      .select(
        'a.*',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma',
        'f.url as fonte_url',
        'p.titulo as post_titulo',
        'p.resumo as post_resumo'
      )
      .then((rows) => {
        const filtered = parseKeywords(keywords).length ? filterByKeywords(rows, keywords) : rows;
        return filtered.slice(0, lim);
      });
  },

  async countNaoLidos(userId, keywords = null) {
    if (!parseKeywords(keywords).length) {
      const row = await baseQuery(userId, { apenasNaoLidos: true })
        .count({ total: 'a.id' })
        .first();
      return row;
    }
    const rows = await this.findByUser(userId, {
      apenasNaoLidos: true,
      limit: 500,
      keywords,
    });
    return { total: rows.length };
  },

  async countLidos(userId, keywords = null) {
    if (!parseKeywords(keywords).length) {
      const row = await baseQuery(userId, { apenasLidos: true })
        .count({ total: 'a.id' })
        .first();
      return row;
    }
    const rows = await this.findByUser(userId, {
      apenasLidos: true,
      limit: 200,
      keywords,
    });
    return { total: rows.length };
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
    if (!parseKeywords(keywords).length) {
      return db(this.table)
        .where({ user_id: userId, lido: false })
        .update({ lido: true, updated_at: db.fn.now() });
    }
    const rows = await this.findByUser(userId, {
      apenasNaoLidos: true,
      limit: 500,
      keywords,
    });
    const ids = rows.map((r) => r.id).filter(Boolean);
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
module.exports.filterByKeywords = filterByKeywords;
module.exports.keywordLikePatterns = (keyword) => {
  const pattern = keywordLikePattern(keyword);
  return pattern ? [pattern] : [];
};
