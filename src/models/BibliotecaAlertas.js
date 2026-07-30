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

/**
 * Retorna a primeira palavra-chave (texto original) que bate no post/alerta.
 * Ordem = ordem da lista do usuário.
 */
function findMatchingKeyword(row, keywords) {
  const list = parseKeywords(keywords);
  if (!list.length || !row) return null;
  const raw = [
    row.titulo,
    row.resumo,
    row.fonte_nome,
    row.post_titulo,
    row.post_resumo,
    row.matter_titulo,
  ]
    .filter(Boolean)
    .join(' ');
  const text = ` ${stripAccents(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  for (const keyword of list) {
    const p = stripAccents(keyword).trim().toLowerCase().replace(/\s+/g, ' ');
    if (p.length >= 2 && text.includes(` ${p} `)) return keyword;
  }
  return null;
}

/** Todas as palavras-chave que batem (útil p/ debug). */
function findMatchingKeywords(row, keywords) {
  const list = parseKeywords(keywords);
  if (!list.length || !row) return [];
  const raw = [
    row.titulo,
    row.resumo,
    row.fonte_nome,
    row.post_titulo,
    row.post_resumo,
    row.matter_titulo,
  ]
    .filter(Boolean)
    .join(' ');
  const text = ` ${stripAccents(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  return list.filter((keyword) => {
    const p = stripAccents(keyword).trim().toLowerCase().replace(/\s+/g, ' ');
    return p.length >= 2 && text.includes(` ${p} `);
  });
}

/** Alertas que NÃO batem com nenhuma palavra-chave. */
function filterExcludingKeywords(rows, keywords) {
  const patterns = parseKeywords(keywords)
    .map((k) => stripAccents(k).trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((k) => k.length >= 2);
  if (!patterns.length) return Array.isArray(rows) ? rows : [];
  const matchedIds = new Set(filterByKeywords(rows, keywords).map((r) => r.id));
  return (rows || []).filter((row) => !matchedIds.has(row.id));
}

function dedupeAlertasRows(rows) {
  const seenPost = new Set();
  const seenTitulo = new Set();
  const out = [];
  for (const row of rows || []) {
    if (row.post_id && seenPost.has(Number(row.post_id))) continue;
    const tKey = `${row.fonte_id || 0}|${String(row.titulo || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/^[^:]+:\s*/, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140)}`;
    if (tKey.length > 28 && seenTitulo.has(tKey)) continue;
    if (row.post_id) seenPost.add(Number(row.post_id));
    if (tKey.length > 28) seenTitulo.add(tKey);
    out.push(row);
  }
  return out;
}

const BibliotecaAlertas = {
  table: 'biblioteca_alertas',

  findByUser(
    userId,
    { apenasNaoLidos = false, apenasLidos = false, limit = 40, keywords = null, excludeKeywords = false } = {}
  ) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 40));
    const hasKw = parseKeywords(keywords).length > 0;
    // Com palavras-chave (match ou exclusão): pool maior e filtra em JS.
    const poolLimit = hasKw ? Math.min(500, Math.max(lim * 5, 250)) : Math.min(500, Math.max(lim * 3, lim));
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
        let list = dedupeAlertasRows(rows || []);
        if (!hasKw) return list.slice(0, lim);
        const filtered = excludeKeywords
          ? filterExcludingKeywords(list, keywords)
          : filterByKeywords(list, keywords);
        return dedupeAlertasRows(filtered).slice(0, lim);
      });
  },

  async countNaoLidos(userId, keywords = null, { excludeKeywords = false } = {}) {
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
      excludeKeywords,
    });
    return { total: rows.length };
  },

  async countLidos(userId, keywords = null, { excludeKeywords = false } = {}) {
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
      excludeKeywords,
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

  findByPostId(postId, userId = null) {
    if (!postId) return null;
    const q = db(this.table).where({ post_id: postId }).orderBy('id', 'asc');
    if (userId) q.andWhere({ user_id: userId });
    return q.first();
  },

  /**
   * Remove alertas duplicados (mesmo post_id ou mesmo título+fonte).
   * Mantém o mais antigo; marca os extras como lidos ou apaga os não lidos extras.
   */
  async limparDuplicados(userId) {
    const rows = await db(this.table)
      .where({ user_id: userId })
      .orderBy('id', 'asc')
      .select('id', 'post_id', 'fonte_id', 'titulo', 'lido');
    const seenPost = new Set();
    const seenTitulo = new Set();
    const idsLixo = [];
    for (const row of rows || []) {
      let dup = false;
      if (row.post_id) {
        if (seenPost.has(Number(row.post_id))) dup = true;
        else seenPost.add(Number(row.post_id));
      }
      const tKey = `${row.fonte_id || 0}|${String(row.titulo || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/^[^:]+:\s*/, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140)}`;
      if (tKey.length > 28) {
        if (seenTitulo.has(tKey)) dup = true;
        else seenTitulo.add(tKey);
      }
      if (dup) idsLixo.push(row.id);
    }
    if (!idsLixo.length) return 0;
    return db(this.table).whereIn('id', idsLixo).del();
  },

  marcarLido(id, userId) {
    return db(this.table).where({ id, user_id: userId }).update({ lido: true, updated_at: db.fn.now() });
  },

  marcarLidoPorPost(postId, userId) {
    return db(this.table)
      .where({ post_id: postId, user_id: userId, lido: false })
      .update({ lido: true, updated_at: db.fn.now() });
  },

  async marcarTodosLidos(userId, keywords = null, { excludeKeywords = false } = {}) {
    if (!parseKeywords(keywords).length) {
      return db(this.table)
        .where({ user_id: userId, lido: false })
        .update({ lido: true, updated_at: db.fn.now() });
    }
    const rows = await this.findByUser(userId, {
      apenasNaoLidos: true,
      limit: 500,
      keywords,
      excludeKeywords,
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
module.exports.filterExcludingKeywords = filterExcludingKeywords;
module.exports.findMatchingKeyword = findMatchingKeyword;
module.exports.findMatchingKeywords = findMatchingKeywords;
module.exports.keywordLikePatterns = (keyword) => {
  const pattern = keywordLikePattern(keyword);
  return pattern ? [pattern] : [];
};
