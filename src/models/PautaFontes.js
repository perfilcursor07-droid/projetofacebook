const crypto = require('crypto');
const db = require('../config/db');

function hashUrl(url) {
  return crypto.createHash('sha256').update(String(url || '').trim().toLowerCase()).digest('hex');
}

const PautaFontes = {
  table: 'pauta_fontes',

  findByIdForUser(id, userId) {
    return db(this.table).where({ id: Number(id), user_id: Number(userId) }).first();
  },

  findByUser(userId, { somenteAtivas = false } = {}) {
    let query = db(this.table).where({ user_id: Number(userId) });
    if (somenteAtivas) query = query.andWhere({ ativa: true });
    return query.orderBy('nome', 'asc').orderBy('id', 'asc');
  },

  create(data) {
    return db(this.table).insert({ ...data, url_hash: hashUrl(data.url) });
  },

  updateForUser(id, userId, data) {
    const payload = { ...data, updated_at: db.fn.now() };
    if (payload.url) payload.url_hash = hashUrl(payload.url);
    return db(this.table).where({ id: Number(id), user_id: Number(userId) }).update(payload);
  },

  deleteForUser(id, userId) {
    return db(this.table).where({ id: Number(id), user_id: Number(userId) }).del();
  },

  hashUrl,
};

module.exports = PautaFontes;
