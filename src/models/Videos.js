const db = require('../config/db');

function prepare(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  // VARCHAR(500) — evita ER_DATA_TOO_LONG em títulos longos do Facebook/IG
  if (out.titulo != null) out.titulo = String(out.titulo).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (out.metadata != null && typeof out.metadata === 'object') {
    out.metadata = JSON.stringify(out.metadata);
  }
  return out;
}

function parseRow(row) {
  if (!row) return row;
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata);
    } catch {
      // keep string
    }
  }
  return row;
}

const Videos = {
  table: 'videos',

  findById(id) {
    return db(this.table).where({ id }).first().then(parseRow);
  },

  findByPexelsId(userId, pexelsId) {
    return db(this.table).where({ user_id: userId, pexels_id: String(pexelsId) }).first().then(parseRow);
  },

  findByUrl(userId, url) {
    return db(this.table).where({ user_id: userId, url_original: url }).first().then(parseRow);
  },

  findByUser(userId, filters = {}) {
    const query = db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc');
    if (filters.status) query.andWhere({ status: filters.status });
    return query.then((rows) => rows.map(parseRow));
  },

  create(data) {
    return db(this.table).insert(prepare(data));
  },

  update(id, data) {
    return db(this.table).where({ id }).update(prepare(data));
  },

  remove(id) {
    return db(this.table).where({ id }).del();
  },

  countByStatus(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .select('status')
      .count('* as total')
      .groupBy('status');
  },
};

module.exports = Videos;
