const db = require('../config/db');

const AiFilaJobs = {
  table: 'ai_fila_jobs',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findDue(limit = 10) {
    // Compara com o relógio do Node (UTC) — evita divergência com NOW() do MySQL
    return db(this.table)
      .where({ status: 'pendente' })
      .andWhere('run_at', '<=', new Date())
      .orderBy('run_at', 'asc')
      .limit(limit);
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },
};

module.exports = AiFilaJobs;
