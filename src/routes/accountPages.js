const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { loadCurrentUser, requireAdmin } = require('../middleware/accessControl');
const { uploadLogo } = require('../middleware/uploadLogo');
const profileController = require('../controllers/profileController');
const usersController = require('../controllers/usersController');

const router = express.Router();

// Este router também atualiza res.locals.user para o sidebar das demais páginas.
router.use(loadCurrentUser);
router.use('/api/materias-ia', require('./editorialMatters'));

router.get('/minha-marca', requireAuth, profileController.show);
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

module.exports = router;
