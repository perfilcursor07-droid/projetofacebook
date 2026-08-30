const db = require('../config/db');

const AiProviderSettings = {
  table: 'ai_provider_settings',

  list() {
    return db(this.table).orderBy('id', 'asc');
  },

  findByProvider(provider) {
    return db(this.table).where({ provider }).first();
  },

  findSelected() {
    return db(this.table).where({ selected_materia_manual: 1 }).first();
  },

  async upsert(provider, data) {
    const existente = await this.findByProvider(provider);
    if (existente) {
      await db(this.table)
        .where({ provider })
        .update({ ...data, updated_at: db.fn.now() });
      return this.findByProvider(provider);
    }
    await db(this.table).insert({ provider, ...data });
    return this.findByProvider(provider);
  },

  async select(provider, model) {
    await db.transaction(async (trx) => {
      await trx(this.table).update({ selected_materia_manual: 0, updated_at: trx.fn.now() });
      const existente = await trx(this.table).where({ provider }).first();
      if (existente) {
        await trx(this.table)
          .where({ provider })
          .update({
            model,
            selected_materia_manual: 1,
            updated_at: trx.fn.now(),
          });
      } else {
        await trx(this.table).insert({
          provider,
          model,
          selected_materia_manual: 1,
        });
      }
    });
    return this.findByProvider(provider);
  },
};

module.exports = AiProviderSettings;
