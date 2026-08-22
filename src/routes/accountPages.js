const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { loadCurrentUser, requireAdmin } = require('../middleware/accessControl');
const { uploadLogo } = require('../middleware/uploadLogo');
const profileController = require('../controllers/profileController');
const usersController = require('../controllers/usersController');
const tokenFreeAdminController = require('../controllers/tokenFreeAdminController');

const router = express.Router();

// Este router também atualiza res.locals.user para o sidebar das demais páginas.
router.use(loadCurrentUser);
router.use('/api/materias-ia', require('./editorialMatters'));

router.get('/minha-marca', requireAuth, profileController.show);
router.get('/minha-marca/preview/:model.png', requireAuth, profileController.artModelPreview);
router.post('/minha-marca/modelo-config', requireAuth, profileController.saveModelConfig);
router.post('/minha-marca', requireAuth, (req, res, next) => {
  uploadLogo(req, res, (err) => {
    if (err) return res.redirect(`/minha-marca?error=${encodeURIComponent(err.message)}`);
    return profileController.update(req, res, next);
  });
});

router.get('/usuarios', requireAuth, requireAdmin, usersController.index);
router.post('/usuarios', requireAuth, requireAdmin, usersController.create);
router.post('/usuarios/:id/nivel', requireAuth, requireAdmin, usersController.updateAccess);
router.post('/usuarios/:id/senha', requireAuth, requireAdmin, usersController.resetPassword);
router.post('/usuarios/:id/remover', requireAuth, requireAdmin, usersController.remove);

const midiasController = require('../controllers/midiasController');
router.get('/midias', requireAuth, requireAdmin, midiasController.index);

router.get('/claude', requireAuth, requireAdmin, tokenFreeAdminController.index);
router.get('/api/admin/claude-gateway/status', requireAuth, requireAdmin, tokenFreeAdminController.status);
router.post('/api/admin/claude-gateway/start', requireAuth, requireAdmin, tokenFreeAdminController.iniciar);
router.post('/api/admin/claude-gateway/restart', requireAuth, requireAdmin, tokenFreeAdminController.reiniciar);
router.post('/api/admin/claude-gateway/authorize', requireAuth, requireAdmin, tokenFreeAdminController.autorizar);
router.post('/api/admin/claude-gateway/authorize/continue', requireAuth, requireAdmin, tokenFreeAdminController.continuarAutorizacao);
router.post('/api/admin/claude-gateway/import', requireAuth, requireAdmin, tokenFreeAdminController.importarSessao);
router.post('/api/admin/claude-gateway/test', requireAuth, requireAdmin, tokenFreeAdminController.testar);

module.exports = router;
