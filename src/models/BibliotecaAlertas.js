const db = require('../config/db');

function parseKeywords(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\n]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = String(item || '').trim().replace(/\s+/g, ' ');
    if (k.length < 2) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= 40) break;
  }
  return out;
}

function serializeKeywords(raw) {
  const parsed = parseKeywords(raw);
  return parsed.length ? parsed.join(', ').slice(0, 800) : null;
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
 * Expressão SQL que "isola" palavras com espaços (sem REGEXP — compatível com MySQL 8 ICU).
 * Assim "fé" não casa com "férias"/"federal".
 * Usa CHAR(63) no lugar de '?' para não confundir bindings do Knex.
 */
function paddedTextExpr(columnSql) {
  return (
    "CONCAT(' ', " +
    "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(" +
    `LOWER(COALESCE(${columnSql}, '')), ` +
    "'.', ' '), ',', ' '), ':', ' '), ';', ' '), '!', ' '), CHAR(63), ' '), '\"', ' '), '''', ' '), '(', ' '), ')', ' '), " +
    "' ')"
  );
}

/** Variantes da palavra (com/sem acento) para LIKE com espaços laterais. */
function keywordLikePatterns(keyword) {
  const base = String(keyword || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (base.length < 2) return [];
  const variants = new Set([base, stripAccents(base).toLowerCase()]);
  return [...variants].map((v) => `% ${escapeLike(v)} %`);
}

const BibliotecaAlertas = {
  table: 'biblioteca_alertas',

  findByUser(userId, { apenasNaoLidos = false, limit = 40, keywords = null } = {}) {
    const kws = parseKeywords(keywords);
    // Só alertas de fontes que ainda existem (some junto com a exclusão)
    const q = db(`${this.table} as a`)
      .innerJoin('biblioteca_fontes as f', 'f.id', 'a.fonte_id')
      .where('a.user_id', userId)
      .orderBy('a.created_at', 'desc')
      .limit(limit)
      .select(
        'a.*',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma',
        'f.url as fonte_url'
      );
    if (apenasNaoLidos) q.andWhere('a.lido', false);

    if (kws.length) {
      q.leftJoin('biblioteca_posts as p', 'p.id', 'a.post_id');
      const cols = ['a.titulo', 'a.resumo', 'p.titulo', 'p.resumo', 'f.nome'];
      q.andWhere(function matchKeywords() {
        kws.forEach((kw) => {
          const patterns = keywordLikePatterns(kw);
          if (!patterns.length) return;
          this.orWhere(function matchOneKeyword() {
            patterns.forEach((pattern) => {
              cols.forEach((col) => {
                this.orWhereRaw(`${paddedTextExpr(col)} LIKE ?`, [pattern]);
              });
            });
          });
        });
      });
    }

    return q;
  },

  countNaoLidos(userId) {
    return db(`${this.table} as a`)
      .innerJoin('biblioteca_fontes as f', 'f.id', 'a.fonte_id')
      .where('a.user_id', userId)
      .andWhere('a.lido', false)
      .count({ total: '*' })
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

  marcarTodosLidos(userId) {
    return db(this.table).where({ user_id: userId, lido: false }).update({ lido: true, updated_at: db.fn.now() });
  },
};

module.exports = BibliotecaAlertas;
module.exports.parseKeywords = parseKeywords;
module.exports.serializeKeywords = serializeKeywords;
module.exports.keywordLikePatterns = keywordLikePatterns;
