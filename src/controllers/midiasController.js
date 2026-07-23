const midiasStorageService = require('../services/midiasStorageService');

async function index(req, res, next) {
  try {
    const pastas = await midiasStorageService.listarPastas();
    const totalBytes = pastas.reduce((s, p) => s + (p.bytes || 0), 0);
    return res.render('midias', {
      title: 'Mídias no servidor',
      pastas,
      totalBytes,
      totalSizeLabel: midiasStorageService.formatBytes(totalBytes),
      pastasJson: JSON.stringify(midiasStorageService.PASTAS_PERMITIDAS),
    });
  } catch (err) {
    return next(err);
  }
}

async function listar(req, res, next) {
  try {
    const data = await midiasStorageService.listarArquivos({
      folder: req.query.folder || req.query.pasta,
      q: req.query.q || req.query.busca,
      tipo: req.query.tipo,
      limit: req.query.limit,
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function pastas(req, res, next) {
  try {
    const list = await midiasStorageService.listarPastas();
    res.json({
      ok: true,
      pastas: list,
      totalBytes: list.reduce((s, p) => s + (p.bytes || 0), 0),
      sizeLabel: midiasStorageService.formatBytes(list.reduce((s, p) => s + (p.bytes || 0), 0)),
    });
  } catch (err) {
    next(err);
  }
}

async function remover(req, res, next) {
  try {
    const body = req.body || {};
    if (Array.isArray(body.paths) || Array.isArray(body.arquivos)) {
      const result = await midiasStorageService.apagarVarios(body.paths || body.arquivos);
      return res.json({ ok: true, ...result });
    }
    const filePath = body.path || body.caminho || req.query.path;
    const result = await midiasStorageService.apagarArquivo(filePath);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = {
  index,
  listar,
  pastas,
  remover,
};
