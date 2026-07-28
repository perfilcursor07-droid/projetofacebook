const db = require('../config/db');

const BibliotecaAgenda = {
  table: 'biblioteca_agenda',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId, { status = null, limit = 100 } = {}) {
    const q = db(`${this.table} as a`)
      .leftJoin('biblioteca_posts as p', 'p.id', 'a.post_id')
      .leftJoin('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .leftJoin('ai_matters as m', 'm.id', 'a.matter_id')
      .where('a.user_id', userId)
      .orderBy('a.proposed_at', 'asc')
      .limit(Math.min(200, Math.max(1, Number(limit) || 100)))
      .select(
        'a.id',
        'a.user_id',
        'a.facebook_page_id',
        'a.post_id',
        'a.matter_id',
        'a.proposed_at',
        'a.status',
        'a.created_at',
        'a.updated_at',
        'p.titulo as post_titulo',
        'p.url as post_url',
        'p.thumbnail as post_thumbnail',
        'p.resumo as post_resumo',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma',
        'm.titulo as matter_titulo',
        'm.status as matter_status',
        'm.imagem_path as matter_imagem_path',
        'm.imagem_url as matter_imagem_url',
        'm.scheduled_at as matter_scheduled_at',
        'm.tipo_publicacao as matter_tipo'
      );

    if (status && status !== 'all') {
      q.andWhere('a.status', status);
    } else {
      q.whereNot('a.status', 'cancelado');
    }
    return q;
  },

  findActivePostIds(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .whereNotIn('status', ['cancelado'])
      .pluck('post_id');
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },

  updateMany(ids, userId, data) {
    return db(this.table)
      .whereIn('id', ids)
      .andWhere({ user_id: userId })
      .update({ ...data, updated_at: db.fn.now() });
  },

  deleteById(id, userId) {
    return db(this.table).where({ id, user_id: userId }).del();
  },
};

module.exports = BibliotecaAgenda;
