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

  setPostpulseAccount(id, postpulseAccountId) {
    return db(this.table)
      .where({ id })
      .update({
        postpulse_account_id: postpulseAccountId,
        updated_at: db.fn.now(),
      });
  },

  setPostpulseLink(id, { postpulseAccountId, postpulseChatId }) {
    const patch = { updated_at: db.fn.now() };
    if (postpulseAccountId !== undefined) patch.postpulse_account_id = postpulseAccountId;
    if (postpulseChatId !== undefined) patch.postpulse_chat_id = postpulseChatId;
    return db(this.table).where({ id }).update(patch);
  },

  setPostsyncerAccount(id, postsyncerAccountId) {
    return db(this.table)
      .where({ id })
      .update({
        postsyncer_account_id: postsyncerAccountId,
        updated_at: db.fn.now(),
      });
  },

  /** Remove vínculo PostSyncer da página (null = desvinculado). */
  clearPostsyncerAccount(id) {
    return db(this.table)
      .where({ id })
      .update({
        postsyncer_account_id: null,
        updated_at: db.fn.now(),
      });
  },

  /** Liga/desliga a publicação no Instagram do mesmo profile Ayrshare. */
  setInstagram(id, { ativo, username = undefined }) {
    const patch = { instagram_ativo: Boolean(ativo), updated_at: db.fn.now() };
    if (username !== undefined) {
      patch.instagram_username = username ? String(username).slice(0, 190) : null;
    }
    return db(this.table).where({ id }).update(patch);
  },

  /** Liga/desliga a publicação no X.com do mesmo profile Ayrshare. */
  setX(id, { ativo, username = undefined }) {
    const patch = { x_ativo: Boolean(ativo), updated_at: db.fn.now() };
    if (username !== undefined) {
      patch.x_username = username ? String(username).replace(/^@/, '').slice(0, 190) : null;
    }
    return db(this.table).where({ id }).update(patch);
  },

  setAyrshareProfileKey(id, profileKey) {
    const key = profileKey == null || profileKey === '' ? null : String(profileKey).trim();
    return db(this.table)
      .where({ id })
      .update({
        ayrshare_profile_key: key,
        updated_at: db.fn.now(),
      });
  },
};

module.exports = FacebookPages;
