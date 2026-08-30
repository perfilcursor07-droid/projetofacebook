const { AsyncLocalStorage } = require('node:async_hooks');
const aiProviderService = require('./aiProviderService');

const storage = new AsyncLocalStorage();

function current() {
  return storage.getStore() || null;
}

async function materiaManual(req, _res, next) {
  try {
    const requested = req.user?.nivel_acesso === 'administrador' ? req.body?.modeloIa : null;
    const config = await aiProviderService.getForManual({
      provider: requested?.provider,
      model: requested?.model,
    });
    return storage.run(config, next);
  } catch (err) {
    return next(err);
  }
}

module.exports = { current, materiaManual };
