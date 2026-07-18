const db = require('../config/db');

const BibliotecaAlertas = {
  table: 'biblioteca_alertas',

  findByUser(userId, { apenasNaoLidos = false, limit = 40 } = {}) {
    // Só alertas de fontes que ainda existem (some junto com a exclusão)
    const q = db(`${this.table} as a`)
      .innerJoin('biblioteca_fontes as f', 'f.id', 'a.fonte_id')
      .where('a.user_id', userId)
      .orderBy('a.created_at', 'desc')
      .limit(limit)
      .select(
        'a.*',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma',
        'f.url as fonte_url'
      );
    if (apenasNaoLidos) q.andWhere('a.lido', false);
    return q;
  },

  countNaoLidos(userId) {
    return db(`${this.table} as a`)
      .innerJoin('biblioteca_fontes as f', 'f.id', 'a.fonte_id')
      .where('a.user_id', userId)
      .andWhere('a.lido', false)
      .count({ total: '*' })
      .first();
  },

  /** Remove alertas cuja fonte já foi apagada (lixo órfão). */
  limparOrfaos(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .where(function orphan() {
        this.whereNull('fonte_id').orWhereNotExists(function () {
          this.select(db.raw('1'))
            .from('biblioteca_fontes as f')
            .whereRaw('f.id = biblioteca_alertas.fonte_id');
        });
      })
      .del();
  },

  create(data) {
    return db(this.table).insert(data);
  },

  marcarLido(id, userId) {
    return db(this.table).where({ id, user_id: userId }).update({ lido: true, updated_at: db.fn.now() });
  },

  marcarTodosLidos(userId) {
    return db(this.table).where({ user_id: userId, lido: false }).update({ lido: true, updated_at: db.fn.now() });
  },
};

module.exports = BibliotecaAlertas;
