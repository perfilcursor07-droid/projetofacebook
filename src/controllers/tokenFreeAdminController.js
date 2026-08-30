const tokenFreeAdminService = require('../services/tokenFreeAdminService');

async function index(_req, res, next) {
  try {
    const [initialStatus, initialProviders] = await Promise.all([
      tokenFreeAdminService.status(),
      require('../services/aiProviderService').listPublic(),
    ]);
    return res.render('claude-gateway', {
      title: 'Provedores de IA',
      initialStatus,
      initialProviders,
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
    const provider = String(req.body?.provider || 'claude').trim().toLowerCase();
    return res.status(202).json({
      ok: true,
      autorizacao: tokenFreeAdminService.iniciarAutorizacao({ provider, trocarConta }),
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

async function testar(req, res, next) {
  try {
    return res.json(await tokenFreeAdminService.testar({
      provider: String(req.body?.provider || 'claude').trim().toLowerCase(),
      model: req.body?.model || null,
    }));
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
