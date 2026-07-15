const db = require('../config/db');

const BibliotecaPosts = {
  table: 'biblioteca_posts',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByFonte(fonteId, limit = 30) {
    return db(this.table).where({ fonte_id: fonteId }).orderBy('created_at', 'desc').limit(limit);
  },

  findByUser(userId, { status, limit = 40 } = {}) {
    const q = db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
    if (status) q.andWhere({ status });
    return q;
  },

  findByExternal(fonteId, externalId) {
    return db(this.table).where({ fonte_id: fonteId, external_id: String(externalId) }).first();
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },
};

module.exports = BibliotecaPosts;
