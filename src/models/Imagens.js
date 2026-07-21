const db = require('../config/db');

const Imagens = {
  table: 'imagens',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByPexelsId(userId, pexelsId) {
    return db(this.table).where({ user_id: userId, pexels_id: String(pexelsId) }).first();
  },

  findByUser(userId, filters = {}) {
    const query = db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc');
    if (filters.status) query.andWhere({ status: filters.status });
    return query;
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update(data);
  },

  countByStatus(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .select('status')
      .count('* as total')
      .groupBy('status');
  },

  countByDay(userId, days = 7) {
    const d = Math.max(1, Math.min(90, Number(days) || 7));
    return db(this.table)
      .where({ user_id: userId })
      .where('created_at', '>=', db.raw('DATE_SUB(CURDATE(), INTERVAL ? DAY)', [d - 1]))
      .select(db.raw('DATE(created_at) as dia'))
      .count('* as total')
      .groupByRaw('DATE(created_at)')
      .orderBy('dia', 'asc');
  },
};

module.exports = Imagens;
