const express = require('express');
const controller = require('../controllers/viralizarController');

const router = express.Router();

router.get('/perfil', controller.perfil);
router.post('/curar', controller.curar);
router.post('/gerar', controller.gerar);
router.post('/sincronizar-usados', controller.sincronizarUsados);

module.exports = router;
