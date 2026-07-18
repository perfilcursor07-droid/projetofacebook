const db = require('../config/db');

const BibliotecaFontes = {
  table: 'biblioteca_fontes',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc');
  },

  findDue() {
    return db(this.table)
      .where({ monitorar: true })
      .andWhere((qb) => {
        qb.whereNull('proxima_execucao').orWhere('proxima_execucao', '<=', db.fn.now());
      });
  },

  findPendingScrapes(limit = 20) {
    return db(this.table)
      .where({ plataforma: 'instagram' })
      .whereIn('scrape_status', ['triggering', 'pending'])
      .orderBy('scrape_requested_at', 'asc')
      .limit(Math.min(100, Math.max(1, Number(limit) || 20)));
  },

  tryStartScrape(id, { silentFirst = false } = {}) {
    return db(this.table)
      .where({ id })
      .andWhere((qb) => {
        qb.whereNull('scrape_status').orWhereNotIn('scrape_status', ['triggering', 'pending']);
      })
      .update({
        scrape_snapshot_id: null,
        scrape_status: 'triggering',
        scrape_requested_at: db.fn.now(),
        scrape_error: null,
        scrape_silent_first: Boolean(silentFirst),
        updated_at: db.fn.now(),
      });
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },

  async deleteByUser(id, userId) {
    const fonteId = Number(id);
    const uid = Number(userId);
    const fonte = await db(this.table).where({ id: fonteId, user_id: uid }).first();
    if (!fonte) return 0;

    return db.transaction(async (trx) => {
      // Explícito: no WAMP o FK CASCADE às vezes não remove alertas/posts
      await trx('biblioteca_alertas').where({ fonte_id: fonteId }).del();
      await trx('biblioteca_posts').where({ fonte_id: fonteId }).del();
      return trx(this.table).where({ id: fonteId, user_id: uid }).del();
    });
  },
};

module.exports = BibliotecaFontes;
