const db = require('../config/db');

const BibliotecaAlertas = {
  table: 'biblioteca_alertas',

  findByUser(userId, { apenasNaoLidos = false, limit = 40 } = {}) {
    const q = db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
    if (apenasNaoLidos) q.andWhere({ lido: false });
    return q;
  },

  countNaoLidos(userId) {
    return db(this.table).where({ user_id: userId, lido: false }).count({ total: '*' }).first();
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
