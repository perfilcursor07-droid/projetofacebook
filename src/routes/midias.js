const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { loadCurrentUser, requireAdmin } = require('../middleware/accessControl');
const midiasController = require('../controllers/midiasController');

const router = express.Router();

router.use(loadCurrentUser);
router.use(requireAuth, requireAdmin);

router.get('/', midiasController.listar);
router.get('/pastas', midiasController.pastas);
router.delete('/', midiasController.remover);
router.post('/apagar', midiasController.remover);

module.exports = router;
