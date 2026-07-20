const db = require('../config/db');

/** VARCHAR(300) em ai_matters.titulo — corta antes do MySQL estourar. */
function prepare(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (out.titulo != null) out.titulo = String(out.titulo).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (out.titulo_ia != null) out.titulo_ia = String(out.titulo_ia).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (out.fonte_titulo != null) {
    out.fonte_titulo = String(out.fonte_titulo).replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  if (out.fonte_credito != null) {
    out.fonte_credito = String(out.fonte_credito).replace(/\r\n/g, '\n').trim().slice(0, 400);
  }
  return out;
}

const AiMatters = {
  table: 'ai_matters',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByUser(userId, limit = 30) {
    return db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
  },

  /**
   * Lista matérias com dados da publicação (views, link FB).
   */
  findByUserWithPub(userId, { limit = 100, q = '' } = {}) {
    let query = db(this.table)
      .leftJoin('publications', 'ai_matters.publication_id', 'publications.id')
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId)
      .select(
        'ai_matters.*',
        'publications.fb_post_id as pub_fb_post_id',
        'publications.fb_post_url as pub_fb_post_url',
        'publications.fb_views as pub_fb_views',
        'publications.fb_views_at as pub_fb_views_at',
        'publications.fb_native_post_id as pub_fb_native_post_id',
        'publications.status as pub_status',
        'facebook_pages.page_name as page_name'
      )
      .orderBy('ai_matters.created_at', 'desc')
      .limit(limit);

    const term = String(q || '').trim();
    if (term) {
      const like = `%${term.replace(/[%_]/g, '')}%`;
      query = query.andWhere(function whereQ() {
        this.where('ai_matters.titulo', 'like', like)
          .orWhere('ai_matters.materia', 'like', like)
          .orWhere('ai_matters.fonte_titulo', 'like', like)
          .orWhere('facebook_pages.page_name', 'like', like);
      });
    }

    return query;
  },

  create(data) {
    return db(this.table).insert(prepare(data));
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...prepare(data), updated_at: db.fn.now() });
  },

  delete(id) {
    return db(this.table).where({ id }).del();
  },

  deleteByUser(id, userId) {
    return db(this.table).where({ id, user_id: userId }).del();
  },
};

module.exports = AiMatters;
