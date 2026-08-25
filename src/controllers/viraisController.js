const viraisService = require('../services/viraisJmService');
const { defaultPageForUser, defaultPageIdForUser } = require('../services/facebookPageResolver');

async function showPage(req, res, next) {
  try {
    const pagina = await defaultPageForUser(req.session.userId);
    return res.render('virais', {
      title: 'Virais',
      perfil: viraisService.PERFIL_PUBLICO,
      eixos: viraisService.EIXOS,
      paginaPadrao: pagina
        ? { id: Number(pagina.id), nome: pagina.page_name || 'Página do Facebook' }
        : null,
    });
  } catch (err) {
    return next(err);
  }
}

async function pesquisar(req, res, next) {
  try {
    const facebookPageId = await defaultPageIdForUser(req.session.userId);
    if (!facebookPageId) {
      return res.status(400).json({
        error: 'Defina sua página padrão em Páginas antes de pesquisar pautas virais.',
      });
    }
    const resultado = await viraisService.pesquisarPautas({
      userId: req.session.userId,
      facebookPageId,
      eixo: req.body?.eixo || 'all',
      termo: req.body?.termo || req.body?.busca || '',
      periodo: req.body?.periodo || '7d',
      limite: req.body?.limite || 10,
    });
    return res.json({ ok: true, facebookPageId, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function gerar(req, res, next) {
  try {
    const facebookPageId = await defaultPageIdForUser(req.session.userId);
    if (!facebookPageId) {
      return res.status(400).json({
        error: 'Defina sua página padrão em Páginas antes de criar as matérias.',
      });
    }
    const resultado = await viraisService.gerarRascunhos({
      userId: req.session.userId,
      facebookPageId,
      pautas: req.body?.pautas,
      tom: req.body?.tom || 'natural',
      periodo: req.body?.periodo || '7d',
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = { showPage, pesquisar, gerar };
