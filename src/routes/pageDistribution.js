const router = require('express').Router();
const service = require('../services/pageDistributionService');
const upload = require('multer')({ storage: require('multer').memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    const err = new Error('Logo inválida. Envie PNG, JPG ou WebP.'); err.status = 400; cb(err);
  },
}).single('logo');
const handle = (fn, code = 200) => async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.status(code).json({ ok: true, ...await fn(req) });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Atualize o banco com npm run migrate para ativar as versões por página.' });
    }
    next(err);
  }
};
router.get('/settings', handle((r) => service.settings(r.session.userId)));
router.put('/settings', handle((r) => service.saveSettings(r.session.userId, r.body)));
router.put('/brands/:pageId', upload, handle((r) => service.saveBrand(
  r.session.userId, Number(r.params.pageId), r.body.config ? JSON.parse(r.body.config) : r.body, r.file)));
router.get('/matters/:id', handle((r) => service.status(r.session.userId, Number(r.params.id))));
router.post('/matters/:id/prepare', handle((r) => service.prepare(r.session.userId, Number(r.params.id)), 202));
router.post('/matters/:id/publish', handle((r) => service.publish(r.session.userId, Number(r.params.id)), 202));
router.post('/matters/:id/items/:itemId/retry', handle((r) => service.retry(
  r.session.userId, Number(r.params.id), Number(r.params.itemId), r.body.confirmedNotPublished)));
module.exports = router;
