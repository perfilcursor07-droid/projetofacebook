const PautaFontes = require('../models/PautaFontes');
const service = require('../services/pautaFontesService');

async function show(req, res, next) {
  try {
    const fontes = await PautaFontes.findByUser(req.session.userId);
    return res.render('config-descobrir-pautas', {
      title: 'Descobrir pautas',
      fontes,
    });
  } catch (err) {
    return next(err);
  }
}

async function listar(req, res, next) {
  try {
    const fontes = await PautaFontes.findByUser(req.session.userId);
    return res.json({ ok: true, fontes });
  } catch (err) {
    return next(err);
  }
}

async function criar(req, res, next) {
  try {
    const fonte = await service.criarFonte(req.session.userId, req.body || {});
    return res.status(201).json({ ok: true, fonte });
  } catch (err) {
    return next(err);
  }
}

async function atualizar(req, res, next) {
  try {
    const fonte = await service.atualizarFonte(req.session.userId, req.params.id, req.body || {});
    return res.json({ ok: true, fonte });
  } catch (err) {
    return next(err);
  }
}

async function remover(req, res, next) {
  try {
    const removidas = await PautaFontes.deleteForUser(req.params.id, req.session.userId);
    if (!removidas) return res.status(404).json({ error: 'Fonte não encontrada.' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function testar(req, res, next) {
  try {
    const resultado = await service.rastrearFonte(req.body || {});
    return res.json({
      ok: true,
      leitor: resultado.leitor,
      total: resultado.itens.length,
      itens: resultado.itens,
    });
  } catch (err) {
    return next(err);
  }
}

async function escanear(req, res, next) {
  try {
    const resultado = await service.rastrearFonteSalva(req.session.userId, req.params.id);
    return res.json({
      ok: true,
      leitor: resultado.leitor,
      total: resultado.itens.length,
      itens: resultado.itens,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { show, listar, criar, atualizar, remover, testar, escanear };
