const db = require('../config/db');

const Videos = {
  table: 'videos',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByPexelsId(userId, pexelsId) {
    return db(this.table).where({ user_id: userId, pexels_id: String(pexelsId) }).first();
  },

  findByUrl(userId, url) {
    return db(this.table).where({ user_id: userId, url_original: url }).first();
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
