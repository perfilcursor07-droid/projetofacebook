const aiProviderService = require('../services/aiProviderService');

function errorResponse(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

async function list(_req, res, next) {
  try {
    return res.json({ ok: true, ...(await aiProviderService.listPublic()) });
  } catch (err) {
    return errorResponse(err, res, next);
  }
}

async function save(req, res, next) {
  try {
    const provider = await aiProviderService.save(req.params.provider, {
      apiKey: req.body?.apiKey,
      model: req.body?.model,
    });
    return res.json({ ok: true, provider });
  } catch (err) {
    return errorResponse(err, res, next);
  }
}

async function select(req, res, next) {
  try {
    const settings = await aiProviderService.select(req.params.provider, {
      model: req.body?.model,
    });
    return res.json({ ok: true, ...settings });
  } catch (err) {
    return errorResponse(err, res, next);
  }
}

async function test(req, res, next) {
  try {
    const result = await aiProviderService.test(req.params.provider, {
      apiKey: req.body?.apiKey,
      model: req.body?.model,
    });
    return res.json(result);
  } catch (err) {
    return errorResponse(err, res, next);
  }
}

async function removeKey(req, res, next) {
  try {
    const provider = await aiProviderService.removeKey(req.params.provider);
    return res.json({ ok: true, provider });
  } catch (err) {
    return errorResponse(err, res, next);
  }
}

module.exports = { list, save, select, test, removeKey };
