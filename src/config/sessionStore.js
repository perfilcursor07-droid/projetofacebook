const session = require('express-session');
const db = require('./db');

const TABLE = 'sessions';

/**
 * Store de sessão em MySQL via Knex.
 * Evita logout após pm2 reload (MemoryStore apaga tudo).
 */
class KnexSessionStore extends session.Store {
  constructor() {
    super();
    this._ready = null;
  }

  ensureTable() {
    if (!this._ready) {
      this._ready = (async () => {
        const exists = await db.schema.hasTable(TABLE);
        if (exists) return;
        await db.schema.createTable(TABLE, (t) => {
          t.string('session_id', 191).primary();
          t.text('data').notNullable();
          t.timestamp('expires').notNullable().index();
        });
      })().catch((err) => {
        this._ready = null;
        throw err;
      });
    }
    return this._ready;
  }

  get(sid, callback) {
    this.ensureTable()
      .then(async () => {
        const row = await db(TABLE).where({ session_id: sid }).first();
        if (!row) return callback(null, null);
        if (new Date(row.expires).getTime() <= Date.now()) {
          await db(TABLE).where({ session_id: sid }).del();
          return callback(null, null);
        }
        try {
          return callback(null, JSON.parse(row.data));
        } catch {
          await db(TABLE).where({ session_id: sid }).del();
          return callback(null, null);
        }
      })
      .catch((err) => callback(err));
  }

  set(sid, sess, callback) {
    this.ensureTable()
      .then(async () => {
        const maxAge = Number(sess?.cookie?.maxAge) || 7 * 24 * 60 * 60 * 1000;
        const expires = new Date(Date.now() + maxAge);
        const data = JSON.stringify(sess);
        const existing = await db(TABLE).where({ session_id: sid }).first();
        if (existing) {
          await db(TABLE).where({ session_id: sid }).update({ data, expires });
        } else {
          await db(TABLE).insert({ session_id: sid, data, expires });
        }
        callback(null);
      })
      .catch((err) => callback(err));
  }

  destroy(sid, callback) {
    this.ensureTable()
      .then(async () => {
        await db(TABLE).where({ session_id: sid }).del();
        callback(null);
      })
      .catch((err) => callback(err));
  }

  touch(sid, sess, callback) {
    this.ensureTable()
      .then(async () => {
        const maxAge = Number(sess?.cookie?.maxAge) || 7 * 24 * 60 * 60 * 1000;
        const expires = new Date(Date.now() + maxAge);
        await db(TABLE).where({ session_id: sid }).update({ expires });
        callback(null);
      })
      .catch((err) => callback(err));
  }
}

function createSessionStore() {
  return new KnexSessionStore();
}

module.exports = { createSessionStore, KnexSessionStore };
