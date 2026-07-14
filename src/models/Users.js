const db = require('../config/db');

const Users = {
  table: 'users',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByEmail(email) {
    return db(this.table).where({ email }).first();
  },

  list() {
    return db(this.table)
      .select('id', 'nome', 'email', 'nivel_acesso', 'logo_path', 'created_at', 'updated_at')
      .orderBy('nome', 'asc');
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },

  remove(id) {
    return db(this.table).where({ id }).del();
  },

  countByAccess(nivelAcesso) {
    return db(this.table).where({ nivel_acesso: nivelAcesso }).count({ total: '*' }).first();
  },
};

module.exports = Users;
