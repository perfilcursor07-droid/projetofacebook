const db = require('../config/db');

const BibliotecaPosts = {
  table: 'biblioteca_posts',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByFonte(fonteId, limit = 30) {
    return db(this.table).where({ fonte_id: fonteId }).orderBy('created_at', 'desc').limit(limit);
  },

  countByFonte(fonteId) {
    return db(this.table).where({ fonte_id: fonteId }).count({ total: '*' }).first();
  },

  /** Contagem de posts por fonte_id para um usuário (mapa { [fonteId]: n }). */
  async countsByUser(userId) {
    const rows = await db(this.table)
      .where({ user_id: userId })
      .groupBy('fonte_id')
      .select('fonte_id')
      .count({ total: '*' });
    const map = {};
    for (const r of rows) {
      map[Number(r.fonte_id)] = Number(r.total || 0);
    }
    return map;
  },

  findByUser(userId, { status, limit = 40 } = {}) {
    const q = db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
    if (status) q.andWhere({ status });
    return q;
  },

  /** Candidatos ao piloto: posts ainda sem matéria gerada. */
  findCandidatosAutopilot(userId, limit = 30) {
    return db(`${this.table} as p`)
      .leftJoin('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .where('p.user_id', userId)
      .whereIn('p.status', ['novo', 'visto'])
      .whereNull('p.matter_id')
      .orderBy('p.created_at', 'desc')
      .limit(limit)
      .select(
        'p.id',
        'p.fonte_id',
        'p.titulo',
        'p.url',
        'p.resumo',
        'p.thumbnail',
        'p.status',
        'p.publicado_em',
        'p.created_at',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma'
      );
  },

  findByExternal(fonteId, externalId) {
    return db(this.table).where({ fonte_id: fonteId, external_id: String(externalId) }).first();
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },
};

module.exports = BibliotecaPosts;
