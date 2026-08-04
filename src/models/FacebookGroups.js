const db = require('../config/db');

const FacebookGroups = {
  table: 'facebook_groups',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).orderBy(['nicho', 'nome']);
  },

  findByIds(userId, ids) {
    const lista = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!lista.length) return Promise.resolve([]);
    return db(this.table).where({ user_id: userId }).whereIn('id', lista);
  },

  /** Grupos ativos marcados como padrão — pré-selecionados ao publicar. */
  findPadrao(userId) {
    return db(this.table).where({ user_id: userId, ativo: true, padrao: true }).orderBy(['nicho', 'nome']);
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, userId, data) {
    return db(this.table)
      .where({ id, user_id: userId })
      .update({ ...data, updated_at: db.fn.now() });
  },

  deleteByUser(id, userId) {
    return db(this.table).where({ id, user_id: userId }).del();
  },

  registrarPost(id, { erro = null } = {}) {
    return db(this.table)
      .where({ id })
      .update({
        ultimo_post_em: erro ? null : db.fn.now(),
        ultimo_erro: erro ? String(erro).slice(0, 1000) : null,
        updated_at: db.fn.now(),
      });
  },
};

module.exports = FacebookGroups;
