const db = require('../config/db');

const ConteudoLinks = {
  table: 'conteudo_links',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).orderBy('nome', 'asc');
  },

  findByUserAndUrl(userId, url) {
    return db(this.table).where({ user_id: userId, url }).first();
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },

  deleteByUser(id, userId) {
    return db(this.table).where({ id, user_id: userId }).del();
  },
};

module.exports = ConteudoLinks;
