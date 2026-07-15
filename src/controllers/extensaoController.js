const ApiTokens = require('../models/ApiTokens');

async function show(req, res, next) {
  try {
    const tokens = await ApiTokens.listByUser(req.session.userId);
    return res.render('extensao', {
      title: 'Extensão de Publicação',
      tokens,
      success: req.query.success || null,
      error: req.query.error || null,
      apiBase: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { show };
