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

/**
 * Critério da aba "Viralizou": posts com Bom OU Viralizou
 * (score >= 80 OU likes >= 40 OU comments >= 10).
 * Antes só entrava o nível "alto" (muito restrito) e posts sem engajamento
 * sincronizado no banco ficavam de fora.
 */
function applyViralizouFilter(query) {
  return query.where(function viralWhere() {
    this.whereRaw(
      `(COALESCE(publications.fb_likes, 0) + COALESCE(publications.fb_comments, 0) * 3 + COALESCE(publications.fb_shares, 0) * 5 + LEAST(COALESCE(publications.fb_views, 0), 5000) / 50) >= 80`
    )
      .orWhere('publications.fb_likes', '>=', 40)
      .orWhere('publications.fb_comments', '>=', 10);
  });
}

function applySearchFilter(query, q) {
  const term = String(q || '').trim();
  if (!term) return query;
  const like = `%${term.replace(/[%_]/g, '')}%`;
  return query.andWhere(function whereQ() {
    this.where('ai_matters.titulo', 'like', like)
      .orWhere('ai_matters.materia', 'like', like)
      .orWhere('ai_matters.fonte_titulo', 'like', like)
      .orWhere('facebook_pages.page_name', 'like', like);
  });
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
   * @param {object} opts
   * @param {string|null} [opts.status] status da matéria, ou 'viralizou'
   */
  findByUserWithPub(userId, { limit = 100, offset = 0, q = '', status = null } = {}) {
    const st = String(status || '').trim().toLowerCase();
    const viralFilter = st === 'viralizou';

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
        'publications.fb_likes as pub_fb_likes',
        'publications.fb_comments as pub_fb_comments',
        'publications.fb_shares as pub_fb_shares',
        'publications.fb_native_post_id as pub_fb_native_post_id',
        'publications.status as pub_status',
        'publications.published_at as pub_published_at',
        'facebook_pages.page_name as page_name'
      )
      .orderBy('ai_matters.created_at', 'desc')
      .limit(Math.max(1, Math.min(100, Number(limit) || 20)))
      .offset(Math.max(0, Number(offset) || 0));

    if (viralFilter) {
      query = applyViralizouFilter(query);
    } else if (st && st !== 'all') {
      query = query.andWhere('ai_matters.status', st);
    }

    query = applySearchFilter(query, q);
    return query;
  },

  async countByUserWithPub(userId, { q = '', status = null } = {}) {
    const st = String(status || '').trim().toLowerCase();
    const viralFilter = st === 'viralizou';

    let query = db(this.table)
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId);

    if (viralFilter) {
      query = query.leftJoin('publications', 'ai_matters.publication_id', 'publications.id');
      query = applyViralizouFilter(query);
    } else if (st && st !== 'all') {
      query = query.andWhere('ai_matters.status', st);
    }

    query = applySearchFilter(query, q);

    const row = await query.count({ total: '*' }).first();
    return Number(row?.total) || 0;
  },

  async countByStatusForUser(userId, { q = '' } = {}) {
    let query = db(this.table)
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId);

    query = applySearchFilter(query, q);

    const rows = await query
      .select('ai_matters.status')
      .count('* as total')
      .groupBy('ai_matters.status');

    const out = {};
    let all = 0;
    for (const row of rows || []) {
      const key = row.status || 'rascunho';
      const n = Number(row.total) || 0;
      out[key] = n;
      all += n;
    }
    out.all = all;

    // Contagem da aba Viralizou (critério de engajamento, não status)
    let viralQuery = db(this.table)
      .leftJoin('publications', 'ai_matters.publication_id', 'publications.id')
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId);
    viralQuery = applySearchFilter(viralQuery, q);
    viralQuery = applyViralizouFilter(viralQuery);
    const viralRow = await viralQuery.count({ total: '*' }).first();
    out.viralizou = Number(viralRow?.total) || 0;

    return out;
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

  /** Publicadas recentes (com publication_id) para sincronizar engajamento. */
  findRecentPublishedForSync(userId, limit = 30) {
    return db(this.table)
      .where('user_id', userId)
      .whereNotNull('publication_id')
      .where(function statusPub() {
        this.where('status', 'publicado').orWhereNotNull('published_at');
      })
      .orderByRaw('COALESCE(published_at, updated_at, created_at) DESC')
      .limit(Math.max(1, Math.min(60, Number(limit) || 30)))
      .select('id', 'publication_id', 'titulo', 'status');
  },
};

module.exports = AiMatters;
