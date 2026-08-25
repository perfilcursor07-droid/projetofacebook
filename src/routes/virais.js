const express = require('express');
const controller = require('../controllers/viraisController');

const router = express.Router();

router.post('/pesquisar', controller.pesquisar);
router.post('/pesquisar/iniciar', controller.iniciarPesquisa);
router.get('/pesquisar/:jobId', controller.statusPesquisa);
router.post('/gerar', controller.gerar);

module.exports = router;
