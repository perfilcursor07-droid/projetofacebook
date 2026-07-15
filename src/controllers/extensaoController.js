const db = require('../config/db');
const ApiTokens = require('../models/ApiTokens');

async function show(req, res, next) {
  try {
    const userId = req.session.userId;
    const tokens = await ApiTokens.listByUser(userId);

    const pages = await db('facebook_pages')
      .join('facebook_accounts', 'facebook_pages.facebook_account_id', 'facebook_accounts.id')
      .where('facebook_accounts.user_id', userId)
      .orderBy('facebook_pages.page_name', 'asc')
      .select('facebook_pages.id', 'facebook_pages.page_id', 'facebook_pages.page_name');

    const matters = await db('ai_matters')
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .where('ai_matters.user_id', userId)
      .whereIn('ai_matters.status', ['rascunho', 'pronto', 'agendado', 'erro'])
      .orderByRaw(
        "FIELD(ai_matters.status, 'pronto', 'agendado', 'erro', 'rascunho'), ai_matters.updated_at DESC"
      )
      .limit(80)
      .select(
        'ai_matters.id',
        'ai_matters.titulo',
        'ai_matters.materia',
        'ai_matters.status',
        'ai_matters.tipo_publicacao',
        'ai_matters.imagem_url',
        'ai_matters.facebook_page_id',
        'ai_matters.updated_at',
        'facebook_pages.page_name'
      );

    const naFila = matters.filter((m) => m.status === 'pronto' || m.status === 'agendado').length;

    return res.render('extensao', {
      title: 'Extensão de Publicação',
      tokens,
      pages,
      matters,
      naFila,
      success: req.query.success || null,
      error: req.query.error || null,
      apiBase: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { show };
