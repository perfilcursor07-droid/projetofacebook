const db = require('../config/db');

const BibliotecaAgenda = {
  table: 'biblioteca_agenda',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId, { status = null, statuses = null, limit = 100, order = 'asc' } = {}) {
    const q = db(`${this.table} as a`)
      .leftJoin('biblioteca_posts as p', 'p.id', 'a.post_id')
      .leftJoin('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .leftJoin('ai_matters as m', 'm.id', 'a.matter_id')
      .leftJoin('ai_matters as sm', 'sm.id', 'a.source_matter_id')
      .leftJoin('facebook_pages as smp', 'smp.id', 'sm.facebook_page_id')
      .where('a.user_id', userId)
      .orderBy('a.proposed_at', order === 'desc' ? 'desc' : 'asc')
      .limit(Math.min(200, Math.max(1, Number(limit) || 100)))
      .select(
        'a.id',
        'a.user_id',
        'a.facebook_page_id',
        'a.post_id',
        'a.matter_id',
        'a.source_matter_id',
        'a.proposed_at',
        'a.status',
        'a.matched_keyword',
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
        'm.published_at as matter_published_at',
        'm.tipo_publicacao as matter_tipo',
        'sm.titulo as source_matter_titulo',
        'smp.page_name as source_page_name'
      );

    if (Array.isArray(statuses) && statuses.length) {
      q.whereIn('a.status', statuses);
    } else if (status && status !== 'all') {
      q.andWhere('a.status', status);
    } else {
      q.whereNot('a.status', 'cancelado');
    }
    return q;
  },

  async countByStatus(userId) {
    const rows = await db(this.table)
      .where({ user_id: userId })
      .whereNot('status', 'cancelado')
      .groupBy('status')
      .select('status')
      .count('* as total');
    const out = { pendente: 0, confirmado: 0, publicado: 0, agendada: 0, publicadas: 0 };
    for (const r of rows || []) {
      const n = Number(r.total) || 0;
      const st = String(r.status || '');
      if (st in out) out[st] = n;
    }
    out.agendada = out.pendente + out.confirmado;
    out.publicadas = out.publicado;
    return out;
  },

  findActivePostIds(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .whereNotIn('status', ['cancelado'])
      .whereNotNull('post_id')
      .pluck('post_id');
  },

  /** IDs de matérias originais já usadas como fonte viral (agenda ativa). */
  findActiveSourceMatterIds(userId, facebookPageId = null) {
    const q = db(this.table)
      .where({ user_id: userId })
      .whereNotIn('status', ['cancelado'])
      .whereNotNull('source_matter_id');
    if (facebookPageId) q.andWhere({ facebook_page_id: Number(facebookPageId) });
    return q.pluck('source_matter_id');
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
