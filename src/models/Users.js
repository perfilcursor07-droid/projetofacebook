const db = require('../config/db');

const Users = {
  table: 'users',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByEmail(email) {
    return db(this.table).where({ email }).first();
  },

  create(data) {
    return db(this.table).insert(data);
  },
};

module.exports = Users;
