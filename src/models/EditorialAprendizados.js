const db = require('../config/db');

const EditorialAprendizados = {
  table: 'editorial_aprendizados',

  create(data) {
    return db(this.table).insert(data);
  },

  findRecentByUser(userId, limit = 8) {
    return db(this.table)
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .limit(limit);
  },

  countByUser(userId) {
    return db(this.table).where({ user_id: userId }).count({ total: '*' }).first();
  },
};

module.exports = EditorialAprendizados;
