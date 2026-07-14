const db = require('../config/db');

const VideoClips = {
  table: 'video_clips',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByVideo(videoId) {
    return db(this.table).where({ video_id: videoId }).orderBy('inicio_segundo', 'asc');
  },

  findByVideoIds(videoIds) {
    return db(this.table).whereIn('video_id', videoIds).orderBy([
      { column: 'video_id', order: 'asc' },
      { column: 'inicio_segundo', order: 'asc' },
      { column: 'id', order: 'asc' },
    ]);
  },

  create(data) {
    return db(this.table).insert(data);
  },

  createMany(rows) {
    return db(this.table).insert(rows);
  },

  update(id, data) {
    return db(this.table).where({ id }).update(data);
  },

  remove(id) {
    return db(this.table).where({ id }).del();
  },

  countByStatusForUser(userId) {
    return db(this.table)
      .join('videos', 'video_clips.video_id', 'videos.id')
      .where('videos.user_id', userId)
      .select('video_clips.status')
      .count('* as total')
      .groupBy('video_clips.status');
  },

  countForUser(userId) {
    return db(this.table)
      .join('videos', 'video_clips.video_id', 'videos.id')
      .where('videos.user_id', userId)
      .count({ total: '*' })
      .first();
  },
};

module.exports = VideoClips;
