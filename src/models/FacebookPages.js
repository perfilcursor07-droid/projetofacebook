const db = require('../config/db');

const FacebookPages = {
  table: 'facebook_pages',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByAccount(facebookAccountId) {
    return db(this.table)
      .where({ facebook_account_id: facebookAccountId })
      .orderBy('page_name', 'asc');
  },

  upsertMany(rows) {
    return db(this.table)
      .insert(rows)
      .onConflict(['facebook_account_id', 'page_id'])
      .merge(['page_name', 'page_access_token', 'updated_at']);
  },
};

module.exports = FacebookPages;
