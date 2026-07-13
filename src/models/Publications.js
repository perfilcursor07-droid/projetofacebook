const db = require('../config/db');

const Publications = {
  table: 'publications',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  recent(userId, limit = 20) {
    return db(this.table)
      .join('video_clips', 'publications.video_clip_id', 'video_clips.id')
      .join('videos', 'video_clips.video_id', 'videos.id')
      .join('facebook_pages', 'publications.facebook_page_id', 'facebook_pages.id')
      .where('videos.user_id', userId)
      .select(
        'publications.*',
        'videos.thumbnail',
        'videos.termo_busca',
        'facebook_pages.page_name',
        'video_clips.legenda_sugerida'
      )
      .orderBy('publications.created_at', 'desc')
      .limit(limit);
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
