const crypto = require('crypto');
const db = require('../config/db');

const TOKEN_PREFIX = 'vza_';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const ApiTokens = {
  table: 'api_tokens',

  /** Gera um token novo. Retorna { token, row } — o token puro só existe aqui. */
  async issue(userId, nomeDispositivo) {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
    const [id] = await db(this.table).insert({
      user_id: userId,
      token_hash: hashToken(token),
      nome_dispositivo: String(nomeDispositivo || 'Extensão').slice(0, 150),
    });
    const row = await db(this.table).where({ id }).first();
    return { token, row };
  },

  findValidByToken(token) {
    if (!token || !String(token).startsWith(TOKEN_PREFIX)) return null;
    return db(this.table)
      .where({ token_hash: hashToken(token) })
      .whereNull('revogado_em')
      .first();
  },

  listByUser(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .orderBy('criado_em', 'desc')
      .select('id', 'nome_dispositivo', 'criado_em', 'ultimo_uso_em', 'revogado_em');
  },

  touch(id) {
    return db(this.table).where({ id }).update({ ultimo_uso_em: db.fn.now() });
  },

  revoke(id, userId) {
    return db(this.table)
      .where({ id, user_id: userId })
      .whereNull('revogado_em')
      .update({ revogado_em: db.fn.now() });
  },
};

module.exports = ApiTokens;
