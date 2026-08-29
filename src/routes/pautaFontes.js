const express = require('express');
const controller = require('../controllers/pautaFontesController');

const router = express.Router();

router.get('/', controller.listar);
router.post('/', controller.criar);
router.post('/testar', controller.testar);
router.patch('/:id', controller.atualizar);
router.delete('/:id', controller.remover);
router.post('/:id/escanear', controller.escanear);

module.exports = router;
