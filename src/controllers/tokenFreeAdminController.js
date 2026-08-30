const tokenFreeAdminService = require('../services/tokenFreeAdminService');

async function index(_req, res, next) {
  try {
    const initialStatus = await tokenFreeAdminService.status();
    return res.render('claude-gateway', {
      title: 'Sessão do Claude',
      initialStatus,
    });
  } catch (err) {
    return next(err);
  }
}

async function status(_req, res, next) {
  try {
    return res.json({ ok: true, ...(await tokenFreeAdminService.status()) });
  } catch (err) {
    return next(err);
  }
}

async function iniciar(_req, res, next) {
  try {
    return res.json(await tokenFreeAdminService.iniciar());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function reiniciar(_req, res, next) {
  try {
    return res.json(await tokenFreeAdminService.reiniciar());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function autorizar(req, res, next) {
  try {
    const trocarConta = req.body?.trocarConta === true || req.body?.trocarConta === 'true';
    return res.status(202).json({
      ok: true,
      autorizacao: tokenFreeAdminService.iniciarAutorizacao({ trocarConta }),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function continuarAutorizacao(_req, res, next) {
  try {
    return res.json({
      ok: true,
      autorizacao: tokenFreeAdminService.continuarAutorizacao(),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function testar(_req, res, next) {
  try {
    return res.json(await tokenFreeAdminService.testar());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = {
  index,
  status,
  iniciar,
  reiniciar,
  autorizar,
  continuarAutorizacao,
  testar,
};
