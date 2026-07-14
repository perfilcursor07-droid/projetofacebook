const db = require('../config/db');

const AiMonitors = {
  table: 'ai_monitors',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc');
  },

  findDue() {
    return db(this.table)
      .where({ ativo: true })
      .andWhere((qb) => {
        qb.whereNull('proxima_execucao').orWhere('proxima_execucao', '<=', db.fn.now());
      });
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },
};

module.exports = AiMonitors;
