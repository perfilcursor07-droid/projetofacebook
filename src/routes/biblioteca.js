const express = require('express');
const controller = require('../controllers/bibliotecaController');

const router = express.Router();

router.get('/', controller.listar);
router.post('/fontes', controller.criar);
router.patch('/fontes/:id', controller.atualizar);
router.delete('/fontes/:id', controller.remover);
router.post('/fontes/:id/escanear', controller.escanear);
router.get('/fontes/:id/posts', controller.postsDaFonte);
router.post('/posts/:postId/gerar-texto', controller.gerarTexto);
router.post('/posts/:postId/gerar-video', controller.gerarVideo);
router.get('/alertas', controller.listarAlertas);
router.post('/alertas/:id/lido', controller.marcarAlertaLido);
router.post('/alertas/lidos', controller.marcarTodosLidos);

module.exports = router;
