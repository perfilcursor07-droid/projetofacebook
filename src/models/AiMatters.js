const db = require('../config/db');

/** VARCHAR(300) em ai_matters.titulo — corta antes do MySQL estourar. */
function prepare(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (out.titulo != null) out.titulo = String(out.titulo).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (out.fonte_titulo != null) {
    out.fonte_titulo = String(out.fonte_titulo).replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  return out;
}

const AiMatters = {
  table: 'ai_matters',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId, limit = 30) {
    return db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
  },

  create(data) {
    return db(this.table).insert(prepare(data));
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...prepare(data), updated_at: db.fn.now() });
  },

  delete(id) {
    return db(this.table).where({ id }).del();
  },

  deleteByUser(id, userId) {
    return db(this.table).where({ id, user_id: userId }).del();
  },
};

module.exports = AiMatters;
