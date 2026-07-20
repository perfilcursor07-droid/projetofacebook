const db = require('../config/db');

const BibliotecaAutopilot = {
  table: 'biblioteca_autopilot',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).first();
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

  incrementPublishedByUser(userId, amount = 1) {
    const delta = Math.max(1, Number(amount) || 1);
    return db(this.table)
      .where({ user_id: userId })
      .update({
        total_publicados: db.raw('total_publicados + ?', [delta]),
        updated_at: db.fn.now(),
      });
  },

  updateByUser(userId, data) {
    return db(this.table).where({ user_id: userId }).update({ ...data, updated_at: db.fn.now() });
  },
};

module.exports = BibliotecaAutopilot;
