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

/** Escapa metacaracteres de REGEXP do MySQL. */
function escapeRegexp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Monta REGEXP de palavra/frase inteira (não pedaço dentro de outra palavra).
 * Evita: "fé" bater em "férias", "federal", "professor".
 */
function keywordWordRegexp(keyword) {
  const parts = String(keyword || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegexp);
  if (!parts.length) return null;
  // [[:<:]] / [[:>:]] = início/fim de palavra no MySQL
  if (parts.length === 1) {
    return `[[:<:]]${parts[0]}[[:>:]]`;
  }
  return `[[:<:]]${parts.join('[[:space:]]+')}[[:>:]]`;
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
      q.andWhere(function matchKeywords() {
        kws.forEach((kw) => {
          const pattern = keywordWordRegexp(kw);
          if (!pattern) return;
          this.orWhere(function matchOne() {
            // REGEXP no MySQL com collation unicode trata acentos de forma flexível (fé≈fe),
            // mas [[:<:]] impede match no meio de outra palavra (férias/federal).
            this.whereRaw('LOWER(COALESCE(a.titulo, \'\')) REGEXP ?', [pattern])
              .orWhereRaw('LOWER(COALESCE(a.resumo, \'\')) REGEXP ?', [pattern])
              .orWhereRaw('LOWER(COALESCE(p.titulo, \'\')) REGEXP ?', [pattern])
              .orWhereRaw('LOWER(COALESCE(p.resumo, \'\')) REGEXP ?', [pattern])
              .orWhereRaw('LOWER(COALESCE(f.nome, \'\')) REGEXP ?', [pattern]);
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
module.exports.keywordWordRegexp = keywordWordRegexp;
