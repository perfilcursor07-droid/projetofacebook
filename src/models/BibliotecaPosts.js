const db = require('../config/db');

const BibliotecaPosts = {
  table: 'biblioteca_posts',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  findByFonte(fonteId, limit = 30) {
    return db(this.table)
      .where({ fonte_id: fonteId })
      .orderByRaw('COALESCE(publicado_em, created_at) DESC')
      .orderBy('id', 'desc')
      .limit(limit);
  },

  countByFonte(fonteId) {
    return db(this.table).where({ fonte_id: fonteId }).count({ total: '*' }).first();
  },

  /** Contagem de posts por fonte_id para um usuário (mapa { [fonteId]: n }). */
  async countsByUser(userId) {
    const rows = await db(this.table)
      .where({ user_id: userId })
      .groupBy('fonte_id')
      .select('fonte_id')
      .count({ total: '*' });
    const map = {};
    for (const r of rows) {
      map[Number(r.fonte_id)] = Number(r.total || 0);
    }
    return map;
  },

  findByUser(userId, { status, limit = 40 } = {}) {
    const q = db(this.table).where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
    if (status) q.andWhere({ status });
    return q;
  },

  /** Candidatos ao piloto/análise: posts ainda sem matéria, com diversidade entre fontes. */
  async findCandidatosAutopilot(userId, limit = 30) {
    const alvo = Math.min(40, Math.max(1, Number(limit) || 30));
    const pool = await db(`${this.table} as p`)
      .leftJoin('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .where('p.user_id', userId)
      .whereIn('p.status', ['novo', 'visto'])
      .whereNull('p.matter_id')
      .orderBy('p.created_at', 'desc')
      .limit(Math.max(alvo * 4, 60))
      .select(
        'p.id',
        'p.fonte_id',
        'p.titulo',
        'p.url',
        'p.resumo',
        'p.thumbnail',
        'p.media_type',
        'p.status',
        'p.publicado_em',
        'p.created_at',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma'
      );

    // Round-robin por fonte para não mandar só 1 site à IA
    const porFonte = new Map();
    for (const post of pool) {
      const key = String(post.fonte_id || 'x');
      if (!porFonte.has(key)) porFonte.set(key, []);
      porFonte.get(key).push(post);
    }
    const filas = [...porFonte.values()];
    const diversificados = [];
    let i = 0;
    while (diversificados.length < alvo && filas.some((f) => f.length)) {
      const fila = filas[i % filas.length];
      if (fila.length) diversificados.push(fila.shift());
      i += 1;
    }
    return diversificados;
  },

  clearViralRanking(userId) {
    return db(this.table)
      .where({ user_id: userId })
      .whereIn('status', ['novo', 'visto'])
      .whereNull('matter_id')
      .update({
        viral_score: null,
        viral_reason: null,
        viral_analyzed_at: null,
        updated_at: db.fn.now(),
      });
  },

  /** Remove um item da lista “Melhores para publicar” (só o ranking, não apaga o post). */
  clearViralRankingPost(userId, postId) {
    return db(this.table)
      .where({ id: postId, user_id: userId })
      .update({
        viral_score: null,
        viral_reason: null,
        viral_analyzed_at: null,
        updated_at: db.fn.now(),
      });
  },

  saveViralRanking(id, { score, reason, analyzedAt = new Date(), tituloPt = null }) {
    const patch = {
      viral_score: Math.min(100, Math.max(0, Number(score) || 0)),
      viral_reason: String(reason || '').slice(0, 500) || null,
      viral_analyzed_at: analyzedAt,
      updated_at: db.fn.now(),
    };
    if (tituloPt) {
      patch.titulo = String(tituloPt).replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    return db(this.table).where({ id }).update(patch);
  },

  findMelhoresPublicacao(userId, limit = 30, minScore = 50) {
    const scoreMinimo = Math.min(100, Math.max(0, Number(minScore) || 50));
    return db(`${this.table} as p`)
      .leftJoin('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .where('p.user_id', userId)
      .whereIn('p.status', ['novo', 'visto'])
      .whereNull('p.matter_id')
      .where('p.viral_score', '>=', scoreMinimo)
      .orderBy('p.viral_score', 'desc')
      .orderBy('p.viral_analyzed_at', 'desc')
      .limit(Math.min(30, Math.max(1, Number(limit) || 30)))
      .select(
        'p.id',
        'p.fonte_id',
        'p.titulo',
        'p.url',
        'p.resumo',
        'p.thumbnail',
        'p.media_type',
        'p.viral_score',
        'p.viral_reason',
        'p.viral_analyzed_at',
        'p.publicado_em',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma'
      );
  },

  findByExternal(fonteId, externalId) {
    return db(this.table).where({ fonte_id: fonteId, external_id: String(externalId) }).first();
  },

  create(data) {
    return db(this.table).insert(data);
  },

  update(id, data) {
    return db(this.table).where({ id }).update({ ...data, updated_at: db.fn.now() });
  },
};

module.exports = BibliotecaPosts;
