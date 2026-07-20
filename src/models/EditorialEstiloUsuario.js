const db = require('../config/db');

const EditorialEstiloUsuario = {
  table: 'editorial_estilo_usuario',

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).first();
  },

  async upsert(userId, data) {
    const existing = await this.findByUser(userId);
    if (existing) {
      await db(this.table)
        .where({ id: existing.id })
        .update({ ...data, updated_at: db.fn.now() });
      return this.findByUser(userId);
    }
    const [id] = await db(this.table).insert({
      user_id: userId,
      ...data,
    });
    return db(this.table).where({ id }).first();
  },
};

module.exports = EditorialEstiloUsuario;
