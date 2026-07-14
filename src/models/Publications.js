const db = require('../config/db');

const Publications = {
  table: 'publications',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  /** Publicações recentes do usuário, de todos os tipos (reel, video, foto, texto). */
  recent(userId, limit = 20) {
    return db(this.table)
      .join('facebook_pages', 'publications.facebook_page_id', 'facebook_pages.id')
      .join('facebook_accounts', 'facebook_pages.facebook_account_id', 'facebook_accounts.id')
      .leftJoin('video_clips', 'publications.video_clip_id', 'video_clips.id')
      .leftJoin('videos', 'video_clips.video_id', 'videos.id')
      .leftJoin('imagens', 'publications.imagem_id', 'imagens.id')
      .where('facebook_accounts.user_id', userId)
      .select(
        'publications.*',
        'facebook_pages.page_name',
        'videos.thumbnail as video_thumbnail',
        'videos.termo_busca as video_termo',
        'video_clips.legenda_sugerida',
        'imagens.thumbnail as imagem_thumbnail'
      )
      .orderBy('publications.created_at', 'desc')
      .limit(limit);
  },

  /** Reels publicados (ou na fila) pela página nas últimas 24h — limite da API é 30. */
  async countReelsLast24h(facebookPageId) {
    const [{ total }] = await db(this.table)
      .where({ facebook_page_id: facebookPageId, tipo: 'reel' })
      .whereIn('status', ['pendente', 'publicado'])
      .where('created_at', '>=', db.raw('NOW() - INTERVAL 1 DAY'))
      .count({ total: '*' });
    return Number(total);
  },

  countByStatus(userId) {
    return db(this.table)
      .join('facebook_pages', 'publications.facebook_page_id', 'facebook_pages.id')
      .join('facebook_accounts', 'facebook_pages.facebook_account_id', 'facebook_accounts.id')
      .where('facebook_accounts.user_id', userId)
      .select('publications.status')
      .count('* as total')
      .groupBy('publications.status');
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update(data);
  },

  increment(id) {
    return db(this.table).where({ id }).increment('tentativas', 1);
  },
};

module.exports = Publications;
