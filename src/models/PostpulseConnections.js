const db = require('../config/db');

const PostpulseConnections = {
  table: 'postpulse_connections',

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).first();
  },

  upsert({ user_id, access_token, refresh_token, expires_at }) {
    return db(this.table)
      .insert({
        user_id,
        access_token,
        refresh_token: refresh_token || null,
        expires_at: expires_at || null,
      })
      .onConflict('user_id')
      .merge(['access_token', 'refresh_token', 'expires_at', 'updated_at']);
  },

  deleteByUser(userId) {
    return db(this.table).where({ user_id: userId }).del();
  },
};

module.exports = PostpulseConnections;
