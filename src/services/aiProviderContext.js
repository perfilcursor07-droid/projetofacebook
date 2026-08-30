const { AsyncLocalStorage } = require('node:async_hooks');
const aiProviderService = require('./aiProviderService');

const storage = new AsyncLocalStorage();

function current() {
  return storage.getStore() || null;
}

async function materiaManual(req, _res, next) {
  try {
    const config = await aiProviderService.getSelected();
    return storage.run(config, next);
  } catch (err) {
    return next(err);
  }
}

module.exports = { current, materiaManual };
