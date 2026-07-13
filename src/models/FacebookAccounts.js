const db = require('../config/db');

const FacebookAccounts = {
  table: 'facebook_accounts',

  findByUser(userId) {
    return db(this.table).where({ user_id: userId }).first();
  },

  upsert(data) {
    return db(this.table)
      .insert(data)
      .onConflict(['user_id', 'fb_user_id'])
      .merge(['access_token', 'expires_at', 'updated_at']);
  },
};

module.exports = FacebookAccounts;
