const express = require('express');
const controller = require('../controllers/gruposController');

const router = express.Router();

router.get('/', controller.listar);
router.post('/', controller.criar);
router.patch('/:id', controller.atualizar);
router.put('/:id', controller.atualizar);
router.delete('/:id', controller.remover);
router.post('/publicar', controller.publicar);

module.exports = router;
